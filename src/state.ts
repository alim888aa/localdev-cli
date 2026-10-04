import { randomInt, randomUUID } from "node:crypto";
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

async function acquireLock(): Promise<() => Promise<void>> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, time: Date.now() }));
      return () => fs.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid: number; time: number };
        if (Date.now() - owner.time > 30_000 && !pidExists(owner.pid)) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The owner file is written right after the directory. One still missing after
        // 30 seconds means its writer died in between, so the lock is abandoned.
        const created = await fs.stat(lockPath).then((stat) => stat.mtimeMs, () => undefined);
        if (created !== undefined && Date.now() - created > 30_000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for the local session allocation lock");
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
