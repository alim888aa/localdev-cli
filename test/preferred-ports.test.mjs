import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localdev-preferred-ports-"));
process.env.LOCAL_CLI_STATE_DIR = root;
const { reserveSession } = await import("../dist/state.js");
function receipt(id, dir, ports) {
  return { id, sessionDir: dir, dataDir: path.join(dir, "data"), ports,
    projectRoot: "/fixture", fixture: "ports", adapterPath: "/fixture/adapter.mjs",
    commit: null, urls: {}, processes: [], state: "starting", ownerPid: process.pid,
    createdAt: new Date().toISOString() };
}

async function listener(port) {
  const server = net.createServer();
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    return server;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    return null;
  }
}
async function close(server) {
  if (server) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}

test("app preference skips live listeners, serializes worktrees and falls back when full", async () => {
  const available = [];
  const listeners = [];
  try {
    // Discover the range without assuming a user's existing localhost ports are free.
    for (let port = 3000; port <= 3010; port++) {
      const server = await listener(port);
      if (server) { available.push(port); listeners.push(server); }
    }
    if (available.length === 0) {
      const r = await reserveSession(["app", "auth"], receipt);
      assert.ok(r.ports.app >= 20000 && r.ports.app < 60000);
      assert.ok(r.ports.auth >= 20000 && r.ports.auth < 60000);
      return;
    }
    // Keep one external listener alive, release the rest for session allocation.
    const externallyOccupied = available.shift();
    for (const server of listeners.slice(1)) await close(server);
    const results = await Promise.all(Array.from({ length: available.length + 2 }, (_, i) =>
      reserveSession([i % 2 ? "app" : "web", "auth"], receipt)));
    const appPorts = results.map(r => r.ports.app ?? r.ports.web);
    assert.equal(new Set(appPorts).size, results.length);
    assert.ok(!appPorts.includes(externallyOccupied));
    assert.deepEqual(appPorts.filter(p => p >= 3000 && p <= 3010).sort((a,b) => a-b), available);
    assert.equal(appPorts.filter(p => p >= 20000 && p < 60000).length, 2);
    assert.ok(results.every(r => r.ports.auth >= 20000 && r.ports.auth < 60000));
    const allPorts = results.flatMap(r => Object.values(r.ports));
    assert.equal(new Set(allPorts).size, allPorts.length);
  } finally {
    for (const server of listeners) if (server.listening) await close(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});
