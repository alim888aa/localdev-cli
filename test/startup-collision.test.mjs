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
import { processAlive } from "../dist/supervised.js";

const exec = promisify(execFile);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repo, "dist/cli.js");

async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for collision synchronization");
}

async function world(portName = "web", proxiedApp = false) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "localdev-collision-"));
  const state = path.join(project, "state");
  const env = { ...process.env, LOCAL_CLI_STATE_DIR: state };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args], { cwd: project, env, timeout: 30000 })).stdout);
  const readStored = async id => JSON.parse((await exec(process.execPath, ["--input-type=module", "-e",
    `import { readReceipt } from ${JSON.stringify(path.join(repo, "dist", "state.js"))};
     console.log(JSON.stringify(await readReceipt(process.argv[1])));`, id], { cwd: project, env })).stdout);
  await fs.writeFile(path.join(project, "local.adapter.mjs"), `
import fs from "node:fs/promises";
import path from "node:path";
import { readReceipt } from ${JSON.stringify(path.join(repo, "dist", "state.js"))};
export default {
  ports: [${JSON.stringify(portName)}, "api"], proxyPorts: { api: "http"${proxiedApp ? ", app: \"http\"" : ""} }, defaultFixture: "base",
  cleanupPaths({ id, projectRoot }) { return [path.join(projectRoot, ".local-cli-" + id + ".config")]; },
  async createSession(c) {
    await fs.appendFile(path.join(c.projectRoot, "calls"), c.id + "\\n");
    if (c.fixture === "adapter-error") throw new Error("adapter failed");
    const config = path.join(c.projectRoot, ".local-cli-" + c.id + ".config");
    await fs.writeFile(config, JSON.stringify(c.ports));
    if (await fs.access(path.join(c.projectRoot, "collide")).then(() => true, () => false)) {
      await fs.writeFile(path.join(c.projectRoot, "selected"), JSON.stringify({ ...c, ownedProcesses: (await readReceipt(c.id)).processes }));
      while (!await fs.access(path.join(c.projectRoot, "release-" + c.id)).then(() => true, () => false))
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    let command = process.execPath;
    if (c.fixture === "missing-command") command = "localdev-no-such-service-command";
    if (c.fixture === "missing-path") command = path.join(c.projectRoot, "node_modules", ".bin", "missing-service");
    return { services: [
      { name: "api", command, args: c.fixture === "service-error" ? ["-e", "process.exit(1)"] : [${JSON.stringify(path.join(repo, "test", "fault-server.mjs"))}, String(c.bindPorts.api), c.dataDir], readyPort: "api" },
      { name: "web", command: process.execPath, args: [${JSON.stringify(path.join(repo, "test", "fault-server.mjs"))}, String(c.bindPorts[${JSON.stringify(portName)}]), c.dataDir], readyPort: ${JSON.stringify(portName)}, readyTimeoutMs: 5000 }
    ], seed: c.fixture === "seed-error" ? { command: process.execPath, args: ["-e", "process.exit(1)"] } : undefined, urls: { app: "http://127.0.0.1:" + c.ports[${JSON.stringify(portName)}] } };
  }
};
`);
  const squatters = [];
  const attempts = [];
  const collide = async (last = false) => {
    const context = await until(async () => {
      const c = await fs.readFile(path.join(project, "selected"), "utf8").then(JSON.parse, () => null);
      return c && !attempts.some(a => a.id === c.id) ? c : null;
    });
    const server = http.createServer((_, response) => response.end("unrelated"));
    server.listen(context.bindPorts[portName], "127.0.0.1");
    await once(server, "listening");
    squatters.push(server);
    attempts.push(context);
    if (last) await fs.rm(path.join(project, "collide"));
    await fs.writeFile(path.join(project, "release-" + context.id), "");
    return context;
  };
  const cleanup = async () => {
    try {
      // Unblock the adapter even when the test's attempt to take the port failed.
      const selected = await fs.readFile(path.join(project, "selected"), "utf8").then(JSON.parse, () => null);
      if (selected) await fs.writeFile(path.join(project, "release-" + selected.id), "");
      for (const r of await run("status")) await run("stop", r.id);
      await fs.rm(project, { recursive: true, force: true });
    } finally {
      for (const server of squatters) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
  };
  return { project, state, run, readStored, collide, attempts, cleanup };
}

