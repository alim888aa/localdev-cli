#!/usr/bin/env node
// Decides what a project's dispatch thread does next. It reads GitHub and git,
// takes the T3 thread list on stdin, and prints a plan as JSON. With --apply it
// also makes the GitHub and git changes itself, so all that's left for the
// agent are the T3 calls (launch, resume, settle, triage, research, tell the
// manager). With `budgetUsd` in factory.json it counts today's spend first
// (usage.mjs) and starts only p0 work once it's reached.
//
//   node dispatch-plan.mjs --repo owner/name [--finished 102] [--tick] [--apply] < threads.json
//   node dispatch-plan.mjs --ack 9:parent-run,12:needs-manager
//
// --config <file> reads factory.json from a local file instead of the default
// branch, for trying it on a project that isn't set up yet. --ack records
// that the manager was told, so the next tick doesn't tell it again.
//
// Run it from the project's main checkout. The decisions live in plan(), which
// is pure so they can be tested against made-up label states.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ISSUE_STATUSES = ["needs-human", "needs-manager", "blocked", "backlog", "agent-ready", "building"];
export const PR_STATUSES = ["reviewer-ready", "fixing", "verifier-ready", "blocked", "approved", "human-ready", "needs-human", "needs-manager"];
const LOOP = ["reviewer-ready", "fixing", "verifier-ready", "approved"];
const MANAGER_LABELS = ["needs-manager", "needs-human", "human-ready", "human-comment"];
const ACTIVE = ["preparing", "queued", "starting", "running", "waiting"];
const HOUR = 60 * 60 * 1000;
const LIST_LIMIT = 1000;

const isStatus = (label) => ISSUE_STATUSES.includes(label) || PR_STATUSES.includes(label) || label.startsWith("deployed:");
const statusOf = (item) => {
  const statuses = item.labels.filter(isStatus);
  return statuses.length === 1 ? statuses[0] : null;
};
const statusWrite = (item, status) => ({
  do: "label", issue: item.number, number: item.number,
  expectedStatuses: item.labels.filter(isStatus),
  labels: [...item.labels.filter((l) => !isStatus(l)), status],
});
const commentAction = (number, body) => ({ do: "comment", issue: number, number, body: `Author: dispatch\n\n${body}` });
const statusConflict = (item) => {
  const statuses = item.labels.filter(isStatus);
  const reason = `Can't classify #${item.number}: multiple status labels (${statuses.join(", ")}); started nothing. Manager must decide the status.`;
  return { reason, github: [commentAction(item.number, reason), statusWrite(item, "needs-manager")] };
};
const priority = (item) => {
  const p = item.labels.find((l) => /^p[0-2]$/.test(l));
  return p ? Number(p[1]) : 2;
};

export function links(text, word) {
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${word} #(\\d+)\\s*$`, "gim");
  return [...(text ?? "").matchAll(re)].map((m) => Number(m[1]));
}

export function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function modelSelection(config, job) {
  const j = config.jobs?.[job] ?? config.jobs?.["review-*"];
  if (!j) throw new Error(`factory.json has no model for ${job} and no review-* entry`);
  const key = j.provider === "claudeAgent" ? "effort" : "reasoningEffort";
  return { instanceId: j.provider, model: j.model, options: j.effort ? { [key]: j.effort } : {} };
}

