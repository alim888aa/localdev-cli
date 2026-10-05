import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");
const adapter = path.join(root, "test", "fixture.adapter.mjs");

// A zombie has exited even though kill(pid, 0) still succeeds on it; some sandboxes' PID 1 reaps them slowly.
function running(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== "ESRCH"; } // EPERM: exists, not ours
  try {
    const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return !stat.startsWith("Z");
  } catch { return true; } // If ps can't tell, assume it still runs so a "stopped" assertion can't pass by accident.
}

async function waitUntil(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test condition");
}

test("the liveness helper counts live and stopped processes as running and exited ones as not", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    assert.equal(running(child.pid), true);
    process.kill(child.pid, "SIGSTOP");
    assert.equal(running(child.pid), true, "a stopped process still runs");
    process.kill(child.pid, "SIGCONT");
  } finally {
    child.kill("SIGKILL");
  }
  await new Promise((resolve) => child.once("exit", resolve));
  await waitUntil(() => !running(child.pid));
});

test("concurrent sessions have separate ports/data and stop independently", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-test-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let first;
  let second;
  try {
    [first, second] = await Promise.all([
      run("startup", "--project", root, "--adapter", adapter),
      run("startup", "catalog", "--project", root, "--adapter", adapter),
    ]);
    assert.equal(first.fixture, "base");
    assert.notEqual(first.id, second.id);
    assert.equal(first.state, "ready");
    assert.equal(second.state, "ready");
    assert.equal(first.processes[0].launch, "next dev --turbopack");
    assert.equal(second.processes[0].launch, "vite");
    assert.equal((await run("status", first.id))[0].processes[0].launchMode, "next-turbopack");
    assert.equal((await run("status", second.id))[0].processes[0].launchMode, "vite");
    assert.ok(!JSON.stringify(first).includes("private-test-value"));
    assert.ok(!JSON.stringify(second).includes("private-test-value"));
    assert.equal(new Set([...Object.values(first.ports), ...Object.values(second.ports)]).size, 4);
    assert.notEqual(first.dataDir, second.dataDir);
    assert.equal(await readFile(path.join(first.dataDir, "seed.txt"), "utf8"), "ready\n");
    assert.equal(await readFile(path.join(second.dataDir, "seed.txt"), "utf8"), "ready\n");
    assert.equal((await fetch(first.urls.app)).status, 200);
    assert.equal((await fetch(second.urls.app)).status, 200);
    assert.equal((await run("status")).length, 2);
    await run("stop", first.id);
    assert.equal((await fetch(second.urls.app)).status, 200);
    await run("stop", second.id);
    assert.deepEqual(await run("status"), []);
  } finally {
    if (first) await run("stop", first.id).catch(() => undefined);
    if (second) await run("stop", second.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("duplicate startup requires a choice and replace stops only the selected session", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-duplicate-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let first;
  let parallel;
  let replacement;
  let bareReplacement;
  try {
    first = await run("startup", "base", "--project", root, "--adapter", adapter);
    await assert.rejects(run("startup", "base", "--project", root, "--adapter", adapter), /Existing session/);
    const alias = path.join(state, "same-checkout-alias");
    await symlink(root, alias, "dir");
    await assert.rejects(run("startup", "base", "--project", alias, "--adapter", adapter), /Existing session/);
    assert.equal((await run("status")).length, 1);
    assert.equal((await fetch(first.urls.app)).status, 200);
    parallel = await run("startup", "base", "--parallel", "--project", root, "--adapter", adapter);
    assert.equal((await run("status")).length, 2);
    replacement = await run("startup", "base", "--replace", parallel.id, "--project", root, "--adapter", adapter);
    assert.notEqual(replacement.id, parallel.id);
    assert.equal((await run("status")).length, 2);
    assert.ok(!(await run("status")).some(item => item.id === parallel.id));
    assert.equal(running(parallel.processes[0].pid), false);
    assert.equal((await fetch(first.urls.app)).status, 200);
    assert.equal((await fetch(replacement.urls.app)).status, 200);
    await run("stop", first.id);
    bareReplacement = await run("startup", "base", "--replace", "--project", root, "--adapter", adapter);
    assert.ok(!(await run("status")).some(item => item.id === replacement.id));
    assert.equal(running(replacement.processes[0].pid), false);
    assert.equal((await fetch(bareReplacement.urls.app)).status, 200);
  } finally {
    for (const item of [first, parallel, replacement, bareReplacement]) {
      if (item) await run("stop", item.id).catch(() => undefined);
    }
    await rm(state, { recursive: true, force: true });
  }
});

test("concurrent duplicate startup allocates only one session", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-duplicate-race-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    const results = await Promise.allSettled([
      run("startup", "base", "--project", root, "--adapter", adapter),
      run("startup", "base", "--project", root, "--adapter", adapter),
    ]);
    const completed = results.filter((item) => item.status === "fulfilled");
    assert.equal(completed.length, 1);
    assert.match(String(results.find((item) => item.status === "rejected")?.reason), /Existing session/);
    [receipt] = await run("status");
    assert.equal(receipt.id, completed[0].value.id);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("explicit replacement rejects an unmatched session ID before allocation", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-unmatched-replace-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  try {
    await assert.rejects(run("startup", "base", "--replace", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "--project", root, "--adapter", adapter), /no healthy matching session/);
    assert.deepEqual(await run("status"), []);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("starting receipt with a reused PID does not block startup", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-reused-pid-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  const staleId = "11111111-2222-3333-4444-555555555555";
  let fresh;
  try {
    const staleDir = path.join(state, "sessions", staleId);
    await mkdir(staleDir, { recursive: true });
    await writeFile(path.join(staleDir, "receipt.json"), JSON.stringify({
      id: staleId, fixture: "base", projectRoot: root, commit: null,
      adapterPath: adapter, sessionDir: staleDir, dataDir: path.join(staleDir, "data"),
      ports: {}, urls: {}, processes: [], state: "starting",
      ownerPid: process.pid, ownerBirth: "an earlier process with this PID",
      createdAt: new Date().toISOString(),
    }));
    fresh = await run("startup", "base", "--project", root, "--adapter", adapter);
    assert.equal(fresh.state, "ready");
    assert.notEqual(fresh.id, staleId);
  } finally {
    if (fresh) await run("stop", fresh.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("a dead same-fixture receipt does not block a new startup", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-dead-duplicate-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let dead;
  let fresh;
  try {
    dead = await run("startup", "base", "--project", root, "--adapter", adapter);
    process.kill(-dead.processes[0].pid, "SIGKILL");
    await waitUntil(async () => (await run("status", dead.id))[0].state === "degraded");
    fresh = await run("startup", "base", "--project", root, "--adapter", adapter);
    assert.equal(fresh.state, "ready");
    assert.equal((await fetch(fresh.urls.app)).status, 200);
  } finally {
    for (const item of [dead, fresh]) {
      if (item) await run("stop", item.id).catch(() => undefined);
    }
    await rm(state, { recursive: true, force: true });
  }
});

test("separate projects share one allocator and stop independently", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "local-cli-projects-"));
  const state = path.join(temporary, "state");
  const projects = [path.join(temporary, "one"), path.join(temporary, "two")];
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let first;
  let second;
  try {
    for (const project of projects) {
      await mkdir(project);
      await symlink(path.join(root, "test"), path.join(project, "test"), "dir");
    }
    [first, second] = await Promise.all(projects.map((project) =>
      run("startup", "--project", project, "--adapter", adapter)));
    assert.deepEqual([first.fixture, second.fixture], ["base", "base"]);
    assert.notEqual(first.checkout, second.checkout);
    assert.equal(new Set([...Object.values(first.ports), ...Object.values(second.ports)]).size, 4);
    assert.notEqual(first.dataDir, second.dataDir);
    await run("stop", first.id);
    assert.equal((await fetch(second.urls.app)).status, 200);
    await run("stop", second.id);
    assert.deepEqual(await run("status"), []);
  } finally {
    if (first) await run("stop", first.id).catch(() => undefined);
    if (second) await run("stop", second.id).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("custom launch mode cannot resolve an inherited object property", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-custom-mode-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "custom-mode", "--project", root, "--adapter", adapter);
    assert.equal(receipt.processes[0].launch, "constructor");
    const [later] = await run("status", receipt.id);
    assert.equal(later.processes[0].launch, "constructor");
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop removes only the session's generated directory", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-cleanup-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "cleanup", "--project", root, "--adapter", adapter);
    const generated = path.join(root, `.local-cli-${receipt.id}.build`);
    assert.equal(await readFile(path.join(generated, "generated.txt"), "utf8"), "generated\n");
    await run("stop", receipt.id);
    await assert.rejects(readFile(path.join(generated, "generated.txt"), "utf8"));
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop removes generated files after startup dies inside createSession", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-setup-crash-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  const startup = spawn(process.execPath, [cli, "startup", "slowsetup", "--project", root, "--adapter", adapter], {
    env, cwd: root, stdio: "ignore",
  });
  let receipt;
  try {
    receipt = await waitUntil(async () => {
      const sessions = await run("status");
      const item = sessions.find((session) => session.fixture === "slowsetup");
      if (!item) return null;
      const generated = path.join(root, `.local-cli-${item.id}.build`, "generated.txt");
      try { await readFile(generated, "utf8"); return item; }
      catch { return null; }
    });
    process.kill(startup.pid, "SIGKILL");
    await new Promise((resolve) => startup.once("exit", resolve));
    await run("stop", receipt.id);
    await assert.rejects(readFile(path.join(root, `.local-cli-${receipt.id}.build`, "generated.txt"), "utf8"));
    assert.deepEqual(await run("status"), []);
  } finally {
    if (startup.exitCode === null) startup.kill("SIGKILL");
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("a partial startup stops its first service and leaves a failed receipt", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-fail-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  try {
    const started = Date.now();
    await assert.rejects(run("startup", "broken", "--project", root, "--adapter", adapter), /broken command exited \(code 1\).*log:/);
    assert.ok(Date.now() - started < 4000, "a failed command should not wait for the five-second readiness timeout");
    const [receipt] = await run("status");
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.processes[0].alive, false);
    await run("stop", receipt.id);
    assert.deepEqual(await readdir(path.join(state, "sessions")), []);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("stopping a waiting startup reports cancellation and leaves no receipt", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-stop-starting-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  const starting = exec(process.execPath, [cli, "startup", "neverready", "--project", root, "--adapter", adapter], { env, cwd: root });
  starting.catch(() => undefined);
  let id;
  try {
    id = await waitUntil(async () => {
      const sessions = await run("status");
      return sessions.find((item) => item.fixture === "neverready" && item.processes.length)?.id;
    });
    await run("stop", id);
    await assert.rejects(starting, /was stopped during startup/);
    assert.deepEqual(await run("status"), []);
  } finally {
    if (id) await run("stop", id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("a timed-out seed fails startup and is stopped", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-seed-timeout-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    await assert.rejects(run("startup", "timedseed", "--project", root, "--adapter", adapter), /timed out/);
    [receipt] = await run("status");
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.processes.find((item) => item.name === "seed").alive, false);
    const seedPid = Number(await readFile(path.join(receipt.dataDir, "seed.pid"), "utf8"));
    await waitUntil(() => {
      return !running(seedPid);
    });
    await run("stop", receipt.id);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop clears a session whose service has already died", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-stale-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "messages", "--project", root, "--adapter", adapter);
    process.kill(-receipt.processes[0].pid, "SIGKILL");
    const stale = await waitUntil(async () => {
      const [item] = await run("status", receipt.id);
      return item.processes[0].alive ? null : item;
    });
    assert.equal(stale.processes[0].alive, false);
    await run("stop", receipt.id);
    assert.deepEqual(await run("status"), []);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("status for a stopped or unknown session reports it as gone", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-status-gone-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "--project", root, "--adapter", adapter);
    await run("stop", receipt.id);
    assert.deepEqual(await run("status", receipt.id), [{ id: receipt.id, state: "gone" }]);
    const unknown = "00000000-0000-4000-8000-000000000000";
    assert.deepEqual(await run("status", unknown), [{ id: unknown, state: "gone" }]);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

// A paused server accepts the connection but never answers, so only a short client timeout ends the request.
async function answers(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).status === 200; }
  catch (error) {
    if (error.name === "TimeoutError") return false;
    throw error;
  }
}

function processState(pid) {
  return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

test("fault pause freezes one session's service until cleared and leaves another session running", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-fault-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let first;
  let second;
  try {
    first = await run("startup", "--project", root, "--adapter", adapter);
    second = await run("startup", "catalog", "--project", root, "--adapter", adapter);
    assert.deepEqual((await run("status", first.id))[0].faults, []);
    await assert.rejects(run("fault", first.id, "--clear"), /No active faults/);
    await assert.rejects(run("fault", first.id, "app", "--clear"), /No active fault on app/);

    const { fault } = await run("fault", first.id, "app", "--mode", "pause");
    assert.equal(fault.port, "app");
    assert.equal(fault.mode, "pause");
    assert.ok(fault.pids.length >= 1);
    for (const { pid } of fault.pids) assert.ok(processState(pid).startsWith("T"), "the listener is stopped");
    assert.ok(!fault.pids.some(({ pid }) => pid === first.processes[0].pid), "the supervisor is not paused");
    assert.equal(await answers(first.urls.app), false, "requests to the paused service time out");
    assert.equal(await answers(second.urls.app), true, "another session is unaffected");

    const [paused] = await run("status", first.id);
    assert.equal(paused.state, "ready");
    assert.equal(paused.faults.length, 1);
    assert.equal(paused.faults[0].port, "app");
    assert.deepEqual((await run("status", second.id))[0].faults, []);

    await assert.rejects(run("fault", first.id, "app", "--mode", "pause"), /already paused/);
    await assert.rejects(run("fault", first.id, "nope", "--mode", "pause"), /Unknown port nope/);
    await assert.rejects(run("fault", first.id, "app", "--mode", "reject"), /Unsupported fault mode reject/);
    await assert.rejects(run("fault", first.id, "app", "--mode", "pause", "--clear"), /Choose one of --mode, --release or --clear/);
    await assert.rejects(run("fault", "00000000-0000-4000-8000-000000000000", "app", "--mode", "pause"), /No session/);
    // The fixture declares a secondary port that nothing listens on in the base fixture.
    await assert.rejects(run("fault", first.id, "secondary", "--mode", "pause"), /No listener owned/);

    const { cleared } = await run("fault", first.id, "app", "--clear");
    assert.deepEqual(cleared.map((item) => item.port), ["app"]);
    assert.deepEqual(cleared[0].resumed, fault.pids.map(({ pid }) => pid));
    assert.equal(await answers(first.urls.app), true, "the cleared service answers again");
    assert.deepEqual((await run("status", first.id))[0].faults, []);
    await assert.rejects(run("fault", first.id, "app", "--clear"), /No active fault on app/);

    await run("fault", first.id, "app", "--mode", "pause");
    assert.equal((await run("fault", first.id, "--clear")).cleared.length, 1, "clear without a port clears all");
    assert.equal(await answers(first.urls.app), true);
  } finally {
    if (first) await run("stop", first.id).catch(() => undefined);
    if (second) await run("stop", second.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop while a service is paused finishes promptly and leaves no processes", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-fault-stop-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "--project", root, "--adapter", adapter);
    const { fault } = await run("fault", receipt.id, "app", "--mode", "pause");
    const started = Date.now();
    await run("stop", receipt.id);
    // Without resuming first, SIGTERM stays pending on the frozen server until the 4 s SIGKILL fallback.
    assert.ok(Date.now() - started < 3000, `stop took ${Date.now() - started} ms`);
    for (const { pid } of fault.pids) assert.equal(running(pid), false);
    assert.equal(running(receipt.processes[0].pid), false);
    assert.equal(running(receipt.processes[0].guardPid), false);
    assert.deepEqual(await run("status"), []);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("fault and stop wait for the allocation lock, and a racing pause never outlives stop", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-fault-lock-"));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve));
  const lockPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state, LOCAL_CLI_LOCK_PORT: String(lockPort) };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  const spawnCli = (...args) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    return { child, exited };
  };
  const holder = net.createServer();
  let receipt;
  let pause;
  let stop;
  try {
    receipt = await run("startup", "--project", root, "--adapter", adapter);
    await new Promise((resolve) => holder.listen({ host: "127.0.0.1", port: lockPort, exclusive: true }, resolve));
    pause = spawnCli("fault", receipt.id, "app", "--mode", "pause");
    stop = spawnCli("stop", receipt.id);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(pause.child.exitCode, null, "fault waits for the lock");
    assert.equal(stop.child.exitCode, null, "stop waits for the lock");
    const held = (await run("status", receipt.id))[0];
    assert.equal(held.state, "ready", "nothing was written while the lock was held");
    assert.deepEqual(held.faults, []);
    await new Promise((resolve) => holder.close(resolve));
    const released = Date.now();
    const [pauseCode, stopCode] = await Promise.all([pause.exited, stop.exited]);
    assert.equal(stopCode, 0);
    // Either order is valid: a pause that ran first is resumed by stop; one that ran second finds the session stopping.
    assert.ok(pauseCode === 0 || pauseCode === 1, `fault exited ${pauseCode}`);
    assert.ok(Date.now() - released < 3000, `stop took ${Date.now() - released} ms after the lock was released`);
    assert.deepEqual(await run("status"), []);
    const leftovers = execFileSync("ps", ["-eo", "stat=,args="], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes(state) && !line.trim().startsWith("Z"));
    assert.deepEqual(leftovers, [], "no session process is left running or stopped");
  } finally {
    holder.close();
    pause?.child.kill();
    stop?.child.kill();
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("fault refuses to pause an unrelated listener on the session port", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-fault-intruder-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  let intruder;
  try {
    receipt = await run("startup", "messages", "--project", root, "--adapter", adapter);
    const service = receipt.processes[0];
    const serverPid = execFileSync("pgrep", ["-P", String(service.pid)], { encoding: "utf8" })
      .trim().split(/\s+/).map(Number).find((pid) => pid !== service.guardPid);
    assert.ok(serverPid);
    process.kill(serverPid, "SIGKILL");
    await waitUntil(async () => (await run("status", receipt.id))[0].state === "degraded");
    intruder = spawn(process.execPath, [path.join(root, "test", "server.mjs"), String(receipt.ports.app), "intruder"], {
      cwd: root, stdio: "ignore",
    });
    await waitUntil(async () => {
      try { return (await (await fetch(receipt.urls.app)).text()) === "intruder"; }
      catch { return false; }
    });
    await assert.rejects(run("fault", receipt.id, "app", "--mode", "pause"), /No listener owned/);
    assert.ok(!processState(intruder.pid).startsWith("T"), "the unrelated server was not paused");
    assert.equal(await answers(receipt.urls.app), true);
  } finally {
    if (intruder) intruder.kill("SIGKILL");
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop kills a server whose launcher exited", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-launcher-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "launcher", "--project", root, "--adapter", adapter);
    assert.equal((await fetch(receipt.urls.app)).status, 200);
    await run("stop", receipt.id);
    await assert.rejects(fetch(receipt.urls.app));
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop kills a server that moved into its own process group while its launcher lives", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-detached-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "detached", "--project", root, "--adapter", adapter);
    assert.equal((await fetch(receipt.urls.app)).status, 200);
    await run("stop", receipt.id);
    await assert.rejects(fetch(receipt.urls.app), "the detached server is stopped too");
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop kills an escaped server group after the process that created the group exits, with or without a seed", async () => {
  for (const fixture of ["escaped-anchor", "escaped-anchor-noseed"]) await escapedAnchorStops(fixture);
});

async function escapedAnchorStops(fixture) {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-anchor-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", fixture, "--project", root, "--adapter", adapter);
    assert.equal((await fetch(receipt.urls.app)).status, 200);
    // The anchor created the escaped group (its PID is the group ID) and exits once the server is up; wait for that
    // instead of a fixed delay, so stop is tested only after ancestry can no longer find the server.
    const stored = JSON.parse(await readFile(path.join(state, "sessions", receipt.id, "receipt.json"), "utf8"));
    const anchor = stored.processes.flatMap((item) => item.escapedGroups ?? []).map((group) => group.pgid)[0];
    assert.ok(anchor, "startup recorded the escaped group");
    await waitUntil(() => !running(anchor));
    assert.equal((await fetch(receipt.urls.app)).status, 200);
    await run("stop", receipt.id);
    await assert.rejects(fetch(receipt.urls.app), `the server in the anchorless group is stopped too (${fixture})`);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
}

test("stop kills a non-listening helper that escaped the session group after readiness", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-late-escape-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "late-escape", "--project", root, "--adapter", adapter);
    const helper = Number(await waitUntil(() => readFile(path.join(receipt.dataDir, "helper.pid"), "utf8").catch(() => null)));
    const alive = running;
    assert.ok(alive(helper));
    await run("stop", receipt.id);
    assert.ok(!alive(helper), "the late escaped helper is stopped");
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("a lock held by a live owner is never taken, and is reclaimed once that owner is gone", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-live-lock-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  let startup;
  try {
    const lock = path.join(state, "allocation.lock");
    await mkdir(lock);
    // An old timestamp: only the owner's liveness protects this lock.
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: owner.pid, time: Date.now() - 60_000, token: "other" }));
    let output = "";
    startup = spawn(process.execPath, [cli, "startup", "--project", root, "--adapter", adapter], { env, cwd: root });
    startup.stdout.on("data", (chunk) => { output += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(startup.exitCode, null, "startup waits while the lock owner is alive");
    assert.equal(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token, "other");
    owner.kill();
    const code = await new Promise((resolve) => startup.once("exit", resolve));
    assert.equal(code, 0);
    const receipt = JSON.parse(output);
    assert.equal(receipt.state, "ready");
    await exec(process.execPath, [cli, "stop", receipt.id], { env, cwd: root });
  } finally {
    owner.kill();
    startup?.kill();
    await rm(state, { recursive: true, force: true });
  }
});

test("startup waits while another process holds the allocation port lock, then proceeds", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-port-lock-"));
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state, LOCAL_CLI_LOCK_PORT: String(holder.address().port) };
  let startup;
  try {
    let output = "";
    startup = spawn(process.execPath, [cli, "startup", "--project", root, "--adapter", adapter], { env, cwd: root });
    startup.stdout.on("data", (chunk) => { output += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(startup.exitCode, null, "startup waits while the lock port is held");
    await new Promise((resolve) => holder.close(resolve));
    assert.equal(await new Promise((resolve) => startup.once("exit", resolve)), 0);
    const receipt = JSON.parse(output);
    assert.equal(receipt.state, "ready");
    await exec(process.execPath, [cli, "stop", receipt.id], { env, cwd: root });
  } finally {
    holder.close();
    startup?.kill();
    await rm(state, { recursive: true, force: true });
  }
});

test("a lock abandoned before its owner file was written does not block startup", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-stale-lock-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    const lock = path.join(state, "allocation.lock");
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    receipt = await run("startup", "--project", root, "--adapter", adapter);
    assert.equal(receipt.state, "ready");
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop kills an in-flight seed after startup is killed", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-seed-crash-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  const startup = spawn(process.execPath, [cli, "startup", "slowseed", "--project", root, "--adapter", adapter], {
    env, cwd: root, stdio: "ignore",
  });
  let receipt;
  try {
    receipt = await waitUntil(async () => {
      const sessions = await run("status");
      return sessions.find((item) => item.fixture === "slowseed" && item.processes.some((item) => item.name === "seed"));
    });
    const seedPid = Number(await waitUntil(async () => {
      try { return await readFile(path.join(receipt.dataDir, "seed.pid"), "utf8"); }
      catch { return null; }
    }));
    process.kill(startup.pid, "SIGKILL");
    await new Promise((resolve) => startup.once("exit", resolve));
    await run("stop", receipt.id);
    await waitUntil(() => {
      return !running(seedPid);
    });
    assert.deepEqual(await run("status"), []);
  } finally {
    if (startup.exitCode === null) startup.kill("SIGKILL");
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("stop kills the server group after its supervisor is killed", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-supervisor-crash-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "messages", "--project", root, "--adapter", adapter);
    assert.equal((await fetch(receipt.urls.app)).status, 200);
    process.kill(receipt.processes[0].pid, "SIGKILL");
    await waitUntil(async () => {
      const [item] = await run("status", receipt.id);
      return item.processes[0].alive && item.processes[0].reachable ? item : null;
    });
    await run("stop", receipt.id);
    await assert.rejects(fetch(receipt.urls.app));
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("status reports degraded when the server child dies", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-server-crash-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  try {
    receipt = await run("startup", "messages", "--project", root, "--adapter", adapter);
    const supervisorPid = receipt.processes[0].pid;
    const guardPid = receipt.processes[0].guardPid;
    const children = execFileSync("pgrep", ["-P", String(supervisorPid)], { encoding: "utf8" })
      .trim().split(/\s+/).map(Number);
    const serverPid = children.find((pid) => pid !== guardPid);
    assert.ok(serverPid);
    process.kill(serverPid, "SIGKILL");
    const [degraded] = await waitUntil(async () => {
      const [item] = await run("status", receipt.id);
      return item.state === "degraded" ? [item] : null;
    });
    assert.equal(degraded.processes[0].reachable, false);
    assert.equal(degraded.processes[0].alive, false);
    assert.equal(degraded.processes[0].groupOwned, true);
    assert.ok(degraded.processes[0].commandExit);
    await run("stop", receipt.id);
  } finally {
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});

test("status rejects an unrelated listener that takes the session port", async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-port-takeover-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  let receipt;
  let intruder;
  try {
    receipt = await run("startup", "messages", "--project", root, "--adapter", adapter);
    const service = receipt.processes[0];
    const children = execFileSync("pgrep", ["-P", String(service.pid)], { encoding: "utf8" })
      .trim().split(/\s+/).map(Number);
    const serverPid = children.find((pid) => pid !== service.guardPid);
    assert.ok(serverPid);
    process.kill(serverPid, "SIGKILL");
    await waitUntil(async () => {
      const [item] = await run("status", receipt.id);
      return item.state === "degraded" ? item : null;
    });
    intruder = spawn(process.execPath, [path.join(root, "test", "server.mjs"), String(service.readyPort ?? receipt.ports.app), "intruder"], {
      cwd: root, stdio: "ignore",
    });
    await waitUntil(async () => {
      try { return (await (await fetch(receipt.urls.app)).text()) === "intruder"; }
      catch { return false; }
    });
    const [status] = await run("status", receipt.id);
    assert.equal(status.state, "degraded");
    assert.equal(status.processes[0].reachable, true);
    assert.equal(status.processes[0].listenerOwned, false);
    assert.equal(status.processes[0].alive, false);
    await run("stop", receipt.id);
    assert.equal(await (await fetch(receipt.urls.app)).text(), "intruder");
  } finally {
    if (intruder) intruder.kill("SIGKILL");
    if (receipt) await run("stop", receipt.id).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
});
