import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");
const faultsAdapter = path.join(root, "test", "faults.adapter.mjs");
const plainAdapter = path.join(root, "test", "fixture.adapter.mjs");

// Every wait in this file is on observable state (status, a response, a process); none sleeps for a fixed time.
async function waitUntil(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for test condition");
}

async function session(prefix, { longStateDir = false } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), prefix));
  // A state dir this long puts proxy.sock's absolute path past macOS's 104-byte socket path limit.
  const state = longStateDir ? path.join(temporary, "s".repeat(80)) : temporary;
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const started = [];
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env, cwd: root });
    return JSON.parse(stdout);
  };
  const spawnCli = (...args) => {
    const child = spawn(process.execPath, [cli, ...args], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
    return { child, exited };
  };
  const start = async (...args) => {
    const receipt = await run("startup", ...args);
    started.push(receipt.id);
    return receipt;
  };
  const statusOf = async (id) => (await run("status", id))[0];
  const cleanup = async () => {
    for (const id of started) await run("stop", id).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  };
  return { state, temporary, run, spawnCli, start, statusOf, cleanup };
}

async function text(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return response.text();
}

/** One HTTP/1.0 exchange over a raw TCP connection, for the proxy's TCP unit. */
function tcpGet(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let data = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`GET ${target} HTTP/1.0\r\n\r\n`));
    socket.on("data", (chunk) => { data += chunk; });
    socket.once("error", reject);
    socket.once("close", () => data ? resolve(data.slice(data.indexOf("\r\n\r\n") + 4)) : reject(new Error("closed without a response")));
  });
}

function settledFlag(promise) {
  const flag = { settled: false };
  promise.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function groupAlive(pgid) {
  return execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" }).split("\n").some((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && Boolean(stat) && !stat.startsWith("Z");
  });
}

const proxyOf = (receipt) => receipt.processes.find((item) => item.role === "proxy");
const processNamed = (receipt, name) => receipt.processes.find((item) => item.name === name);

test("an adapter without proxyPorts gets no fault proxy and unchanged ports", async () => {
  const { start, run, cleanup } = await session("localdev-noproxy-");
  try {
    const receipt = await start("--project", root, "--adapter", plainAdapter);
    assert.deepEqual(receipt.processes.map((item) => item.name), ["app"]);
    assert.equal(proxyOf(receipt), undefined);
    assert.deepEqual(receipt.proxiedPorts, {});
    await assert.rejects(run("fault", receipt.id, "app", "--mode", "fail"), /not proxied/);
  } finally {
    await cleanup();
  }
});

test("fail, slow and hold affect only the named session and port", async () => {
  const { temporary, start, run, statusOf, cleanup } = await session("localdev-faults-");
  try {
    const other = path.join(temporary, "other-project");
    await mkdir(other);
    await symlink(path.join(root, "test"), path.join(other, "test"), "dir");
    const a = await start("--project", root, "--adapter", faultsAdapter);
    const b = await start("--parallel", "--project", root, "--adapter", faultsAdapter);
    const c = await start("--project", other, "--adapter", faultsAdapter);
    assert.equal(proxyOf(a).name, "localdev-proxy");
    assert.deepEqual(a.proxiedPorts, { proxied: "request", raw: "connection" });
    assert.ok(!JSON.stringify(a).includes("private-test-value"), "service env stays out of status");
    assert.equal(new Set([a, b, c].flatMap((item) => Object.values(item.ports))).size, 9);

    const unaffected = async () => {
      assert.equal(await text(`${a.urls.app}/echo/app`), "app");
      assert.equal(await tcpGet(a.ports.raw, "/echo/raw"), "raw");
      for (const item of [b, c]) {
        assert.equal(await text(`${item.urls.api}/echo/other`), "other");
        assert.equal(await tcpGet(item.ports.raw, "/echo/other"), "other");
        assert.deepEqual((await statusOf(item.id)).faults, []);
      }
    };

    const failed = (await run("fault", a.id, "proxied", "--mode", "fail")).fault;
    assert.deepEqual([failed.mode, failed.unit, failed.remaining], ["fail", "request", null]);
    await assert.rejects(fetch(`${a.urls.api}/echo/x`));
    await unaffected();
    await run("fault", a.id, "proxied", "--clear");
    assert.equal(await text(`${a.urls.api}/echo/back`), "back");

    await run("fault", a.id, "proxied", "--mode", "slow", "--ms", "400");
    const before = Date.now();
    assert.equal(await text(`${a.urls.api}/echo/slow`), "slow");
    assert.ok(Date.now() - before >= 400, "the request was delayed");
    await unaffected();
    assert.deepEqual((await statusOf(a.id)).faults.map(({ mode, ms }) => [mode, ms]), [["slow", 400]]);
    await run("fault", a.id, "proxied", "--clear");

    await run("fault", a.id, "proxied", "--mode", "hold");
    const held = fetch(`${a.urls.api}/echo/held`, { signal: AbortSignal.timeout(20_000) });
    await waitUntil(async () => (await statusOf(a.id)).faults[0]?.held === 1);
    await unaffected();
    const { cleared } = await run("fault", a.id, "proxied", "--clear");
    assert.deepEqual(cleared.map(({ mode, released }) => [mode, released]), [["hold", 1]]);
    assert.equal(await (await held).text(), "held", "clear lets the held request through");
    assert.deepEqual((await statusOf(a.id)).faults, []);
  } finally {
    await cleanup();
  }
});

