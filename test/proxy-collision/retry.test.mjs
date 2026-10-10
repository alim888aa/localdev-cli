import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { processAlive } from "../../dist/supervised.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(repo, "dist/cli.js");
const gate = new URL("./gate.mjs", import.meta.url).href;
const occupied = new URL("../ports/occupied-client-range.mjs", import.meta.url).href;

async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for proxy collision state");
}

async function world(portName) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "localdev-proxy-collision-"));
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: path.join(dir, "outer-state") };
  const outerRun = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: repo, env })).stdout);
  const outer = await outerRun("startup", "base");
  const project = path.join(outer.dataDir, "client-project");
  const state = path.join(outer.dataDir, "state");
  const gateDir = path.join(dir, "gate");
  await fs.mkdir(gateDir);
  await fs.writeFile(path.join(project, "collision.adapter.mjs"), `
import fs from "node:fs/promises";
import path from "node:path";
import base from "./local.adapter.mjs";
const name = ${JSON.stringify(portName)};
export default {
  ...base, ports: [name, "api"], proxyPorts: { api: "http", [name]: "http" },
  cleanupPaths({id, projectRoot}) { return [path.join(projectRoot, ".local-cli-" + id + ".config")]; },
  async createSession(c) {
    const plan = await base.createSession({...c, ports: {...c.ports, fixtureWeb: c.bindPorts[name]}});
    const web = plan.services.find(s => s.name === "web");
    web.readyPort = name;
    plan.urls.app = "http://127.0.0.1:" + c.ports[name] + "/";
    const config = path.join(c.projectRoot, ".local-cli-" + c.id + ".config");
    await fs.writeFile(config, JSON.stringify({ports: c.ports, bindPorts: c.bindPorts}));
    return plan;
  }
};
`);
  const run = async (...args) => JSON.parse((await exec(process.execPath, ["--import", occupied, cli, ...args], {
    cwd: project, env: { ...env, LOCAL_CLI_STATE_DIR: state, PROXY_GATE_DIR: gateDir, NODE_OPTIONS: [env.NODE_OPTIONS, "--import=" + gate].filter(Boolean).join(" ") }, timeout: 60000,
  })).stdout);
  const stored = async id => JSON.parse((await exec(process.execPath, ["--input-type=module", "-e",
    `import { readReceipt } from ${JSON.stringify(path.join(repo, "dist/state.js"))};
     console.log(JSON.stringify(await readReceipt(process.argv[1])));`, id],
  { cwd: project, env: { ...env, LOCAL_CLI_STATE_DIR: state } })).stdout);
  const attempts = [];
  const servers = [];
  async function selected() {
    return until(async () => {
      for (const file of await fs.readdir(gateDir)) {
        if (!file.endsWith(".json")) continue;
        const c = await fs.readFile(path.join(gateDir, file), "utf8").then(JSON.parse, () => null);
        if (c && !attempts.some(a => a.id === c.id)) {
          c.receipt = await stored(c.id);
          if (!c.receipt.processes.length) continue;
          attempts.push(c);
          return c;
        }
      }
    });
  }
  async function collide(name = portName) {
    const c = await selected();
    assert.deepEqual(c.routes.map(r => r.port), ["api", portName]);
    const port = c.routes.find(r => r.port === name).listen;
    const server = http.createServer((_, response) => response.end("unrelated"));
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    c.collidedPort = port;
    return c;
  }
  const release = c => fs.writeFile(path.join(gateDir, "release-" + c.id), "");
  async function cleanup() {
    try {
      for (const file of await fs.readdir(gateDir)) if (file.endsWith(".json"))
        await fs.writeFile(path.join(gateDir, "release-" + file.slice(0, -5)), "");
      for (const r of await run("status")) await run("stop", r.id);
      assert.deepEqual(await run("status"), []);
    } finally {
      for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await outerRun("stop", outer.id);
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  return { project, run, stored, selected, collide, release, attempts, cleanup };
}

async function assertAbandoned(c, retained = false) {
  assert.ok(c.receipt.processes.every(p => !processAlive(p)));
  for (const dir of [c.sessionDir, c.receipt.tempDir])
    assert.equal(await fs.access(dir).then(() => true, () => false), retained);
  assert.equal(await fs.access(path.join(c.receipt.projectRoot, ".local-cli-" + c.id + ".config")).then(() => true, () => false), false);
  assert.equal(await (await fetch(`http://127.0.0.1:${c.collidedPort}`)).text(), "unrelated");
}

for (const name of ["web", "app"])
test(`API-first proxy retries a public ${name} collision before API readiness`, async () => {
  const w = await world(name);
  try {
    const startup = w.run("startup", "base", "--adapter", "collision.adapter.mjs");
    startup.catch(() => {});
    const abandoned = await w.collide();
    await w.release(abandoned);
    const next = await Promise.race([w.selected(), startup.then(() => {
      throw new Error("Startup completed before the replacement proxy gate");
    })]);
    await w.release(next);
    const ready = await startup;
    assert.equal(ready.state, "ready");
    assert.equal(ready.id, next.id);
    assert.notEqual(ready.ports[name], abandoned.collidedPort);
    assert.ok(ready.processes.every(p => p.groupOwned && p.listenerOwned));
    assert.equal((await w.run("status", ready.id))[0].state, "ready");
    assert.match(await (await fetch(ready.urls.app)).text(), /scratch client/);
    assert.equal((await (await fetch(ready.urls.api)).json()).length > 0, true);
    const receipt = await w.stored(ready.id);
    const config = JSON.parse(await fs.readFile(path.join(w.project, ".local-cli-" + ready.id + ".config"), "utf8"));
    assert.deepEqual(config, { ports: receipt.ports, bindPorts: receipt.bindPorts });
    assert.deepEqual(ready.ports, receipt.ports);
    assert.equal(Number(new URL(ready.urls.app).port), receipt.ports[name]);
    assert.equal(Number(new URL(ready.urls.api).port), receipt.ports.api);
    for (const route of next.routes) {
      assert.equal(route.listen, receipt.ports[route.port]);
      assert.equal(route.target, receipt.bindPorts[route.port]);
      assert.ok(receipt.services.find(s => s.readyPort === route.port).args.includes(String(route.target)));
    }
    await assertAbandoned(abandoned);
    await w.run("stop", ready.id);
    assert.deepEqual(await w.run("status", ready.id), [{ id: ready.id, state: "gone" }]);
    assert.ok(receipt.processes.every(p => !processAlive(p)));
    assert.equal(await fs.access(receipt.tempDir).then(() => true, () => false), false);
    assert.ok(!(await fs.readdir(w.project)).some(f => f.startsWith(".local-cli-")));
  } finally { await w.cleanup(); }
});

test("API-first proxy stops after three confirmed web collisions", async () => {
  const w = await world("web");
  try {
    const rejected = assert.rejects(w.run("startup", "--adapter", "collision.adapter.mjs"), /Port web .*taken by an unrelated listener.*after 3 startup attempts/);
    for (let i = 0; i < 3; i++) await w.release(await w.collide());
    await rejected;
    assert.equal(w.attempts.length, 3);
    const [failed] = await w.run("status");
    assert.equal(failed.state, "failed");
    assert.ok(failed.processes.every(p => !p.alive));
    for (const [i, c] of w.attempts.entries()) await assertAbandoned(c, i === 2);
  } finally { await w.cleanup(); }
});

test("API-only collision retains the failed session without retrying", async () => {
  const w = await world("web");
  try {
    const rejected = assert.rejects(w.run("startup", "--adapter", "collision.adapter.mjs"), /localdev-proxy .*before port .*was ready/);
    const c = await w.collide("api");
    await w.release(c);
    await rejected;
    const [failed] = await w.run("status");
    assert.equal(failed.state, "failed");
    assert.ok(failed.processes.every(p => !p.alive));
    assert.equal((await fs.readdir(path.dirname(c.sessionDir))).length, 1);
    await assertAbandoned(c, true);
  } finally { await w.cleanup(); }
});

test("cancelling an API-first proxy with a web collision never reallocates", async () => {
  const w = await world("web");
  try {
    const rejected = assert.rejects(w.run("startup", "--adapter", "collision.adapter.mjs"), /stopped during startup/);
    const c = await w.collide();
    await w.run("stop", c.id);
    await rejected;
    assert.deepEqual(await w.run("status"), []);
    assert.equal((await fs.readdir(path.dirname(c.sessionDir))).length, 0);
    await assertAbandoned(c);
  } finally { await w.cleanup(); }
});