for (const [portName, replace, proxiedApp] of [["web", false, false], ["web", true, false], ["app", false, true]])
test(`startup recovers from a stolen ${portName} port (replace=${replace}, proxied=${proxiedApp})`, async () => {
  const w = await world(portName, proxiedApp);
  try {
    let original;
    let peer;
    if (replace) {
      original = await w.run("startup");
      peer = await w.run("startup", "--parallel");
    }
    await fs.writeFile(path.join(w.project, "collide"), "");
    const startup = w.run("startup", ...(replace ? ["--replace", original.id] : []));
    // Attach a rejection handler while the test drives the adapter gate.
    startup.catch(() => {});
    const abandoned = await w.collide(true);
    const ready = await startup;
    assert.equal(ready.state, "ready");
    assert.notEqual((await w.run("status", ready.id))[0].state, "degraded");
    assert.equal(await (await fetch(ready.urls.app)).text(), ready.dataDir);
    assert.equal(await (await fetch(`http://127.0.0.1:${abandoned.bindPorts[portName]}`)).text(), "unrelated");
    assert.ok(ready.processes.every(p => p.groupOwned && p.listenerOwned));
    const receipt = await w.readStored(ready.id);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(w.project, ".local-cli-" + ready.id + ".config"))), ready.ports);
    assert.ok(receipt.services.find(s => s.name === "web").args.includes(String(receipt.bindPorts[portName])));
    assert.notEqual(receipt.bindPorts[portName], abandoned.bindPorts[portName]);
    assert.notEqual(receipt.bindPorts.api, ready.ports.api);
    assert.ok(receipt.services.find(s => s.name === "api").args.includes(String(receipt.bindPorts.api)));
    assert.ok(abandoned.ownedProcesses.length > 0);
    assert.ok(abandoned.ownedProcesses.every(p => !processAlive(p)));
    assert.equal(await fs.access(abandoned.sessionDir).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(w.project, ".local-cli-" + abandoned.id + ".config")).then(() => true, () => false), false);
    if (replace) {
      assert.equal((await w.run("status", original.id))[0].state, "gone");
      assert.equal(await (await fetch(peer.urls.app)).text(), peer.dataDir);
    }
    await w.run("stop", ready.id);
    assert.equal((await w.run("status", ready.id))[0].state, "gone");
  } finally { await w.cleanup(); }
});

test("three consecutive collisions fail clearly and clean every abandoned attempt", async () => {
  const w = await world();
  try {
    await fs.writeFile(path.join(w.project, "collide"), "");
    const startup = w.run("startup");
    const rejected = assert.rejects(startup, /taken by an unrelated listener.*after 3 startup attempts/);
    for (let attempt = 0; attempt < 3; attempt++) await w.collide(attempt === 2);
    await rejected;
    const status = await w.run("status");
    assert.equal(status.length, 1);
    assert.equal(status[0].state, "failed");
    assert.ok(status[0].processes.every(p => !p.alive));
    for (const [index, c] of w.attempts.entries()) {
      assert.ok(c.ownedProcesses.every(p => !processAlive(p)));
      assert.equal(await (await fetch(`http://127.0.0.1:${c.ports.web}`)).text(), "unrelated");
      assert.equal(await fs.access(c.sessionDir).then(() => true, () => false), index === 2);
      assert.equal(await fs.access(path.join(w.project, ".local-cli-" + c.id + ".config")).then(() => true, () => false), false);
    }
    assert.equal((await fs.readFile(path.join(w.project, "calls"), "utf8")).trim().split("\n").length, 3);
  } finally { await w.cleanup(); }
});

for (const fixture of ["adapter-error", "service-error", "seed-error", "missing-command", "missing-path"])
test(`${fixture} fails without a collision retry`, async () => {
  const w = await world();
  try {
    const missing = fixture.startsWith("missing-");
    const command = fixture === "missing-command" ? "localdev-no-such-service-command"
      : fixture === "missing-path" ? path.join(await fs.realpath(w.project), "node_modules", ".bin", "missing-service") : process.execPath;
    await assert.rejects(w.run("startup", fixture), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /failed/);
      if (missing || fixture === "service-error") {
        assert.match(error.stderr, /api command exited \(code 1\) before port \d+ was ready/);
        assert.ok(error.stderr.includes(`command: ${command}`));
        if (missing) assert.ok(error.stderr.includes(`spawn ${command} ENOENT`));
        else assert.ok(!error.stderr.includes("ENOENT"));
      }
      return true;
    });
    assert.equal((await fs.readFile(path.join(w.project, "calls"), "utf8")).trim().split("\n").length, 1);
    const [failed] = await w.run("status");
    assert.equal(failed.state, "failed");
    assert.ok(failed.processes.every(p => !p.alive));
    if (missing) assert.ok(failed.error.includes(`spawn ${command} ENOENT`));
    assert.ok(!(await fs.readdir(w.project)).some(file => file.startsWith(".local-cli-")));
  } finally { await w.cleanup(); }
});
