import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localdev-preferred-ports-"));
process.env.LOCAL_CLI_STATE_DIR = root;
const { removeOrphanTempDirs, removeSessionDirs, reserveSession } = await import("../dist/state.js");
function receipt(id, dir, ports) {
  return { id, sessionDir: dir, dataDir: path.join(dir, "data"), ports,
    projectRoot: "/fixture", fixture: "ports", adapterPath: "/fixture/adapter.mjs",
    commit: null, urls: {}, processes: [], state: "starting", ownerPid: process.pid,
    createdAt: new Date().toISOString() };
}

test("app preference skips occupied ports, serializes worktrees and falls back when full", async t => {
  const range = Array.from({ length: 11 }, (_, i) => 3000 + i);
  const occupied = new Set();
  const probed = [];
  const listen = net.Server.prototype.listen;
  // Model only preferred-port probes; locks and random-port probes still use real sockets.
  t.mock.method(net.Server.prototype, "listen", function (...args) {
    const port = typeof args[0] === "object" ? args[0].port : args[0];
    if (!range.includes(port)) return listen.apply(this, args);
    probed.push(port);
    if (occupied.has(port)) {
      queueMicrotask(() => this.emit("error", Object.assign(new Error("Port occupied"), { code: "EADDRINUSE" })));
    } else {
      this.close = callback => { queueMicrotask(callback); return this; };
      queueMicrotask(args.at(-1));
    }
    return this;
  });
  try {
    const first = await reserveSession(["app"], receipt);
    const second = await reserveSession(["web"], receipt);
    assert.equal(first.ports.app, 3000);
    assert.equal(second.ports.web, 3001);
    await removeSessionDirs(first);
    await removeSessionDirs(second);
    occupied.add(3000);
    occupied.add(3004);
    const available = range.filter(port => !occupied.has(port));
    const results = await Promise.all(Array.from({ length: available.length + 2 }, (_, i) =>
      reserveSession([i % 2 ? "app" : "web", "auth"], receipt)));
    const appPorts = results.map(r => r.ports.app ?? r.ports.web);
    assert.equal(new Set(appPorts).size, results.length);
    assert.ok(appPorts.every(port => !occupied.has(port)));
    assert.deepEqual(appPorts.filter(p => p >= 3000 && p <= 3010).sort((a,b) => a-b), available);
    assert.equal(appPorts.filter(p => p >= 20000 && p < 60000).length, 2);
    assert.ok(results.every(r => r.ports.auth >= 20000 && r.ports.auth < 60000));
    const allPorts = results.flatMap(r => Object.values(r.ports));
    assert.equal(new Set(allPorts).size, allPorts.length);
    for (const result of results) await removeSessionDirs(result);
    for (const port of range) occupied.add(port);
    probed.length = 0;
    const fallback = await reserveSession(["app", "auth"], receipt);
    assert.deepEqual(probed, range);
    assert.ok(fallback.ports.app >= 20000 && fallback.ports.app < 60000);
    assert.ok(fallback.ports.auth >= 20000 && fallback.ports.auth < 60000);
  } finally {
    await fs.rm(path.join(root, "sessions"), { recursive: true, force: true });
    await removeOrphanTempDirs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