test("--count clears a fault after that many requests or connections", async () => {
  const { start, run, statusOf, cleanup } = await session("localdev-count-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    const { fault } = await run("fault", a.id, "proxied", "--mode", "fail", "--count", "2");
    assert.deepEqual([fault.unit, fault.remaining], ["request", 2]);
    await assert.rejects(fetch(`${a.urls.api}/echo/1`));
    assert.equal((await statusOf(a.id)).faults[0].remaining, 1);
    await assert.rejects(fetch(`${a.urls.api}/echo/2`));
    assert.deepEqual((await statusOf(a.id)).faults, [], "the fault cleared itself");
    assert.equal(await text(`${a.urls.api}/echo/3`), "3");

    const raw = (await run("fault", a.id, "raw", "--mode", "fail", "--count", "1")).fault;
    assert.deepEqual([raw.unit, raw.remaining], ["connection", 1]);
    await assert.rejects(tcpGet(a.ports.raw, "/echo/refused"));
    assert.equal(await tcpGet(a.ports.raw, "/echo/after"), "after");
    assert.deepEqual((await statusOf(a.id)).faults, []);
  } finally {
    await cleanup();
  }
});

test("hold parks requests and --release lets them through one at a time in arrival order", async () => {
  const { start, run, statusOf, cleanup } = await session("localdev-hold-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    await assert.rejects(run("fault", a.id, "proxied", "--release"), /no hold fault/);
    await run("fault", a.id, "proxied", "--mode", "hold");
    const requests = [];
    for (const label of ["1", "2", "3"]) {
      requests.push(fetch(`${a.urls.api}/echo/${label}`, { signal: AbortSignal.timeout(20_000) }).then((response) => response.text()));
      await waitUntil(async () => (await statusOf(a.id)).faults[0].held === requests.length);
    }
    const flags = requests.map(settledFlag);
    assert.deepEqual(await run("fault", a.id, "proxied", "--release", "--count", "1"), { id: a.id, port: "proxied", released: 1, held: 2 });
    assert.equal(await requests[0], "1");
    await statusOf(a.id);
    assert.deepEqual(flags.map((flag) => flag.settled), [true, false, false], "only the oldest went through");
    await run("fault", a.id, "proxied", "--release", "--count", "1");
    assert.equal(await requests[1], "2");
    await statusOf(a.id);
    assert.equal(flags[2].settled, false);
    assert.equal((await run("fault", a.id, "proxied", "--release")).released, 1);
    assert.equal(await requests[2], "3");
    const [kept] = (await statusOf(a.id)).faults;
    assert.deepEqual([kept.mode, kept.held, kept.remaining], ["hold", 0, null], "hold stays until cleared");
    await run("fault", a.id, "proxied", "--clear");

    await run("fault", a.id, "proxied", "--mode", "hold", "--count", "1");
    const first = fetch(`${a.urls.api}/echo/first`, { signal: AbortSignal.timeout(20_000) }).then((response) => response.text());
    await waitUntil(async () => (await statusOf(a.id)).faults[0]?.held === 1);
    assert.equal(await text(`${a.urls.api}/echo/second`), "second", "the count was used up, so the next request passes");
    const [spent] = (await statusOf(a.id)).faults;
    assert.deepEqual([spent.mode, spent.remaining, spent.held], ["hold", 0, 1]);
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "fail"), /still holds 1 requests/);
    await run("fault", a.id, "proxied", "--release");
    assert.equal(await first, "first");
    assert.deepEqual((await statusOf(a.id)).faults, []);
  } finally {
    await cleanup();
  }
});

