import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(root, "dist/cli.js");
const barrier = fileURLToPath(new URL("./barrier.mjs", import.meta.url));

async function world(t) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "localdev-reservation-"));
  const state = path.join(scratch, "state");
  const project = path.join(scratch, "project");
  await cp(path.join(root, "fixtures/base/client-project"), project, { recursive: true });
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const children = [];
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: project, env })).stdout);
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
      await child.done;
    }
    for (const id of await readdir(path.join(state, "sessions")).catch(() => [])) {
      const receipt = await readFile(path.join(state, "sessions", id, "receipt.json"), "utf8")
        .then((raw) => JSON.parse(raw), () => null).catch(() => null);
      if (receipt?.id === id) await run("stop", id);
    }
    await rm(scratch, { recursive: true, force: true });
  });
  function start(mode, ...args) {
    const process = fork(cli, args, { cwd: project, env: { ...env, RESERVATION_BARRIER: mode },
      execArgv: ["--import", barrier], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    const events = new Map();
    const waiters = new Map();
    process.on("message", (message) => {
      events.set(message.event, message);
      waiters.get(message.event)?.(message);
    });
    const done = new Promise((resolve) => process.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
    const child = { process, done, event: (name) => events.has(name) ? Promise.resolve(events.get(name)) :
      Promise.race([new Promise((resolve) => waiters.set(name, resolve)), done.then((result) => {
        throw new Error(`Child exited before ${name}: ${JSON.stringify(result)}`);
      })]) };
    children.push(child);
    return child;
  }
  return { scratch, state, run, start };
}

async function abandoned(world, mode = "pause") {
  const writer = world.start(mode, "startup");
  const { dir } = await writer.event("reserved");
  const session = path.dirname(dir);
  assert.equal((await lstat(dir)).isDirectory(), true);
  await assert.rejects(lstat(path.join(session, "receipt.json")), { code: "ENOENT" });
  writer.process.kill("SIGKILL");
  assert.equal((await writer.done).signal, "SIGKILL");
  return { session, id: path.basename(session) };
}

test("startup reclaims a killed receiptless reservation and preserves another session", { timeout: 30000 }, async (t) => {
  const w = await world(t);
  const other = await w.run("startup");
  const lost = await abandoned({ ...w, start: (mode, ...args) => w.start(mode, ...args, "--parallel") });
  const next = await w.run("startup", "--parallel");
  await assert.rejects(lstat(lost.session), { code: "ENOENT" });
  assert.equal(next.state, "ready");
  assert.deepEqual(await w.run("status", lost.id), [{ id: lost.id, state: "gone" }]);
  assert.equal((await w.run("status", other.id))[0].state, "ready");
  assert.equal((await fetch(other.urls.app)).status, 200);
});

test("exact stop reclaims a killed reservation and remains idempotent", { timeout: 30000 }, async (t) => {
  const w = await world(t);
  const lost = await abandoned(w);
  assert.deepEqual(await w.run("stop", lost.id), { id: lost.id, stopped: true, alreadyGone: true });
  await assert.rejects(lstat(lost.session), { code: "ENOENT" });
  assert.deepEqual(await w.run("stop", lost.id), { id: lost.id, stopped: true, alreadyGone: true });
  assert.deepEqual(await w.run("status", lost.id), [{ id: lost.id, state: "gone" }]);
});

for (const command of ["startup", "stop"]) {
  test(`${command} recovers a writer killed before receipt rename`, { timeout: 30000 }, async (t) => {
    const w = await world(t);
    const lost = await abandoned(w, "pause-write");
    assert.equal((await readdir(lost.session)).some((name) => /^receipt\.json\.\d+\.tmp$/.test(name)), true);
    const result = await w.run(command, ...(command === "stop" ? [lost.id] : []));
    assert.equal(command === "startup" ? result.state : result.stopped, command === "startup" ? "ready" : true);
    await assert.rejects(lstat(lost.session), { code: "ENOENT" });
  });
}

for (const command of ["startup", "stop"]) {
  test(`${command} waits for a live reservation to publish its receipt`, { timeout: 30000 }, async (t) => {
    const w = await world(t);
    const writer = w.start("pause", "startup");
    const { dir } = await writer.event("reserved");
    const id = path.basename(path.dirname(dir));
    const contender = w.start("observe", ...(command === "startup" ? ["startup", "--parallel"] : ["stop", id]));
    await contender.event("waiting");
    assert.equal((await lstat(dir)).isDirectory(), true);
    await assert.rejects(lstat(path.join(path.dirname(dir), "receipt.json")), { code: "ENOENT" });
    writer.process.send("release");
    await writer.event("published");
    const result = await contender.done;
    assert.equal(result.code, 0, result.stderr);
    const published = await writer.done;
    if (command === "startup") assert.equal(published.code, 0, published.stderr);
    else assert.ok(published.code === 0 || /stopped during startup/.test(published.stderr), published.stderr);
  });
}

test("recovery preserves receipts, unrelated paths and symlinks", { timeout: 30000 }, async (t) => {
  const w = await world(t);
  const lost = await abandoned(w);
  const sessions = path.join(w.state, "sessions");
  const failed = await w.run("startup", "seed-fails").catch(() => undefined);
  assert.equal(failed, undefined);
  const failedId = (await readdir(sessions)).find((id) => id !== lost.id);
  const receipt = await readFile(path.join(sessions, failedId, "receipt.json"), "utf8");
  assert.equal(JSON.parse(receipt).state, "failed");
  const outside = path.join(w.scratch, "outside");
  await mkdir(path.join(outside, "data"), { recursive: true });
  await writeFile(path.join(outside, "data/keep"), "safe");
  const protectedIds = ["unrelated", "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000004", "00000000-0000-0000-0000-000000000005"];
  await mkdir(path.join(sessions, protectedIds[0], "data"), { recursive: true });
  await mkdir(path.join(sessions, protectedIds[1], "data"), { recursive: true });
  await writeFile(path.join(sessions, protectedIds[1], "receipt.json"), "malformed");
  await mkdir(path.join(sessions, protectedIds[2], "data"), { recursive: true });
  await mkdir(path.join(sessions, protectedIds[2], "receipt.json"));
  await symlink(outside, path.join(sessions, protectedIds[3]), "dir");
  await mkdir(path.join(sessions, protectedIds[4]));
  await symlink(path.join(outside, "data"), path.join(sessions, protectedIds[4], "data"), "dir");
  await mkdir(path.join(sessions, protectedIds[5], "data"), { recursive: true });
  await symlink(path.join(outside, "missing"), path.join(sessions, protectedIds[5], "receipt.json"));
  const unrelatedId = "00000000-0000-0000-0000-000000000006";
  await mkdir(path.join(sessions, unrelatedId, "data"), { recursive: true });
  await writeFile(path.join(sessions, unrelatedId, "keep"), "unrelated");
  const next = await w.run("startup");
  assert.equal(next.state, "ready");
  await assert.rejects(lstat(lost.session), { code: "ENOENT" });
  await assert.rejects(w.run("stop", protectedIds[0]));
  await assert.rejects(w.run("stop", protectedIds[1]));
  await assert.rejects(w.run("stop", protectedIds[2]));
  for (const id of [...protectedIds.slice(3), unrelatedId]) {
    assert.deepEqual(await w.run("stop", id), { id, stopped: true, alreadyGone: true });
  }
  for (const id of protectedIds) assert.ok(await lstat(path.join(sessions, id)));
  assert.equal(await readFile(path.join(sessions, unrelatedId, "keep"), "utf8"), "unrelated");
  assert.equal(await readFile(path.join(outside, "data/keep"), "utf8"), "safe");
  assert.equal(await readFile(path.join(sessions, failedId, "receipt.json"), "utf8"), receipt);
});

test("exact stop does not follow a symlinked sessions root", { timeout: 30000 }, async (t) => {
  const w = await world(t);
  const outside = path.join(w.scratch, "outside");
  const id = "00000000-0000-0000-0000-000000000007";
  await mkdir(path.join(outside, id, "data"), { recursive: true });
  await mkdir(w.state);
  await symlink(outside, path.join(w.state, "sessions"), "dir");
  assert.deepEqual(await w.run("stop", id), { id, stopped: true, alreadyGone: true });
  assert.equal((await lstat(path.join(outside, id, "data"))).isDirectory(), true);
});

test("startup tolerates a normal stop removing a session during the recovery sweep", { timeout: 30000 }, async (t) => {
  const w = await world(t);
  const first = await w.run("startup");
  const stopping = w.start("pause-remove", "stop", first.id);
  await stopping.event("removing");
  const starting = w.start("pause-scan", "startup");
  await starting.event("scanning");
  stopping.process.send("release");
  assert.equal((await stopping.done).code, 0);
  starting.process.send("release");
  const result = await starting.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "ready");
});
