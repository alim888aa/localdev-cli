import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");
const adapter = path.join(root, "test", "fixture.adapter.mjs");

async function waitUntil(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test condition");
}

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
    await assert.rejects(fetch(parallel.urls.app));
    assert.equal((await fetch(first.urls.app)).status, 200);
    assert.equal((await fetch(replacement.urls.app)).status, 200);
    await run("stop", first.id);
    bareReplacement = await run("startup", "base", "--replace", "--project", root, "--adapter", adapter);
    await assert.rejects(fetch(replacement.urls.app));
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
    await assert.rejects(run("startup", "broken", "--project", root, "--adapter", adapter));
    const [receipt] = await run("status");
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.processes[0].alive, false);
    await run("stop", receipt.id);
    assert.deepEqual(await readdir(path.join(state, "sessions")), []);
  } finally {
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
      try { process.kill(seedPid, 0); return false; }
      catch { return true; }
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
      try { process.kill(seedPid, 0); return false; } catch { return true; }
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