test("kill restarts the service with its data, healthy, without touching another session", async () => {
  const { start, run, statusOf, cleanup } = await session("localdev-kill-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    const b = await start("--parallel", "--project", root, "--adapter", faultsAdapter);
    assert.equal(await text(`${a.urls.api}/data`, { method: "PUT", body: "kept" }), "stored");
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "kill", "--count", "1"), /--count applies to fail, slow and hold/);

    const { fault } = await run("fault", a.id, "proxied", "--mode", "kill");
    assert.equal(fault.service, "api");
    assert.equal(fault.oldPid, processNamed(a, "api").pid);
    assert.notEqual(fault.pid, fault.oldPid);
    assert.equal(groupAlive(fault.oldPid), false, "the old service is gone");
    assert.equal(await text(`${a.urls.api}/data`), "kept", "data survives the kill");
    const after = await statusOf(a.id);
    assert.equal(after.state, "ready");
    assert.ok(after.processes.every((item) => item.alive), "every process is healthy");
    assert.equal(processNamed(after, "api").pid, fault.pid);
    assert.deepEqual(after.faults, []);
    assert.ok(!JSON.stringify(after).includes("private-test-value"), "the stored spec env stays out of status");
    assert.equal((await stat(path.join(path.dirname(a.dataDir), "receipt.json"))).mode & 0o777, 0o600);
    assert.equal(processNamed(await statusOf(b.id), "api").pid, processNamed(b, "api").pid, "the other session is untouched");
    assert.equal(await text(`${b.urls.api}/echo/b`), "b");

    const unproxied = (await run("fault", a.id, "app", "--mode", "kill")).fault;
    assert.equal(unproxied.service, "app");
    assert.equal(await text(`${a.urls.app}/echo/app`), "app");
    assert.equal((await statusOf(a.id)).state, "ready");
  } finally {
    await cleanup();
  }
});

test("stop during a kill's restart wins and leaves nothing behind", async () => {
  const { state, start, run, spawnCli, statusOf, cleanup } = await session("localdev-kill-stop-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    // The restarted api waits before listening, so the kill is still restarting when stop runs.
    await writeFile(path.join(a.dataDir, "api", "listen-delay-ms"), "8000");
    const kill = spawnCli("fault", a.id, "proxied", "--mode", "kill");
    await waitUntil(async () => (await statusOf(a.id)).faults.some((item) => item.mode === "kill" && item.state === "restarting"));
    await run("stop", a.id);
    const { code, stderr } = await kill.exited;
    assert.equal(code, 1);
    assert.match(stderr, /stopped/);
    assert.deepEqual(await run("status"), []);
    const leftovers = execFileSync("ps", ["-eo", "stat=,args="], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes(state) && !line.trim().startsWith("Z"));
    assert.deepEqual(leftovers, [], "no session process is left running");
    for (const item of a.processes) assert.equal(groupAlive(item.pid), false, `${item.name} is gone`);
  } finally {
    await cleanup();
  }
});

