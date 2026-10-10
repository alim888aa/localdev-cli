#!/usr/bin/env node
// Daily dollar meter for one project: how much API-list-price money the agents
// working on it spent today, read from the local Claude Code and Codex session
// logs. dispatch-plan.mjs imports spentToday() to hold a project to its
// budgetUsd.
//
//   node usage.mjs --root /path/to/main/checkout [--date YYYY-MM-DD]
//
// Prints { usd, byModel, unpriced, sessions } as JSON. "Today" is the local
// calendar day (--date picks another one). A log entry belongs to the project
// when its cwd is the root, inside it, or inside ~/.t3/worktrees/<root name>/.
// Paths are compared by their real location (symlinks followed), so /tmp/repo
// and /private/tmp/repo match; a path that no longer exists (a deleted
// worktree) keeps its lexical tail under its nearest surviving parent.
// Only files modified since local midnight are read, since logs get huge.
// Rates are in prices.json next to this file, in USD per million tokens.
//
// A model with no rate there still costs money, so it is priced at the most
// expensive model of the same log source (Claude logs: the highest rate of each
// token type among the Claude entries; Codex logs: the same among the OpenAI
// ones). It is listed in "unpriced" AND counted in usd and byModel, so a
// budget can't be blown on a model nobody priced. Only if prices.json has no
// model of that source at all does it add nothing.
//
// The core (inProject, findPrice, the cost functions, summarize) is pure, so it
// can be tested without touching the real ~/.claude or ~/.codex.

import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MTOK = 1e6;
const num = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
const round = (x) => Math.round(x * 1e6) / 1e6;
const per = (tokens, rate) => (tokens * (rate ?? 0)) / MTOK;

export function loadPrices() {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "prices.json"), "utf8"));
}

