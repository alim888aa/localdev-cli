import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plain from "../fixture.adapter.mjs";
import faults from "../faults.adapter.mjs";
import socket from "../temp-dir/socket.adapter.mjs";
import client from "../../fixtures/base/client-project/local.adapter.mjs";
import outer from "../../local.adapter.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "localdev-port-isolation-"));
process.env.LOCAL_CLI_STATE_DIR = root;
const { reserveSession, removeSessionDirs, removeOrphanTempDirs } = await import("../../dist/state.js");

test("every test and base fixture adapter allocates outside client app ports", async () => {
  try {
    for (const adapter of [plain, faults, socket, client, outer]) {
      const session = await reserveSession(adapter.ports, (id, dir, ports, bindPorts) => ({
        id, sessionDir: dir, dataDir: path.join(dir, "data"), ports, bindPorts,
        projectRoot: "/fixture", adapterPath: "/fixture/adapter.mjs", fixture: "base",
        commit: null, urls: {}, processes: [], state: "starting", ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      }), undefined, Object.keys(adapter.proxyPorts ?? {}));
      for (const port of [...Object.values(session.ports), ...Object.values(session.bindPorts)])
        assert.ok(port >= 20000 && port < 60000, `${adapter.ports.join(", ")} must leave client app ports free`);
      await removeSessionDirs(session);
    }
  } finally {
    await fs.rm(path.join(root, "sessions"), { recursive: true, force: true });
    await removeOrphanTempDirs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
