import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareSnapshots, readComparison } from "../../scripts/checks/comparison.mjs";

const files = (entries) => new Map(Object.entries(entries));
const compare = (after, before = {}) => compareSnapshots(files(before), files(after));

test("direction resolves emitted JS paths to TypeScript owners", () => {
  const after = { "src/state.ts": `import { startSession } from "./session.js";`, "src/session.ts": "export const startSession = () => {};" };
  assert.equal(compare(after)[0].rule, "imports/direction");
  assert.deepEqual(compare({ ...after, "src/state.ts": "", "src/session.ts": `import "./state.js";` }), []);
});

for (const syntax of [`import "./guard.js";`, `export * from "./guard.js";`, `await import("./guard.js");`, `require("./guard.js");`,
  `import guard = require("./guard.js");`, `type Guard = import("./guard.js").Guard;`]) {
  test(`process entry fails for ${syntax}`, () => {
    const found = compare({ "src/session.ts": syntax, "src/guard.ts": "" });
    assert.ok(found.some((finding) => finding.rule === "imports/process-entry" && finding.line === 1));
  });
}

test("built process entries cannot be imported by tests", () => {
  assert.equal(compare({ "test/example.mjs": `import "../dist/supervisor.js";`, "src/supervisor.ts": "" })[0].rule, "imports/process-entry");
});

test("cycles resolve JS, MJS, TypeScript, directory imports and re-exports", () => {
  const after = { "scripts/a.mjs": `import "./group";`, "scripts/group/index.ts": `export * from "../b.js";`,
    "scripts/b.ts": `import "./a.mjs";` };
  assert.equal(compare(after).filter((finding) => finding.rule === "imports/cycle").length, 3);
  assert.deepEqual(compare({ ...after, "scripts/b.ts": "" }), []);
  assert.deepEqual(compare(after, after), []);
  const base = { ...after, "scripts/b.ts": "" };
  assert.ok(compare(after, base).some((finding) => finding.rule === "imports/cycle"));
});

const folder = (name, count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${name}/file-${i}.mjs`, ""]));
test("folder debt cannot grow; purpose subfolders and excluded generated files pass", () => {
  const before = folder("test", 12);
  assert.deepEqual(compare(before, before), []);
  assert.equal(compare(folder("test", 13), before)[0].rule, "size/folder-files");
  assert.equal(compare(folder("new", 11))[0].file, "new");
  assert.deepEqual(compare({ ...before, ...folder("test/checks", 3), ...folder("dist", 20),
    ...folder("node_modules/pkg", 20), ...folder(".scratch/build", 20) }, before), []);
});

test("removing old debt cannot cancel a different or duplicate finding", () => {
  const old = `import assert from "node:assert/strict";
    test("old", () => assert.ok(fs.existsSync(path.join(root, "sessions", id))));`;
  const before = { "test/old.mjs": old };
  assert.deepEqual(compare(before, before), []);
  assert.equal(compare({ "test/new.mjs": old }, before).length, 1);
  assert.equal(compare({ "test/old.mjs": old.replace('"old"', '"new"') }, before).length, 1);
  assert.equal(compare({ "test/old.mjs": old + old.slice(old.indexOf("test(")) }, before).length, 1);
  assert.equal(compare({ "test/old.mjs": old.replace("assert.ok", "assert.equal") }, before).length, 1);
});

test("unchanged upward-import debt cannot cancel a new upward edge", () => {
  const before = { "src/state.ts": `import "./session.js";`, "src/session.ts": "", "src/supervised.ts": "" };
  const after = { ...before, "src/state.ts": "", "src/supervised.ts": `import "./session.js";` };
  assert.equal(compare(after, before).filter((finding) => finding.rule === "imports/direction").length, 1);
});

test("required base and merge-base are explicit; missing base fails with an action", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "localdev-check-base-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q"); git("config", "user.name", "Checker"); git("config", "user.email", "checker@example.invalid");
    mkdirSync(path.join(root, "src")); writeFileSync(path.join(root, "src/state.ts"), "");
    git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    git("branch", "selected"); writeFileSync(path.join(root, "src/state.ts"), "export const changed = true;");
    git("commit", "-qam", "head");
    writeFileSync(path.join(root, "src/new.ts"), "export const untracked = true;");
    const result = readComparison(root, "selected");
    assert.equal(result.base, base); assert.equal(result.head, git("rev-parse", "HEAD"));
    assert.equal(result.before.get("src/state.ts"), "");
    assert.ok(result.after.has("src/new.ts"));
    assert.throws(() => readComparison(root, "missing"), /Fetch the required base or pass --base/);
    assert.throws(() => readComparison(path.join(root, "missing"), "selected"), /Checker base unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
