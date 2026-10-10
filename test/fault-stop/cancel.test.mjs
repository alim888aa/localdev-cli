import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "dist/cli.js");
const adapter = path.join(root, "test/faults.adapter.mjs");
const exec = promisify(execFile);

async function waitUntil(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for restart state");
}

function groupAlive(pid) {
  return execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" }).split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && state && !state.startsWith("Z");
  });
}

async function world() {
  const state = await mkdtemp(path.join(os.tmpdir(), "localdev-fault-stop-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const raw = (args, extra = {}) => exec(process.execPath, [cli, ...args], { env: { ...env, ...extra }, cwd: root });
  const run = async (...args) => JSON.parse((await raw(args)).stdout);
  const receiptFile = (id) => path.join(state, "sessions", id, "receipt.json");
  const stored = async (id) => JSON.parse(await readFile(receiptFile(id), "utf8"));
  return { state, env, raw, run, stored, receiptFile, async cleanup() {
    for (const { id } of await run("status")) await run("stop", id);
    await rm(state, { recursive: true, force: true });
  } };
}

async function assertStopped(w, a, replacement) {
  assert.deepEqual(await w.run("status", a.id), [{ id: a.id, state: "gone" }]);
  assert.deepEqual(await w.run("stop", a.id), { id: a.id, stopped: true, alreadyGone: true });
  await assert.rejects(readFile(w.receiptFile(a.id)), { code: "ENOENT" });
  await assert.rejects(stat(a.tempDir), { code: "ENOENT" });
  for (const owned of [...a.processes, ...(replacement ? [replacement] : [])]) {
    assert.equal(groupAlive(owned.pid), false, `${owned.name} group is gone`);
    for (const escaped of owned.escapedGroups ?? []) assert.equal(groupAlive(escaped.pgid), false);
  }
  const leftovers = execFileSync("ps", ["-eo", "stat=,args="], { encoding: "utf8" })
    .split("\n").filter((line) => line.includes(w.state) && !line.trim().startsWith("Z"));
  assert.deepEqual(leftovers, [], "no unrecorded replacement or proxy remains");
}

test("stop wins while kill terminates the original group between ownership reads", { skip: process.platform !== "darwin" }, async () => {
  for (const escaped of [false, true]) {
    const w = await world();
    let kill;
    try {
      const a = escaped
        ? await w.run("startup", "detached", "--adapter", path.join(root, "test/fixture.adapter.mjs"))
        : await w.run("startup", "--adapter", adapter);
      const stored = await w.stored(a.id);
      const api = stored.processes.find((p) => p.name === (escaped ? "app" : "api"));
      if (escaped) assert.ok(api.escapedGroups.length, "the fixture has an escaped service group");
      const bin = path.join(w.state, "bin");
      await mkdir(bin);
      await copyFile(path.join(root, "test/fault-stop/race-ps.mjs"), path.join(bin, "ps"));
      await chmod(path.join(bin, "ps"), 0o755);
      const race = { PATH: `${bin}:${w.env.PATH}`, RACE_PID: String(api.pid), RACE_RECEIPT: w.receiptFile(a.id), RACE_HIT: path.join(w.state, "hit") };
      kill = w.raw(["fault", a.id, escaped ? "testApp" : "proxied", "--mode", "kill"], { ...race, RACE_ROLE: "fault" });
      kill.catch(() => undefined);
      await waitUntil(async () => (await w.run("status", a.id))[0].faults.some((f) => f.mode === "kill" && f.state === "restarting"));
      const stop = await w.raw(["stop", a.id], { ...race, RACE_ROLE: "stop" });
      assert.deepEqual(JSON.parse(stop.stdout), { id: a.id, stopped: true });
      await assert.rejects(kill, (error) => error.code === 1 && /stopped during the kill/.test(error.stderr));
      assert.equal(await readFile(race.RACE_HIT, "utf8"), "ownership read", "the original group disappeared during verification");
      await assertStopped(w, { ...a, processes: stored.processes });
      assert.deepEqual(await w.run("status"), []);
    } finally {
      await kill?.catch(() => undefined);
      await w.cleanup();
    }
  }
});

test("stop wins after a kill records its replacement, before readiness", async () => {
  const w = await world();
  let kill;
  try {
    const a = await w.run("startup", "--adapter", adapter);
    const old = a.processes.find((p) => p.name === "api");
    await writeFile(path.join(a.dataDir, "api", "listen-delay-ms"), "8000");
    kill = w.raw(["fault", a.id, "proxied", "--mode", "kill"]);
    kill.catch(() => undefined);
    let replacement;
    await waitUntil(async () => {
      const receipt = await w.stored(a.id);
      replacement = receipt.processes.find((p) => p.name === "api" && p.pid !== old.pid);
      return replacement && receipt.faults.some((f) => f.mode === "kill");
    });
    assert.deepEqual(await w.run("stop", a.id), { id: a.id, stopped: true });
    await assert.rejects(kill, (error) => error.code === 1 && /stopped/.test(error.stderr));
    await assertStopped(w, a, replacement);
    assert.deepEqual(await w.run("status"), []);
  } finally {
    await kill?.catch(() => undefined);
    await w.cleanup();
  }
});

test("stop retains unverifiable live groups and leaves another session usable", async () => {
  const w = await world();
  let original;
  let a;
  try {
    a = await w.run("startup", "--adapter", adapter);
    const b = await w.run("startup", "--adapter", adapter, "--parallel");
    original = await w.stored(a.id);
    const other = b.processes.find((p) => p.name === "api");
    for (const reused of [false, true]) {
      const forged = structuredClone(original);
      const api = forged.processes.find((p) => p.name === "api");
      if (reused) { api.pid = other.pid; api.guardPid = other.guardPid; }
      api.birth = "unverifiable-birth";
      api.guardBirth = "unverifiable-birth";
      await writeFile(w.receiptFile(a.id), JSON.stringify(forged));
      await assert.rejects(w.run("stop", a.id), /Could not verify ownership of api process group.*kept for inspection/);
      const [failed] = await w.run("status", a.id);
      assert.equal(failed.state, "failed");
      assert.match(failed.error, /Could not verify ownership of api process group/);
      assert.equal(groupAlive(api.pid), true, "the unverifiable live group was not signalled");
      assert.equal(groupAlive(other.pid), true);
      assert.equal((await w.run("status", b.id))[0].state, "ready");
      const response = await fetch(`${b.urls.api}/echo/untouched`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "untouched");
    }
  } finally {
    if (original) await writeFile(w.receiptFile(a.id), JSON.stringify(original));
    await w.cleanup();
  }
});