// [start, end) of the local calendar day containing `now`, in ms.
export function dayBounds(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// Real location of a path, remembered per path. A path that is gone (a deleted
// worktree) is its nearest existing parent's real location plus the rest.
export function canonicalizer() {
  const cache = new Map();
  const canon = (path) => {
    let real = cache.get(path);
    if (real === undefined) {
      const abs = resolve(path);
      try {
        real = realpathSync(abs);
      } catch {
        const up = dirname(abs);
        real = up === abs ? abs : join(canon(up), basename(abs));
      }
      cache.set(path, real);
    }
    return real;
  };
  return canon;
}

// canon maps a path to its real location; the default compares paths as written.
export function projectMatcher(root, home, canon = resolve) {
  const main = canon(root);
  const worktrees = canon(join(home, ".t3", "worktrees", basename(resolve(root))));
  return (cwd) => {
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return false;
    const path = canon(cwd);
    return inside(main, path) || inside(worktrees, path);
  };
}

export const inProject = (cwd, root, home, canon) => projectMatcher(root, home, canon)(cwd);

// Exact id first, then the longest known id that the model only extends with a
// full date and/or a [1m]-style tag, and nothing after it
// ("claude-opus-5-5-20261001", "claude-opus-5-5[1m]"). A longer version number
// ("claude-opus-5-6"), a different model ("gpt-6.1-sol-mini") or a half date
// ("gpt-6.1-sol-2026-mini") is not a match. Anything but a string has no price.
export function findPrice(prices, model) {
  if (typeof model !== "string" || !model || model.startsWith("_")) return null;
  if (Object.hasOwn(prices, model)) return prices[model];
  let best = null;
  for (const key of Object.keys(prices)) {
    if (key.startsWith("_") || !model.startsWith(key)) continue;
    if (!/^(-\d{8}|-\d{4}-\d{2}-\d{2})?(\[[^\]]*\])?$/.test(model.slice(key.length))) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? null : prices[best];
}

// The rates to charge a model nobody priced: for each token type, the highest
// rate among the models of that log source ("claude" or "codex"), recognised by
// their cache-rate names. Null when prices.json has none of that source.
export function priciest(prices, source) {
  const marker = source === "codex" ? "cachedInput" : "cacheRead";
  const family = Object.entries(prices)
    .filter(([key, p]) => !key.startsWith("_") && p && typeof p === "object" && marker in p)
    .map(([, p]) => p);
  if (!family.length) return null;
  const top = (rate, fallback) => Math.max(0, ...family.map((p) => p[rate] ?? fallback?.(p) ?? 0));
  if (source === "codex") return { input: top("input"), cachedInput: top("cachedInput"), cacheWrite: top("cacheWrite", (p) => p.input), output: top("output") };
  return {
    input: top("input"),
    output: top("output"),
    cacheRead: top("cacheRead"),
    cacheWrite5m: top("cacheWrite5m"),
    cacheWrite1h: top("cacheWrite1h"),
    fastMultiplier: Math.max(1, ...family.map((p) => p.fastMultiplier ?? 1)),
  };
}

// u: { input, output, cacheRead, write5m, write1h, fast }. `input` is the
// uncached part only, as Claude reports it.
export function claudeCost(u, price) {
  const prompt = u.input + u.cacheRead + u.write5m + u.write1h;
  const p = price.longContext && prompt > price.longContext.above ? { ...price, ...price.longContext } : price;
  const usd = per(u.input, p.input) + per(u.output, p.output) + per(u.cacheRead, p.cacheRead) + per(u.write5m, p.cacheWrite5m) + per(u.write1h, p.cacheWrite1h);
  return u.fast ? usd * (price.fastMultiplier ?? 1) : usd;
}

// u: { input, cached, cacheWrite, output }. Codex's input already contains the
// cached and cache-written tokens, and its output already contains reasoning.
export function codexCost(u, price) {
  const uncached = Math.max(0, u.input - u.cached - u.cacheWrite);
  return per(uncached, price.input) + per(u.cached, price.cachedInput) + per(u.cacheWrite, price.cacheWrite ?? price.input) + per(u.output, price.output);
}

// charges: [{ model, session, claude? | codex? }] -> the result object.
export function summarize(charges, prices) {
  const byModel = {};
  const unpriced = new Set();
  const sessions = new Set();
  const worst = {};
  let usd = 0;
  for (const c of charges) {
    sessions.add(c.session);
    const source = c.codex ? "codex" : "claude";
    let price = findPrice(prices, c.model);
    if (!price) {
      unpriced.add(c.model);
      price = worst[source] ??= priciest(prices, source);
      if (!price) continue;
    }
    const cost = c.codex ? codexCost(c.codex, price) : claudeCost(c.claude, price);
    byModel[c.model] = (byModel[c.model] ?? 0) + cost;
    usd += cost;
  }
  for (const model of Object.keys(byModel)) byModel[model] = round(byModel[model]);
  return { usd: round(usd), byModel, unpriced: [...unpriced].sort(), sessions: sessions.size };
}

// ---- Claude Code: ~/.claude/projects/**/*.jsonl ----

const CLAUDE_FIELDS = ["input", "output", "cacheRead", "write5m", "write1h"];

// One assistant line -> the tokens it reports, or null if it isn't a priced-looking
// message for this project and day.
export function claudeLine(o, { start, end, belongs }) {
  const m = o?.message;
  const u = m?.usage;
  if (o?.type !== "assistant" || typeof m?.model !== "string" || !u || m.model.startsWith("<")) return null;
  const at = Date.parse(o.timestamp);
  if (!(at >= start && at < end) || !belongs(o.cwd)) return null;
  const split = u.cache_creation;
  const write5m = num(split?.ephemeral_5m_input_tokens);
  const write1h = num(split?.ephemeral_1h_input_tokens);
  const rec = {
    model: m.model,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    // Anything the total says beyond the 5m/1h split (or all of it, with no split) is 5m.
    write5m: write5m + Math.max(0, num(u.cache_creation_input_tokens) - write5m - write1h),
    write1h,
    fast: u.speed === "fast",
  };
  return CLAUDE_FIELDS.some((f) => rec[f] > 0) ? rec : null;
}

async function claudeCharges(files, ctx) {
  const byKey = new Map();
  let loose = 0;
  for (const file of files) {
    for await (const line of readLines(file)) {
      if (!line.includes('"usage"')) continue;
      const o = parseLine(line);
      const rec = o && claudeLine(o, ctx);
      if (!rec) continue;
      rec.session = `claude:${o.sessionId ?? file}`;
      // Claude writes one line per content block, all with the same message id.
      // The first carries a partial output_tokens count, so keep the largest of each field.
      const ids = [o.message.id, o.requestId].filter(Boolean);
      const key = ids.length ? ids.join("|") : `line:${loose++}`;
      const seen = byKey.get(key);
      if (!seen) byKey.set(key, rec);
      else {
        for (const f of CLAUDE_FIELDS) seen[f] = Math.max(seen[f], rec[f]);
        seen.fast ||= rec.fast;
      }
    }
  }
  return [...byKey.values()].map(({ model, session, ...claude }) => ({ model, session, claude }));
}

// ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----

const CODEX_FIELDS = ["input", "cached", "cacheWrite", "output"];
const zeroCodex = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0 });