test("stop ends every fault and leaves no proxy, held request or process behind", async () => {
  const { state, start, run, statusOf, cleanup } = await session("localdev-fault-stop-", { longStateDir: true });
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    await run("fault", a.id, "proxied", "--mode", "hold");
    const held = fetch(`${a.urls.api}/echo/held`, { signal: AbortSignal.timeout(20_000) });
    held.catch(() => undefined);
    await waitUntil(async () => (await statusOf(a.id)).faults[0]?.held === 1);
    await run("fault", a.id, "raw", "--mode", "fail");
    await run("fault", a.id, "app", "--mode", "pause");
    assert.equal((await statusOf(a.id)).faults.length, 3);
    await run("stop", a.id);
    await assert.rejects(held, "the held request is dropped, not left hanging");
    assert.deepEqual(await run("status"), []);
    for (const item of a.processes) assert.equal(groupAlive(item.pid), false, `${item.name} is gone`);
    for (const port of Object.values(a.ports)) assert.equal(await canBind(port), true, `port ${port} is free`);
    const leftovers = execFileSync("ps", ["-eo", "stat=,args="], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes(state) && !line.trim().startsWith("Z"));
    assert.deepEqual(leftovers, []);
  } finally {
    await cleanup();
  }
});

test("pause on a proxied port freezes the service behind the proxy, never the proxy", async () => {
  const { start, run, statusOf, cleanup } = await session("localdev-pause-proxied-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    const { fault } = await run("fault", a.id, "proxied", "--mode", "pause");
    assert.equal(fault.unit, "process");
    const proxy = proxyOf(a);
    assert.ok(!fault.pids.some(({ pid }) => pid === proxy.pid), "the proxy supervisor is not paused");
    assert.equal(await tcpGet(a.ports.raw, "/echo/raw"), "raw", "the proxy still serves its other port");
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "fail"), /already paused/);
    await run("fault", a.id, "proxied", "--clear");
    assert.equal(await text(`${a.urls.api}/echo/again`), "again");

    await run("fault", a.id, "proxied", "--mode", "fail");
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "pause"), /already has an active fail fault/);
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "kill"), /already has an active fail fault/);
    await run("fault", a.id, "--clear");
    assert.deepEqual((await statusOf(a.id)).faults, []);
  } finally {
    await cleanup();
  }
});

test("fault validates its flags before touching the session", async () => {
  const { start, run, cleanup } = await session("localdev-fault-flags-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    const cases = [
      [["proxied", "--mode", "slow"], /--mode slow needs --ms/],
      [["proxied", "--mode", "fail", "--ms", "5"], /--ms applies only to --mode slow/],
      [["proxied", "--mode", "slow", "--ms", "0"], /--ms must be a whole number from 1 to 600000/],
      [["proxied", "--mode", "slow", "--ms", "600001"], /--ms must be a whole number from 1 to 600000/],
      [["proxied", "--mode", "fail", "--count", "0"], /--count must be a positive whole number/],
      [["proxied", "--mode", "fail", "--count", "1.5"], /--count must be a positive whole number/],
      [["app", "--mode", "pause", "--count", "1"], /--count applies to fail, slow and hold/],
      [["app", "--mode", "hold"], /Port app is not proxied in session .*pause and kill work on any port/],
      [["--release"], /Name the port whose held requests to release/],
      [["proxied", "--mode", "hold", "--clear"], /Choose one of --mode, --release or --clear/],
      [["proxied", "--release", "--clear"], /Choose one of --mode, --release or --clear/],
      [["proxied", "--mode", "explode"], /Unsupported fault mode explode; supported: pause, fail, slow, hold, kill/],
      [["nope", "--mode", "fail"], /Unknown port nope/],
    ];
    for (const [args, expected] of cases) await assert.rejects(run("fault", a.id, ...args), expected, args.join(" "));
    await run("fault", a.id, "proxied", "--mode", "fail");
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "slow", "--ms", "10"), /already has an active fail fault/);
    await run("fault", a.id, "proxied", "--clear");
  } finally {
    await cleanup();
  }
});