// state: everything gathered from GitHub, git and T3. Returns the actions,
// GitHub/git ones in the order they must happen, then the T3 ones. Every
// action carries the issue it's for, so a failed GitHub step can hold back
// the T3 steps that depend on it.
export function plan(state, { finished = null, tick = false } = {}) {
  const { config, issues, prs, closedPrs, refs, threads, root } = state;
  const defaultBranch = state.defaultBranch ?? "main";
  const dark = config.owner === "agent";
  let worktrees = state.worktrees;
  let remoteBranches = state.remoteBranches;
  const github = [];
  const t3 = [];
  const notes = [];
  const repoName = basename(root);

  // Threads and slots. Worker threads are `Factory · #<issue>` and
  // `Factory · parent #<plan>`; one holds a slot while it or anything under
  // it (subagents, their subagents) is active.
  const active = (t) => ACTIVE.includes(t.status);
  const byId = new Map(threads.map((t) => [t.threadId, t]));
  const rootOf = (t) => {
    let cur = t;
    for (let i = 0; i < 20 && cur?.parentThreadId && byId.has(cur.parentThreadId); i++) cur = byId.get(cur.parentThreadId);
    return cur;
  };
  const issueOf = (t) => {
    const m = /^Factory · #(\d+)$/.exec(t.title ?? "");
    return m && !t.parentThreadId ? Number(m[1]) : null;
  };
  const isWorker = (t) => !t.parentThreadId && /^Factory · (parent )?#\d+$/.test(t.title ?? "");
  const busyRoots = new Set(threads.filter(active).map((t) => rootOf(t).threadId));
  const holds = (t) => busyRoots.has(t.threadId) && !(finished != null && issueOf(t) === finished);
  const workers = threads.filter(isWorker);
  // Busy work whose chain we can't follow up to a known thread might belong
  // to a worker, so it takes a slot until it's done.
  const unresolved = [...busyRoots].filter((id) => byId.get(id)?.parentThreadId);
  // Its owner could be any worker, so while it runs nothing gets cleaned up
  // or resumed; new issues still start into the slots left.
  if (unresolved.length) notes.push(`${unresolved.length} busy thread(s) with an unknown parent: slots taken, no cleanup or resume this wake`);
  const slotsUsed = workers.filter(holds).length + unresolved.length;
  const subtreeBusy = (t) => active(t) || threads.some((c) => c.parentThreadId === t.threadId && subtreeBusy(c));
  const holding = new Set(workers.filter(holds).map(issueOf).filter((n) => n != null));
  // The newest unsettled thread per issue; the list comes newest first.
  const threadFor = new Map();
  for (const t of workers) {
    const n = issueOf(t);
    if (n != null && !t.settled && !threadFor.has(n)) threadFor.set(n, t);
  }

  const openIssue = new Map(issues.map((i) => [i.number, i]));
  const openPrsFor = (n) => prs.filter((p) => links(p.body, "Closes").includes(n));
  const featureBranches = new Set(Object.values(refs).map((r) => r.featureBranch).filter(Boolean));
  const closedHeads = new Set(closedPrs.map((p) => p.headRefName));
  const openHeads = new Set(prs.map((p) => p.headRefName));
  // A branch a worker pushed for issue n, skipping ones whose PR was closed.
  const branchFor = (n) => remoteBranches.find((b) => new RegExp(`^[^/]+/${n}-`).test(b) && !closedHeads.has(b));
  const worktreeFor = (branch) => worktrees.find((w) => w.branch === branch && w.path !== root);
  // How an issue or PR was closed: COMPLETED, NOT_PLANNED, or null while open
  // or unknown. Only an affirmative answer from GitHub counts as closed.
  const closedAs = (n) => (openIssue.has(n) || prs.some((p) => p.number === n) || !refs[n]?.closed ? null : refs[n].reason);
  const safeToDelete = (branch) =>
    branch && branch !== defaultBranch && !featureBranches.has(branch) && !openHeads.has(branch);

  const setStatus = (item, status, kind) => {
    const action = statusWrite(item, status);
    github.push(action);
    item.labels = action.labels;
    notes.push(`${kind} #${item.number} → ${status}`);
  };
  const comment = (number, body) => github.push(commentAction(number, body));

  // Conflicting statuses cannot classify work, even after routing the item
  // to the manager. Nothing for it starts or resumes during this wake.
  const unclassifiable = new Set();
  for (const item of [...issues, ...prs, ...(state.closedCommented ?? [])]) {
    const statuses = item.labels.filter(isStatus);
    if (statuses.length < 2) continue;
    unclassifiable.add(item.number);
    const conflict = statusConflict(item);
    notes.push(conflict.reason);
    github.push(...conflict.github);
    item.labels = conflict.github[1].labels;
    notes.push(`${prs.includes(item) ? "PR" : "issue"} #${item.number} → needs-manager`);
  }

  // 1. Clean up after threads that are done: the issue closed, or the PR the
  // thread worked on closed unmerged after it started (a re-plan). Only the
  // worktree goes, and the branch only when its PR merged; an unmerged
  // branch is the last copy of that work.
  const cleaned = new Set();
  for (const [n, t] of threadFor) {
    if (unresolved.length || unclassifiable.has(n) || holding.has(n) || openPrsFor(n).length) continue;
    const issueClosed = closedAs(n) !== null;
    const replacedPr = closedPrs.find(
      (p) => links(p.body, "Closes").includes(n) && !p.merged && p.closedAt && t.createdAt && t.createdAt < p.closedAt,
    );
    if (!issueClosed && !(openIssue.has(n) && replacedPr)) continue;
    const pr = replacedPr ?? closedPrs.find((p) => links(p.body, "Closes").includes(n));
    const branch = pr?.headRefName ?? branchFor(n);
    const wt = branch && worktreeFor(branch);
    if (wt) {
      github.push({ do: "remove-worktree", issue: n, path: wt.path, branch, merged: Boolean(pr?.merged) });
      worktrees = worktrees.filter((w) => w !== wt);
    }
    if (pr?.merged && safeToDelete(branch) && remoteBranches.includes(branch)) {
      github.push({ do: "delete-branch", issue: n, branch });
      remoteBranches = remoteBranches.filter((b) => b !== branch);
    }
    t3.push({ do: "settle", issue: n, threadId: t.threadId, why: `#${n} ${issueClosed ? "closed" : "re-planned"}` });
    cleaned.add(n);
  }

  // 2. Unblock. Blockers are the `Blocked by` lines gathered per item.
  const unblockedPrs = new Set();
  for (const item of [...issues, ...prs]) {
    if (unclassifiable.has(item.number)) continue;
    if (!item.labels.includes("blocked")) continue;
    const isPr = prs.includes(item);
    const blockers = item.blockers ?? [];
    if (blockers.length === 0) {
      notes.push(`#${item.number} is blocked with no Blocked by line`);
      continue;
    }
    const states = blockers.map(closedAs);
    if (states.some((s) => s === null)) continue;
    if (states.some((s) => s === "NOT_PLANNED")) {
      setStatus(item, "needs-manager", isPr ? "PR" : "issue");
      const dropped = blockers.filter((b, i) => states[i] === "NOT_PLANNED");
      comment(item.number, `Blocker dropped: ${dropped.map((b) => `#${b}`).join(", ")} closed without being done.`);
    } else if (isPr) {
      // Parent and human-led PRs have no worker to resume; parents come
      // back through the manager on the tick.
      if (links(item.body, "Closes").length) unblockedPrs.add(item.number);
    } else {
      setStatus(item, "agent-ready", "issue");
    }
  }

  // Budget. Over the cap, or when today's spend couldn't be counted, only
  // p0 starts.
  const budget = config.budgetUsd;
  const overBudget = budget != null && !(state.spend?.usd < budget);
  if (budget != null && !state.spend) notes.push(`couldn't count today's spend (${state.spendError ?? "no meter"}); only p0 starts`);
  else if (overBudget) notes.push(`spent $${state.spend.usd.toFixed(2)} of $${budget} today; only p0 starts`);
  if (budget != null && state.spend?.unpriced?.length) notes.push(`no price for ${state.spend.unpriced.join(", ")}; not counted`);

  // 3. Start workers into free slots: stranded PRs, stranded issues, new issues.
  let free = (config.maxParallel ?? 2) - slotsUsed;
  const started = new Set();
  const byPriority = (a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt);

  function newBranch(i) {
    const type = (i.labels.find((l) => l.startsWith("type:")) ?? "type:chore").slice(5);
    const name = `${type}/${i.number}-${slug(i.title)}`;
    let candidate = name;
    for (let k = 2; remoteBranches.includes(candidate) || closedHeads.has(candidate); k++) candidate = `${name}-${k}`;
    return candidate;
  }
  function baseFor(i) {
    const p = links(i.body, "Part of")[0];
    if (!p) return defaultBranch;
    return refs[p]?.featureBranch ?? null;
  }

  // One place decides whether issue n may start, so no path can give an
  // issue a second worker or spend past the budget.
  const canStart = (n, item) =>
    free > 0 && !unclassifiable.has(n) && !unclassifiable.has(item.number) && !started.has(n) && !holding.has(n) && !(unresolved.length && threadFor.has(n)) && !(overBudget && priority(item) > 0);
  const startOn = (n, { branch, baseRef, message }) => {
    const t = threadFor.get(n);
    if (t && !cleaned.has(n)) {
      t3.push({ do: "resume", issue: n, threadId: t.threadId, message: `Resume #${n}.${message ? ` ${message}` : ""}` });
    } else {
      let workspaceStrategy;
      if (baseRef) {
        workspaceStrategy = { type: "worktree", baseRef, branch, startFromOrigin: true };
      } else {
        // The branch already exists on origin: reuse or make its worktree.
        let wt = worktreeFor(branch);
        if (!wt) {
          wt = { path: join(homedir(), ".t3", "worktrees", repoName, branch.replaceAll("/", "-")), branch };
          github.push({ do: "add-worktree", issue: n, path: wt.path, branch });
        }
        workspaceStrategy = { type: "existing_worktree", worktreePath: wt.path, branch };
      }
      t3.push({
        do: "launch",
        issue: n,
        title: `Factory · #${n}`,
        workspaceStrategy,
        modelSelection: modelSelection(config, "build"),
        runtimeMode: "full-access",
        message: `Follow the worker skill on ${state.repo}#${n}.${message ? ` ${message}` : ""}`,
      });
    }
    started.add(n);
    free -= 1;
  };

  const strandedPrs = prs
    .filter((p) => links(p.body, "Closes")[0] && (LOOP.includes(statusOf(p)) || unblockedPrs.has(p.number)))
    .sort(byPriority);
  for (const p of strandedPrs) {
    const n = links(p.body, "Closes")[0];
    if (!canStart(n, p)) continue;
    if (openPrsFor(n).length > 1) {
      notes.push(`#${n} has ${openPrsFor(n).length} open PRs; started none`);
      continue;
    }
    if (unblockedPrs.has(p.number)) notes.push(`PR #${p.number} unblocked`);
    startOn(n, { branch: p.headRefName, message: `Pick up PR #${p.number} from its labels.` });
  }

  const strandedIssues = issues.filter((i) => i.labels.includes("building") && !openPrsFor(i.number).length).sort(byPriority);
  for (const i of strandedIssues) {
    if (!canStart(i.number, i)) continue;
    const branch = branchFor(i.number);
    if (branch) startOn(i.number, { branch });
    else if (baseFor(i)) startOn(i.number, { branch: newBranch(i), baseRef: baseFor(i) });
  }

  const dependents = (n) => issues.filter((i) => links(i.body, "Depends on").includes(n)).length;
  const ready = issues
    .filter((i) => i.labels.includes("agent-ready") && !i.labels.includes("type:plan") && !openPrsFor(i.number).length)
    .filter((i) => links(i.body, "Depends on").every((d) => closedAs(d) === "COMPLETED"))
    .sort((a, b) => priority(a) - priority(b) || dependents(b.number) - dependents(a.number) || a.createdAt.localeCompare(b.createdAt));
  for (const i of ready) {
    if (!canStart(i.number, i)) continue;
    const base = baseFor(i);
    if (base === null) {
      setStatus(i, "needs-manager", "issue");
      comment(i.number, `Can't start: plan #${links(i.body, "Part of")[0]} has no \`Feature branch:\` line.`);
      continue;
    }
    if (base !== defaultBranch && !remoteBranches.includes(base)) {
      github.push({ do: "push-branch", issue: `branch:${base}`, from: defaultBranch, branch: base });
      remoteBranches = [...remoteBranches, base];
    }
    const mark = github.length;
    const markT3 = t3.length;
    setStatus(i, "building", "issue");
    // Work it pushed before it was blocked carries on; a re-plan doesn't.
    const existing = cleaned.has(i.number) ? null : branchFor(i.number);
    if (existing) startOn(i.number, { branch: existing });
    else startOn(i.number, { branch: newBranch(i), baseRef: base });
    // Everything for a child waits on its feature branch being pushed.
    if (base !== defaultBranch) for (const a of [...github.slice(mark), ...t3.slice(markT3)]) a.after = `branch:${base}`;
  }

  // 4. Triage anything with no status, unless a triage run is still going.
  const untriaged = issues.filter((i) => !statusOf(i) && i.title !== "Triage log" && !i.labels.includes("audit"));
  const triageRunning = threads.some((t) => t.title === "Factory · triage" && subtreeBusy(t));
  if (untriaged.length && !triageRunning) {
    t3.push({
      do: "triage",
      issue: null,
      title: "Factory · triage",
      modelSelection: modelSelection(config, "triage"),
      task: `Follow the triage skill on ${state.repo}, run "New issues": ${untriaged.map((i) => `#${i.number}`).join(", ")}.`,
    });
  }

  // 5. On the tick, tell the manager about anything its webhook missed, and
  // about plans whose children are all done, which need a parent run.
  if (tick) {
    const nudge = [];
    // A closed item can still carry a human comment: "deploy" on a merged
    // parent PR.
    for (const item of [...issues, ...prs, ...(state.closedCommented ?? [])]) {
      for (const label of item.labels.filter((l) => MANAGER_LABELS.includes(l))) {
        const ev = state.labelEvents?.[`${item.number}:${label}`];
        if (!ev || ev.managerReplied) continue;
        const key = `${item.number}:${label}@${ev.labeledAt}`;
        if (state.nudged.includes(key)) continue;
        if (state.now - Date.parse(ev.labeledAt) > HOUR) nudge.push(key);
      }
    }
    const parentsDue = [];
    // A parent run starts a worker and a verifier, so the budget holds it
    // like any other start.
    for (const p of issues.filter((i) => i.labels.includes("type:plan") && !(overBudget && priority(i) > 0))) {
      if (unclassifiable.has(p.number)) continue;
      const branch = refs[p.number]?.featureBranch;
      if (!branch || !remoteBranches.includes(branch)) continue;
      const openChild = [...issues, ...prs].some((x) => x.headRefName !== branch && links(x.body, "Part of").includes(p.number));
      if (openChild) continue;
      const parent = prs.find((x) => x.headRefName === branch);
      if (parent && unclassifiable.has(parent.number)) continue;
      const live = workers.some((t) => t.title === `Factory · parent #${p.number}` && holds(t));
      let key = null;
      if (live) key = null;
      else if (!parent) key = `${p.number}:parent-run`;
      else if (!statusOf(parent)) key = `${p.number}:parent-run:${parent.number}`;
      else if (parent.labels.includes("blocked") && parent.blockers?.length && parent.blockers.every((b) => closedAs(b) === "COMPLETED"))
        key = `${p.number}:parent-run:${parent.number}:${parent.blockers.join("+")}`;
      if (key && !state.nudged.includes(key)) parentsDue.push(key);
    }
    const manager = threads.find((t) => t.title === "Factory · manager" && !t.parentThreadId);
    const lines = [];
    if (nudge.length) lines.push(`Waiting on you: ${nudge.map((k) => `#${k.split(":")[0]}`).join(", ")}.`);
    if (parentsDue.length) lines.push(`Parent run due for plan ${parentsDue.map((k) => `#${k.split(":")[0]}`).join(", ")}.`);
    if (lines.length && manager) {
      t3.push({ do: "tell-manager", issue: null, threadId: manager.threadId, message: lines.join(" "), ack: [...nudge, ...parentsDue].join(",") });
    } else if (lines.length) {
      notes.push("the manager has work but there's no Factory · manager thread");
    }
  }

  // 6. A dark project with nothing to build researches instead, once a day,
  // on the tick and only with budget left.
  if (tick && dark && !overBudget) {
    const idle = slotsUsed === 0 && started.size === 0 && !untriaged.length && !triageRunning;
    // The local day, the same one the budget counts.
    const day = new Date(state.now);
    const key = `research@${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const researching = threads.some((t) => t.title === "Factory · research" && subtreeBusy(t));
    if (idle && !researching && !state.nudged.includes(key)) {
      t3.push({
        do: "research",
        issue: null,
        title: "Factory · research",
        modelSelection: modelSelection(config, "research"),
        task: `Follow the researcher skill on ${state.repo}, an open run: the factory has nothing to build.`,
        ack: key,
      });
    }
  }

  return { github, t3, notes, started: [...started], cleaned: [...cleaned] };
}

// ---------------------------------------------------------------------------
// Everything below talks to the outside world.

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
const gh = (...args) => sh("gh", args);
const ghJson = (...args) => JSON.parse(gh(...args) || "null");

function readFromMain(repo, path) {
  try {
    return Buffer.from(ghJson("api", `repos/${repo}/contents/${path}`).content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function listAll(kind, repo, state, fields) {
  const rows = ghJson(kind, "list", "-R", repo, "--state", state, "--limit", String(LIST_LIMIT), "--json", fields);
  if (state === "open" && rows.length >= LIST_LIMIT) throw new Error(`more than ${LIST_LIMIT} open ${kind}s; refusing to plan from a partial list`);
  return rows;
}

function gather(repo, root, tick, threads, configPath) {
  const configText = configPath ? readFileSync(configPath, "utf8") : readFromMain(repo, "factory.json");
  const gitignore = readFromMain(repo, ".gitignore") ?? "";
  if (!configText) return { stop: "factory.json isn't on the default branch" };
  if (!/^\/?\.scratch\/?$/m.test(gitignore)) return { stop: ".scratch/ isn't in .gitignore on the default branch" };
  const config = JSON.parse(configText);
  const defaultBranch = ghJson("api", `repos/${repo}`).default_branch;

  const flat = (x) => ({ ...x, labels: x.labels.map((l) => l.name) });
  const issues = listAll("issue", repo, "open", "number,title,labels,body,createdAt").map(flat);
  const prs = listAll("pr", repo, "open", "number,title,labels,body,headRefName,baseRefName,createdAt").map(flat);
  const closedPrs = ghJson("pr", "list", "-R", repo, "--state", "closed", "--limit", "100", "--json", "number,body,headRefName,mergedAt,closedAt").map(
    (p) => ({ ...p, merged: Boolean(p.mergedAt) }),
  );

  const refs = {};
  const ref = (n) => {
    if (refs[n]) return refs[n];
    const r = ghJson("api", `repos/${repo}/issues/${n}`);
    const fb = /^\s*Feature branch:\s*`?([^\s`]+)`?\s*$/im.exec(r.body ?? "");
    let reason = "COMPLETED";
    // A closed PR counts as done only if it merged; a closed issue unless it
    // was closed as not planned or as a duplicate.
    if (r.pull_request) reason = r.pull_request.merged_at ? "COMPLETED" : "NOT_PLANNED";
    else if (r.state_reason === "not_planned" || r.state_reason === "duplicate") reason = "NOT_PLANNED";
    return (refs[n] = { closed: r.state === "closed", reason, featureBranch: fb?.[1] ?? null });
  };
  for (const item of [...issues, ...prs]) {
    if (item.labels.includes("blocked")) {
      const comments = ghJson("api", `repos/${repo}/issues/${item.number}/comments`, "--paginate");
      const withLines = [...comments].reverse().find((c) => links(c.body, "Blocked by").length);
      item.blockers = links(withLines?.body ?? item.body, "Blocked by");
      item.blockers.forEach(ref);
    }
    links(item.body, "Depends on").forEach(ref);
    links(item.body, "Part of").forEach(ref);
  }
  for (const p of issues.filter((i) => i.labels.includes("type:plan"))) ref(p.number);
  for (const t of threads) {
    const m = /^Factory · #(\d+)$/.exec(t.title ?? "");
    if (m && !issues.some((i) => i.number === Number(m[1]))) ref(Number(m[1]));
  }

  // The closed-PR list above is only the latest 100. For any branch a
  // worker might pick back up, ask GitHub directly whether its PR closed.
  const remoteBranchesRaw = sh("git", ["ls-remote", "--heads", "origin"], { cwd: root })
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("refs/heads/")[1]);
  const live = new Set(issues.filter((i) => ["agent-ready", "building", "blocked"].some((l) => i.labels.includes(l))).map((i) => i.number));
  const known = new Set(closedPrs.map((p) => p.headRefName));
  for (const b of remoteBranchesRaw) {
    const n = Number(/^[^/]+\/(\d+)-/.exec(b)?.[1]);
    if (!live.has(n) || known.has(b)) continue;
    const older = ghJson("pr", "list", "-R", repo, "--head", b, "--state", "closed", "--json", "number,body,headRefName,mergedAt,closedAt");
    for (const p of older) closedPrs.push({ ...p, merged: Boolean(p.mergedAt) });
  }

  const worktrees = [];
  for (const block of sh("git", ["worktree", "list", "--porcelain"], { cwd: root }).split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path) worktrees.push({ path, branch });
  }
  const remoteBranches = remoteBranchesRaw;

  const stateFile = nudgedFile(root);
  const nudged = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : [];
  const labelEvents = {};
  let closedCommented = [];
  if (tick) {
    const found = ghJson("api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} label:human-comment state:closed`, "-f", "per_page=100");
    if (found.total_count > found.items.length) throw new Error(`more than ${found.items.length} closed items carry human-comment; refusing to nudge from a partial list`);
    closedCommented = found.items.map(flat);
    for (const item of [...issues, ...prs, ...closedCommented]) {
      for (const label of item.labels.filter((l) => MANAGER_LABELS.includes(l))) {
        const timeline = ghJson("api", `repos/${repo}/issues/${item.number}/timeline`, "--paginate");
        const labeled = timeline.filter((e) => e.event === "labeled" && e.label?.name === label).at(-1);
        if (!labeled) continue;
        // Whoever answers a human comment removes its label, so while the
        // label is on, it's unanswered, whatever else got posted.
        const managerReplied =
          label !== "human-comment" &&
          timeline.some((e) => e.event === "commented" && e.created_at > labeled.created_at && /^Author: (manager|owner)/.test(e.body ?? ""));
        labelEvents[`${item.number}:${label}`] = { labeledAt: labeled.created_at, managerReplied };
      }
    }
  }
  return { repo, root, config, defaultBranch, issues, prs, closedPrs, closedCommented, refs, threads, worktrees, remoteBranches, labelEvents, nudged, now: Date.now() };
}

const nudgedFile = (root) => join(root, ".scratch", "dispatch", "nudged.json");

// A worktree goes only if nothing in it would be lost: no uncommitted
// changes, and its commits are on origin or its PR merged.
function worktreeIsSafe(path, merged, root) {
  if (sh("git", ["-C", path, "status", "--porcelain"])) return "it has uncommitted changes";
  if (merged) return null;
  sh("git", ["fetch", "origin"], { cwd: root });
  const onRemote = sh("git", ["-C", path, "branch", "-r", "--contains", "HEAD"]);
  return onRemote ? null : "its commits aren't on origin";
}

export function apply(state, result, runGh = gh) {
  const { repo, root } = state;
  const done = [];
  const failed = new Set();
  for (let a of result.github) {
    if ((a.issue != null && failed.has(a.issue)) || (a.after && failed.has(a.after))) {
      done.push({ ...a, ok: false, error: "skipped: an earlier step for this issue failed" });
      continue;
    }
    try {
      if (a.do === "label") {
        // Compare the planned status with a fresh read before replacing it,
        // carrying every other current label. GitHub has no CAS, so verify
        // the write before releasing any action that depends on it.
        const endpoint = `repos/${repo}/issues/${a.number}/labels`;
        const readLabels = () => JSON.parse(runGh("api", endpoint, "--paginate", "--slurp")).flat().map((l) => l.name);
        let now = readLabels();
        const current = now.filter(isStatus);
        const matches = current.length === a.expectedStatuses.length && current.every((l) => a.expectedStatuses.includes(l));
        // A planned conflict resolution already has a successful comment
        // immediately before it. A new conflict needs its own comment first.
        if (current.length > 1 && !(matches && a.labels.includes("needs-manager"))) {
          const conflict = statusConflict({ number: a.number, labels: now });
          failed.add(a.issue);
          done.push({ ...a, ok: false, error: conflict.reason });
          result.notes.push(conflict.reason);
          result.notes.push(`#${a.number} held: status conflict; next wake will re-plan from fresh state`);
          a = conflict.github[0];
          runGh("api", `repos/${repo}/issues/${a.number}/comments`, "-f", `body=${a.body}`);
          done.push({ ...a, ok: true });
          a = conflict.github[1];
          // The comment must succeed before resolving the conflict. Re-read
          // afterwards in case the manager changed the status meanwhile.
          now = readLabels();
          const afterComment = now.filter(isStatus);
          if (afterComment.length !== a.expectedStatuses.length || !afterComment.every((l) => a.expectedStatuses.includes(l))) {
            throw new Error(`status changed after conflict comment: expected ${a.expectedStatuses.join(", ")}, found ${afterComment.join(", ") || "no status"}`);
          }
        } else if (!matches) {
          throw new Error(`status changed since gather: expected ${a.expectedStatuses.join(", ") || "no status"}, found ${current.join(", ") || "no status"}`);
        }
        const status = a.labels.find(isStatus);
        const labels = [...now.filter((l) => !isStatus(l)), status];
        runGh("api", "-X", "PUT", endpoint, ...labels.flatMap((l) => ["-f", `labels[]=${l}`]));
        const actual = readLabels().filter(isStatus);
        if (actual.length !== 1 || actual[0] !== status) {
          throw new Error(`status verification failed: expected only ${status}, found ${actual.join(", ") || "no status"}`);
        }
      } else if (a.do === "comment") {
        runGh("api", `repos/${repo}/issues/${a.number}/comments`, "-f", `body=${a.body}`);
      } else if (a.do === "remove-worktree") {
        const unsafe = worktreeIsSafe(a.path, a.merged, root);
        if (unsafe) throw new Error(`kept ${a.path}: ${unsafe}`);
        sh("git", ["worktree", "remove", a.path], { cwd: root });
      } else if (a.do === "delete-branch") {
        sh("git", ["push", "origin", "--delete", a.branch], { cwd: root });
      } else if (a.do === "push-branch") {
        sh("git", ["fetch", "origin", a.from], { cwd: root });
        sh("git", ["push", "origin", `origin/${a.from}:refs/heads/${a.branch}`], { cwd: root });
      } else if (a.do === "add-worktree") {
        sh("git", ["fetch", "origin", a.branch], { cwd: root });
        mkdirSync(dirname(a.path), { recursive: true });
        sh("git", ["worktree", "add", a.path, a.branch], { cwd: root });
      }
      done.push({ ...a, ok: true });
    } catch (e) {
      if (a.issue != null) failed.add(a.issue);
      const error = String(e.stderr || e.message).trim().split("\n")[0];
      done.push({ ...a, ok: false, error });
      if (a.do === "label") result.notes.push(`#${a.number} held: ${error}; next wake will re-plan from fresh state`);
    }
  }
  const isHeld = (a) => (a.issue != null && failed.has(a.issue)) || (a.after && failed.has(a.after));
  return { done, failed, held: result.t3.filter(isHeld), t3: result.t3.filter((a) => !isHeld(a)) };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const root = sh("git", ["rev-parse", "--show-toplevel"]);

  if (opt("ack")) {
    const file = nudgedFile(root);
    const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...new Set([...prev, ...opt("ack").split(",")])], null, 2));
    console.log(JSON.stringify({ acked: opt("ack").split(",") }));
    return;
  }

  const repo = opt("repo");
  if (!repo) throw new Error("--repo owner/name is required");
  const finished = opt("finished") ? Number(opt("finished")) : null;
  const tick = args.includes("--tick");
  const input = readFileSync(0, "utf8").trim();
  const parsed = input ? JSON.parse(input) : [];
  const threads = Array.isArray(parsed) ? parsed : parsed.threads ?? [];

  const state = gather(repo, root, tick, threads, opt("config"));
  if (state.stop) {
    console.log(JSON.stringify({ stop: state.stop, t3: [] }, null, 2));
    return;
  }
  if (state.config.budgetUsd != null) {
    try {
      const { spentToday } = await import("./usage.mjs");
      state.spend = await spentToday({ root, now: new Date(state.now) });
    } catch (e) {
      state.spendError = String(e.message).split("\n")[0];
    }
  }
  const result = plan(state, { finished, tick });
  const out = { ...result };
  if (args.includes("--apply")) {
    const { done, held, t3 } = apply(state, result);
    out.github = done;
    // T3 steps for an issue whose GitHub steps failed wait for the next wake.
    out.held = held;
    out.t3 = t3;
  }
  console.log(JSON.stringify(out, null, 2));
}

let entryPath;
try {
  entryPath = process.argv[1] && realpathSync(process.argv[1]);
} catch {
  // A non-file entry argument means this module is being imported.
}
if (entryPath === realpathSync(fileURLToPath(import.meta.url)))
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
