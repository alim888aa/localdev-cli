import { createHash, randomInt, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { SessionReceipt } from "./types.js";

export const stateRoot = path.resolve(
  process.env.LOCAL_CLI_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "local-cli"),
);
const sessionsRoot = path.join(stateRoot, "sessions");
const lockPath = path.join(stateRoot, "allocation.lock");

export function sessionPath(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid session ID");
  return path.join(sessionsRoot, id);
}

export async function readReceipt(id: string): Promise<SessionReceipt> {
  const raw = await fs.readFile(path.join(sessionPath(id), "receipt.json"), "utf8");
  return JSON.parse(raw) as SessionReceipt;
}

export async function listReceipts(): Promise<SessionReceipt[]> {
  await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  const ids = await fs.readdir(sessionsRoot);
  const results = await Promise.all(ids.map(async (id) => {
    try { return await readReceipt(id); } catch { return null; }
  }));
  return results.filter((item): item is SessionReceipt => item !== null);
}

export async function writeReceipt(receipt: SessionReceipt): Promise<void> {
  const target = path.join(sessionPath(receipt.id), "receipt.json");
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, target);
}

async function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

// The allocation lock is a loopback TCP listener. The kernel lets one process listen on the port and frees it
// when that process exits, so a lock can never go stale and nothing ever has to reclaim one. The port is
// derived from the state directory (outside the 20000-59999 service range). LOCAL_CLI_LOCK_PORT overrides it;
// every process sharing a state directory must then use the same value, or they stop excluding each other.
export const lockPort = Number(process.env.LOCAL_CLI_LOCK_PORT) ||
  10_000 + (createHash("sha256").update(stateRoot).digest().readUInt32BE(0) % 10_000);

function listenOnce(port: number): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    // Nothing talks to the lock port; drop any stray connection so close() never waits on one.
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" ? resolve(null) : reject(error));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.unref(); resolve(server); });
  });
}

type LegacyOwner = { pid: number; time: number; token?: string };

/**
 * Older localdev versions lock by creating `allocation.lock/owner.json`. While holding the port lock (so no
 * other current localdev competes here) wait out a live legacy holder, clear an abandoned one, and take the
 * directory ourselves so legacy versions wait for us. A legacy writer paused more than 30 s between creating
 * the directory and writing its owner file is indistinguishable from a dead one: a known mixed-version limit.
 */
async function takeLegacyLock(token: string, deadline: number): Promise<void> {
  const ownerFile = path.join(lockPath, "owner.json");
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, time: Date.now(), token }));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = await fs.readFile(ownerFile, "utf8").then((text) => JSON.parse(text) as LegacyOwner, () => null);
    const modified = await fs.stat(lockPath).then((stat) => stat.mtimeMs, () => Date.now());
    // An owner whose process is gone is crash debris and goes at once; a live owner is always waited for,
    // whatever wrote it. Without an owner file, only age can tell (the accepted >30 s legacy limit).
    const abandoned = owner ? !pidExists(owner.pid) : Date.now() - modified > 30_000;
    if (abandoned) await fs.rm(lockPath, { recursive: true, force: true });
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for an older localdev's allocation lock");
}

async function acquireLock(): Promise<() => Promise<void>> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 60_000;
  let server: net.Server | null = null;
  while (!server) {
    server = await listenOnce(lockPort);
    if (server) break;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the local session allocation lock (127.0.0.1:${lockPort}); if another program uses that port, set LOCAL_CLI_LOCK_PORT`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const held = server;
  const token = randomUUID();
  try {
    await takeLegacyLock(token, deadline);
  } catch (error) {
    await new Promise((resolve) => held.close(() => resolve(undefined)));
    throw error;
  }
  return async () => {
    try {
      const owner = await fs.readFile(path.join(lockPath, "owner.json"), "utf8").then((text) => JSON.parse(text) as LegacyOwner, () => null);
      if (owner?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
    } finally {
      await new Promise((resolve) => held.close(() => resolve(undefined)));
    }
  };
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Reserve a complete port set before another CLI invocation can allocate one. */
export async function reserveSession(
  names: string[],
  makeReceipt: (id: string, dir: string, ports: Record<string, number>) => SessionReceipt,
  beforeAllocate?: (receipts: SessionReceipt[]) => Promise<void>,
): Promise<SessionReceipt> {
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error("Adapter must declare unique port names");
  }
  const release = await acquireLock();
  try {
    if (beforeAllocate) await beforeAllocate(await listReceipts());
    const used = new Set((await listReceipts())
      .filter((item) => item.state === "starting" || item.state === "ready" || item.state === "stopping")
      .flatMap((item) => Object.values(item.ports)));
    const ports: Record<string, number> = {};
    for (const name of names) {
      let found = false;
      // App URLs stay predictable across worktrees; emulator ports remain isolated.
      if (name === "web" || name === "app") {
        for (let candidate = 3000; candidate <= 3010; candidate++) {
          if (used.has(candidate) || !(await canBind(candidate))) continue;
          ports[name] = candidate;
          used.add(candidate);
          found = true;
          break;
        }
      }
      for (let attempt = 0; !found && attempt < 1000; attempt++) {
        const candidate = randomInt(20_000, 60_000);
        if (used.has(candidate) || !(await canBind(candidate))) continue;
        ports[name] = candidate;
        used.add(candidate);
        found = true;
        break;
      }
      if (!found) throw new Error(`Unable to reserve a port for ${name}`);
    }
    const id = randomUUID();
    const dir = sessionPath(id);
    await fs.mkdir(path.join(dir, "data"), { recursive: true, mode: 0o700 });
    const receipt = makeReceipt(id, dir, ports);
    await writeReceipt(receipt);
    return receipt;
  } finally {
    await release();
  }
}
