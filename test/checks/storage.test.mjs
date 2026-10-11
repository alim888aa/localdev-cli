import assert from "node:assert/strict";
import test from "node:test";
import { compareSnapshots } from "../../scripts/checks/comparison.mjs";

const header = `import assert from "node:assert/strict";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { readReceipt, reserveSession } from "../../dist/state.js";
import test from "node:test";
`;
const check = (body) => compareSnapshots(new Map(), new Map([["test/example.test.mjs", header + body]]));

for (const [name, body] of [
  ["direct parsed receipt fields", `const r = JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json")));
    assert.equal(r.services[0].readyPort, "web");`],
  ["stored failed state", `const stored = async id => JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json")));
    test("retained failure", async () => { const receipt = await stored(id); assert.equal(receipt.state, "failed"); });`],
  ["stored stopping state", `const receiptFile = id => path.join(root, "sessions", id, "receipt.json");
    const stored = async id => JSON.parse(await readFile(receiptFile(id)));
    const receipt = await stored(id); assert.equal(receipt.state, "stopping");`],
  ["reconstructed directory existence", `const dir = path.join(root, "sessions", first.id);
    const exists = async file => stat(file).then(() => true, () => false);
    assert.equal(await exists(dir), true);`],
  ["rollback folder contents", `assert.deepEqual(await readdir(path.join(root, "sessions")), []);`],
  ["object returned helper", `function world() { const stored = async id => JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json"))); return { stored }; }
    const w = await world(); const receipt = await w.stored(id); assert.equal(receipt.state, "failed");`],
  ["setup value leaking into assertion", `const receipt = JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json")));
    await writeFile(path.join(root, "sessions", id, "receipt.json"), JSON.stringify({ ...receipt, state: "failed" }));
    assert.equal(receipt.state, "ready");`],
  ["named assertion alias", `import { equal as verify } from "node:assert/strict";
    verify(JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json"))).state, "failed");`],
  ["doesNotReject directory callback", `await assert.doesNotReject(async () => stat(path.join(root, "sessions", id)));`],
  ["rejects receipt callback", `await assert.rejects(() => readFile(path.join(root, "sessions", id, "receipt.json")), { code: "ENOENT" });`],
  ["block callback directory probe", `await assert.rejects(async () => { await stat(path.join(root, "sessions", id)); }, { code: "ENOENT" });`],
  ["parenthesized assertion callback", `await assert.rejects((async () => stat(path.join(root, "sessions", id))), { code: "ENOENT" });`],
  ["named assertion callback", `import { rejects as verify } from "node:assert/strict";
    const probe = async () => stat(path.join(root, "sessions", id)); await verify(probe, { code: "ENOENT" });`],
  ["synchronous existence callback", `assert.throws(() => fs.statSync(path.join(root, "sessions", id)));`],
  ["stored state in callback condition", `const receipt = JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json")));
    assert.doesNotThrow(() => { if (receipt.state !== "failed") throw new Error("state"); });`],
]) {
  test(`rejects ${name}`, () => {
    const findings = check(body);
    assert.ok(findings.some((finding) => finding.rule === "test/public-api"), name);
    assert.ok(findings.every((finding) => finding.file === "test/example.test.mjs" && finding.line > 0));
  });
}

for (const [name, body] of [
  ["state exports", `const receipt = await readReceipt(id); assert.equal(receipt.state, "failed");`],
  ["CLI output", `const [receipt] = await run("status", id); assert.equal(receipt.state, "stopping");
    const ready = await run("startup"); assert.equal(ready.state, "ready"); assert.equal((await run("stop", id)).stopped, true);`],
  ["public helper beside storage helper", `function world() {
    const stored = async id => JSON.parse(await readFile(path.join(root, "sessions", id, "receipt.json")));
    const run = async (...args) => JSON.parse((await exec(cli, args)).stdout); return { stored, run }; }
    const w = await world(); const [receipt] = await w.run("status", id); assert.equal(receipt.state, "failed");`],
  ["public cleanup paths", `const ready = await run("startup"); await run("stop", ready.id);
    await assert.rejects(stat(ready.tempDir), { code: "ENOENT" });`],
  ["public cleanup callback", `const ready = await run("startup"); await run("stop", ready.id);
    await assert.rejects(() => stat(ready.tempDir), { code: "ENOENT" });`],
  ["reservation callback cleanup", `let supplied; await reserveSession([], (id, sessionDir) => { supplied = sessionDir; throw new Error("rollback"); });
    await assert.rejects(stat(supplied), { code: "ENOENT" });`],
  ["malformed input setup", `const file = path.join(root, "sessions", id, "receipt.json");
    const receipt = JSON.parse(await readFile(file)); await writeFile(file, JSON.stringify({ ...receipt, state: "failed" }));
    assert.equal((await run("status", id))[0].state, "failed");`],
  ["controlled synchronization", `const file = path.join(root, "sessions", id, "receipt.json");
    await waitUntil(async () => JSON.parse(await readFile(file)).faults.some(f => f.mode === "kill"));
    assert.equal((await run("status", id))[0].state, "stopping");`],
  ["synchronization inside assertion callback", `const file = path.join(root, "sessions", id, "receipt.json");
    await assert.doesNotReject(async () => {
      await waitUntil(async () => JSON.parse(await readFile(file)).faults.some(f => f.mode === "kill"));
      return run("stop", id);
    });`],
  ["malformed setup before public assertion callback", `const file = path.join(root, "sessions", id, "receipt.json");
    const receipt = JSON.parse(await readFile(file)); await writeFile(file, JSON.stringify({ ...receipt, state: "failed" }));
    await assert.rejects(() => run("stop", id), /ownership/);`],
  ["unrelated filesystem data", `assert.equal(await readFile(path.join(ready.dataDir, "seed.txt"), "utf8"), "ready");`],
]) test(`allows ${name}`, () => assert.deepEqual(check(body), []));

test("synchronization values cannot become assertion evidence", () => {
  const findings = check(`const file = path.join(root, "sessions", id, "receipt.json");
    let receipt; await waitUntil(async () => { receipt = JSON.parse(await readFile(file)); return receipt.state === "stopping"; });
    assert.equal(receipt.state, "stopping");`);
  assert.ok(findings.some((finding) => finding.rule === "test/public-api"));
});
