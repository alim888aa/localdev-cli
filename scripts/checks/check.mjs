// The one check: `pnpm check`. Run it before reviewer-ready and after every fix.
//
//   node scripts/checks/check.mjs           typecheck, dist in sync, tests, strict rules, ratchet
//   node scripts/checks/check.mjs --write   lower baseline.json to today's counts
//
// Strict rules fail on any finding. Ratchet rules compare a count per rule to
// scripts/checks/baseline.json; a change may only lower a number. --write never
// raises one: raising a number is a hand edit the human approves.
//
// There is no formatter on purpose: the repo has none, and adding one would
// rewrite every file.
import {spawnSync} from "node:child_process";
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {REPO_ROOT, measureRules} from "./rules.mjs";

const BASELINE_PATH = join(REPO_ROOT, "scripts/checks/baseline.json");
const SHOWN = 30;
const writeMode = process.argv.includes("--write");
const failures = [];

function run(label, command, args) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, {cwd: REPO_ROOT, stdio: "inherit"});
  if (result.status !== 0) failures.push(label);
  return result.status === 0;
}

function typecheck() {
  run("typecheck", "pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"]);
}

function filesIn(root, dir = "") {
  const out = [];
  for (const entry of readdirSync(join(root, dir), {withFileTypes: true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesIn(root, path));
    else out.push(path);
  }
  return out;
}

// dist is committed. Build into a temp directory outside the repo and compare it
// with dist/ file by file, so uncommitted work mid-change is fine but a stale
// dist/ is not.
function distInSync() {
  console.log("\n== dist in sync");
  const temp = mkdtempSync(join(tmpdir(), "localdev-dist-"));
  try {
    const build = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--outDir", temp], {cwd: REPO_ROOT, encoding: "utf8"});
    if (build.status !== 0) {
      failures.push("dist in sync (could not build)");
      console.log(build.stdout, build.stderr);
      return;
    }
    const fresh = new Set(filesIn(temp));
    const committed = new Set(existsSync(join(REPO_ROOT, "dist")) ? filesIn(join(REPO_ROOT, "dist")) : []);
    const stale = [];
    for (const file of [...fresh].sort()) {
      if (!committed.has(file)) stale.push(`dist/${file} missing`);
      else if (!readFileSync(join(temp, file)).equals(readFileSync(join(REPO_ROOT, "dist", file)))) stale.push(`dist/${file} differs`);
    }
    for (const file of [...committed].sort()) {
      if (!fresh.has(file)) stale.push(`dist/${file} no longer built from src`);
    }
    if (stale.length > 0) {
      failures.push("dist in sync");
      console.log("  stale files:");
      for (const line of stale.slice(0, SHOWN)) console.log(`    ${line}`);
      if (stale.length > SHOWN) console.log(`    ...and ${stale.length - SHOWN} more`);
      console.log("  run pnpm build and commit dist");
    }
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
}

// Build first, then run the tests one file at a time (AGENTS.md).
function tests() {
  if (!run("build", "pnpm", ["build"])) return;
  const files = readdirSync(join(REPO_ROOT, "test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `test/${name}`);
  run("tests", "node", ["--test", "--test-concurrency=1", ...files]);
}

function knipFindings() {
  const result = spawnSync("pnpm", ["exec", "knip", "--reporter", "json", "--no-progress"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    failures.push("knip (could not read its report)");
    console.log(result.stdout, result.stderr);
    return {};
  }
  const findings = {"knip/unused-files": [], "knip/unused-exports": [], "knip/unused-types": [], "knip/dependencies": [], "knip/other": []};
  const bucket = {files: "knip/unused-files", exports: "knip/unused-exports", types: "knip/unused-types", dependencies: "knip/dependencies", devDependencies: "knip/dependencies", unlisted: "knip/dependencies", binaries: "knip/dependencies"};
  for (const issue of report.issues ?? []) {
    for (const [kind, value] of Object.entries(issue)) {
      if (kind === "file" || !value || typeof value !== "object") continue;
      const items = Array.isArray(value) ? value : Object.values(value).flat();
      for (const item of items) {
        const where = item.line ? `${issue.file}:${item.line}` : issue.file;
        findings[bucket[kind] ?? "knip/other"].push(`${where} ${kind} ${item.name ?? ""}`.trim());
      }
    }
  }
  return findings;
}

function show(rule, lines) {
  console.log(`\n  ${rule}:`);
  for (const line of lines.slice(0, SHOWN)) console.log(`    ${line}`);
  if (lines.length > SHOWN) console.log(`    ...and ${lines.length - SHOWN} more`);
}

function rulesAndRatchet() {
  console.log("\n== strict rules and ratchet");
  const {strict, ratchet} = measureRules();
  Object.assign(ratchet, knipFindings());

  for (const [rule, lines] of Object.entries(strict)) {
    if (lines.length === 0) continue;
    failures.push(`strict rule ${rule}`);
    show(rule, lines);
  }

  const counts = Object.fromEntries(Object.entries(ratchet).map(([rule, lines]) => [rule, lines.length]).sort());
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;

  if (writeMode) {
    const next = {};
    for (const [rule, count] of Object.entries(counts)) {
      next[rule] = baseline && rule in baseline ? Math.min(baseline[rule], count) : count;
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log("Wrote scripts/checks/baseline.json:", next);
    return;
  }
  if (!baseline) {
    failures.push("ratchet (no baseline.json; run with --write once)");
    return;
  }

  for (const [rule, count] of Object.entries(counts)) {
    const allowed = baseline[rule] ?? 0;
    if (count > allowed) {
      failures.push(`ratchet ${rule} rose ${allowed} -> ${count}`);
      show(rule, ratchet[rule]);
    } else if (count < allowed) {
      console.log(`  ${rule} dropped ${allowed} -> ${count}: lower it with \`pnpm check --write\`.`);
    }
  }
  console.log("  counts:", counts);
}

if (!writeMode) {
  typecheck();
  distInSync();
  tests();
}
rulesAndRatchet();

if (failures.length > 0) {
  console.log("\ncheck FAILED:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("\ncheck passed");