// The four counters of a usage record, or null if it isn't a usable one: not an
// object, or a counter that isn't a non-negative number. A missing cached or
// cache-write counter is 0.
function codexTokens(t) {
  if (!t || typeof t !== "object") return null;
  const tokens = { input: t.input_tokens, cached: t.cached_input_tokens ?? 0, cacheWrite: t.cache_write_input_tokens ?? 0, output: t.output_tokens };
  return CODEX_FIELDS.every((f) => Number.isFinite(tokens[f]) && tokens[f] >= 0) ? tokens : null;
}

// Walks one rollout file in order. total_token_usage is cumulative for the
// session, so spend is the increase since the previous event, priced at the
// model and counted for the cwd in effect at that moment. Events from before
// today still move the baseline, so the first event of today is measured
// against the last total before it. Repeated totals add nothing. A total that
// is unusable is skipped without touching the baseline; a total that went down
// means the counter was reset, so only that event's own last_token_usage is
// charged and the new total becomes the baseline.
async function codexCharges(file, { start, end, belongs }) {
  const charges = [];
  let session = `codex:${file}`;
  let cwd = null;
  let model = "unknown";
  let prev = zeroCodex();
  for await (const line of readLines(file)) {
    if (!/session_meta|turn_context|token_count/.test(line)) continue;
    const o = parseLine(line);
    const p = o?.payload;
    if (!p) continue;
    if (o.type === "session_meta") {
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.id === "string" && p.id) session = `codex:${p.id}`;
    } else if (o.type === "turn_context") {
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.model === "string" && p.model) model = p.model;
    } else if (o.type === "event_msg" && p.type === "token_count") {
      const total = codexTokens(p.info?.total_token_usage);
      if (!total) continue;
      const reset = CODEX_FIELDS.some((f) => total[f] < prev[f]);
      const delta = reset ? codexTokens(p.info.last_token_usage) : Object.fromEntries(CODEX_FIELDS.map((f) => [f, total[f] - prev[f]]));
      prev = total;
      const at = Date.parse(o.timestamp);
      if (delta && at >= start && at < end && belongs(cwd) && CODEX_FIELDS.some((f) => delta[f] > 0)) charges.push({ model, session, codex: delta });
    }
  }
  return charges;
}

// ---- files ----

async function* readLines(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } catch (e) {
    // A file that vanished just ends here; one we can't read means spend
    // can't be counted.
    if (e.code !== "ENOENT") throw e;
  }
}

function parseLine(line) {
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

// Every .jsonl under dir (any depth) modified at or after `since`.
async function recentLogs(dir, since) {
  const found = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (e) {
      // A missing folder is no spend. Anything else (no permission) means
      // we can't count, which must stop the budget gate, not open it.
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const path = join(d, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.name.endsWith(".jsonl")) {
        try {
          if ((await stat(path)).mtimeMs >= since) found.push(path);
        } catch (e) {
          if (e.code !== "ENOENT") throw e; // ENOENT: gone since the listing
        }
      }
    }
  };
  await walk(dir);
  return found.sort();
}

export async function spentToday({ root, home = homedir(), now = new Date(), prices }) {
  const { start, end } = dayBounds(now);
  const ctx = { start, end, belongs: projectMatcher(root, home, canonicalizer()) };
  const charges = await claudeCharges(await recentLogs(join(home, ".claude", "projects"), start), ctx);
  for (const file of await recentLogs(join(home, ".codex", "sessions"), start)) charges.push(...(await codexCharges(file, ctx)));
  return summarize(charges, prices ?? loadPrices());
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  if (!opt("root")) throw new Error("--root <main checkout path> is required");
  let now = new Date();
  if (opt("date")) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opt("date"));
    if (!m) throw new Error("--date must look like 2026-10-09");
    now = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  }
  spentToday({ root: resolve(opt("root")), now }).then((r) => console.log(JSON.stringify(r, null, 2)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