test("--no-outbound blocks the app and its children from outside hosts while loopback works", async () => {
  const { start, run, cleanup } = await session("localdev-outbound-");
  try {
    const blocked = await start("--no-outbound", "--project", root, "--adapter", faultsAdapter);
    assert.equal(blocked.outbound, "blocked");
    const probe = JSON.parse(await text(`${blocked.urls.app}/probe`));
    assert.equal(probe.net, "ELOCALDEV_OUTBOUND");
    assert.equal(probe.fetch, "ELOCALDEV_OUTBOUND");
    assert.equal(probe.loopback, "loopback", "the session's own services, through the proxy, still answer");
    assert.equal(probe.httpProxy, "", "the adapter's proxy variable is cleared");
    assert.match(probe.nodeOptions, /--max-old-space-size=256 --import=file:/, "the adapter's NODE_OPTIONS are kept");
    assert.equal(await text(`${blocked.urls.app}/probe-child`), "ELOCALDEV_OUTBOUND", "a child process is blocked too");
    const variants = JSON.parse(await text(`${blocked.urls.app}/probe-variants`));
    assert.equal(variants.emptyPath, "ELOCALDEV_OUTBOUND", "an empty path is TCP, as Node treats it");
    assert.equal(variants.nullPath, "ELOCALDEV_OUTBOUND", "a null path is TCP, as Node treats it");
    assert.notEqual(variants.spelledV6Loopback, "ELOCALDEV_OUTBOUND", "0::1 is loopback");
    assert.equal(variants.mappedLoopback, "connected", "an IPv4-mapped loopback address is loopback");
    await run("fault", blocked.id, "app", "--mode", "kill");
    assert.equal(JSON.parse(await text(`${blocked.urls.app}/probe`)).net, "ELOCALDEV_OUTBOUND", "a restarted service keeps the policy");

    const open = await start("--parallel", "--project", root, "--adapter", faultsAdapter);
    assert.equal(open.outbound, "allowed");
    const unblocked = JSON.parse(await text(`${open.urls.app}/probe`));
    assert.notEqual(unblocked.net, "ELOCALDEV_OUTBOUND");
    assert.equal(unblocked.httpProxy, "http://127.0.0.1:9");
    assert.notEqual(await text(`${open.urls.app}/probe-child`), "ELOCALDEV_OUTBOUND");
  } finally {
    await cleanup();
  }
});

test("a kill whose restart fails stops the replacement and leaves the session degraded, not leaking", async () => {
  const { state, start, run, statusOf, cleanup } = await session("localdev-kill-fail-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    await writeFile(path.join(a.dataDir, "api", "fail-on-start"), "");
    await assert.rejects(run("fault", a.id, "proxied", "--mode", "kill"), /api did not come back after the kill: .*the replacement was stopped/);
    const after = await statusOf(a.id);
    assert.equal(after.state, "degraded");
    assert.deepEqual(after.faults, []);
    const api = processNamed(after, "api");
    assert.notEqual(api.pid, processNamed(a, "api").pid, "the replacement is recorded");
    assert.equal(api.alive, false);
    assert.equal(groupAlive(api.pid), false, "the replacement's supervisor and guard are gone");
    await run("stop", a.id);
    const leftovers = execFileSync("ps", ["-eo", "stat=,args="], { encoding: "utf8" })
      .split("\n").filter((line) => line.includes(state) && !line.trim().startsWith("Z"));
    assert.deepEqual(leftovers, []);
  } finally {
    await cleanup();
  }
});

test("the proxy cuts a truncated answer short and releases the service when a client goes away", async () => {
  const { start, cleanup } = await session("localdev-proxy-cleanup-");
  try {
    const a = await start("--project", root, "--adapter", faultsAdapter);
    const truncated = await fetch(`${a.urls.api}/truncated`, { signal: AbortSignal.timeout(20_000) });
    const error = await truncated.text().then(() => null, (failure) => failure);
    assert.ok(error, "the client sees the cut-off body");
    assert.notEqual(error.name, "TimeoutError", "the client is not left waiting");

    const client = new AbortController();
    const hanging = fetch(`${a.urls.api}/hang`, { signal: client.signal });
    hanging.catch(() => undefined);
    await waitUntil(async () => await text(`${a.urls.api}/hangs`) === "1");
    client.abort();
    await waitUntil(async () => await text(`${a.urls.api}/hangs`) === "0");
    assert.equal(await text(`${a.urls.api}/echo/still`), "still", "the proxy keeps serving");
  } finally {
    await cleanup();
  }
});
