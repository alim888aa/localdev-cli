import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// stateRoot and lockPort are read when dist/state.js loads, so point them at a temp state dir first.
const state = await mkdtemp(path.join(os.tmpdir(), "local-cli-lock-"));
process.env.LOCAL_CLI_STATE_DIR = state;
const { lockPort, reserveSession } = await import("../dist/state.js");

test("a stray connection to the lock port cannot keep the lock from being released", async (t) => {
  t.after(() => rm(state, { recursive: true, force: true }));
  let client;
  const reserved = reserveSession(["app"], (id, dir, ports) => ({
    id, fixture: "base", projectRoot: state, commit: null, adapterPath: "", sessionDir: dir, dataDir: path.join(dir, "data"),
    ports, urls: {}, processes: [], state: "failed", ownerPid: process.pid, createdAt: new Date().toISOString(),
  }), async () => {
    // Inside the lock: open a raw connection to the lock port and never close it ourselves.
    client = net.connect({ host: "127.0.0.1", port: lockPort });
    client.on("error", () => undefined);
    await new Promise((resolve) => client.once("connect", resolve));
  });
  const outcome = await Promise.race([reserved.then(() => "released"), new Promise((resolve) => setTimeout(() => resolve("hung"), 5000))]);
  client?.destroy();
  assert.equal(outcome, "released");
  // The port is free again for the next holder.
  const next = net.createServer();
  await new Promise((resolve, reject) => { next.once("error", reject); next.listen({ host: "127.0.0.1", port: lockPort }, resolve); });
  await new Promise((resolve) => next.close(resolve));
});

test("a lock directory whose owner process died is reclaimed without a 30 s wait", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  // What a killed current holder leaves: the compatibility directory with its token, and a freed port.
  const lock = path.join(state, "allocation.lock");
  await mkdir(lock, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: Number(dead), time: Date.now(), token: "crashed-holder" }));
  const started = Date.now();
  await reserveSession(["app"], (id, dir, ports) => ({
    id, fixture: "base", projectRoot: state, commit: null, adapterPath: "", sessionDir: dir, dataDir: path.join(dir, "data"),
    ports, urls: {}, processes: [], state: "failed", ownerPid: process.pid, createdAt: new Date().toISOString(),
  }));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
