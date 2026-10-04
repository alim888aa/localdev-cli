import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxListenerOwned } from "./linux-listener.js";
import type { CommandSpec, OwnedProcess, ServiceSpec } from "./types.js";

const supervisorPath = fileURLToPath(new URL("./supervisor.js", import.meta.url));

export function birthOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

function isOwned(record: OwnedProcess): boolean {
  return birthOf(record.pid) === record.birth;
}

function guardOwnsGroup(record: OwnedProcess): boolean {
  if (birthOf(record.guardPid) !== record.guardBirth) return false;
  try {
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(record.guardPid)], { encoding: "utf8" }).trim());
    return pgid === record.pid;
  } catch { return false; }
}

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

function descendsFromGroup(pid: number, pgid: number): boolean {
  const seen = new Set<number>();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    try {
      const [parent, group] = execFileSync("ps", ["-o", "ppid=,pgid=", "-p", String(current)], { encoding: "utf8" })
        .trim().split(/\s+/).map(Number);
      if (group === pgid) return true;
      current = parent;
    } catch { return false; }
  }
  return false;
}

type EscapedGroup = { pgid: number; pid: number; birth: string };

/** Descendants of the owned group that moved into their own process group, which a group signal misses. */
function findEscapedGroups(pgid: number): EscapedGroup[] {
  let output: string;
  try { output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }); }
  catch { return []; }
  const table = new Map<number, { parent: number; group: number }>();
  for (const line of output.trim().split("\n")) {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
    if (Number.isSafeInteger(pid)) table.set(pid, { parent, group });
  }
  const escaped = new Map<number, EscapedGroup>();
  for (const [pid, info] of table) {
    if (info.group === pgid || escaped.has(info.group)) continue;
    const seen = new Set<number>();
    let current = info.parent;
    while (current > 1 && !seen.has(current)) {
      seen.add(current);
      const ancestor = table.get(current);
      if (!ancestor) break;
      if (ancestor.group === pgid) {
        const birth = birthOf(pid);
        if (birth) escaped.set(info.group, { pgid: info.group, pid, birth });
        break;
      }
      current = ancestor.parent;
    }
  }
  return [...escaped.values()];
}

function mergeGroups(...lists: Array<EscapedGroup[] | undefined>): EscapedGroup[] {
  const merged = new Map<number, EscapedGroup>();
  for (const list of lists) for (const group of list ?? []) if (!merged.has(group.pgid)) merged.set(group.pgid, group);
  return [...merged.values()];
}

/** Check the listener PID, so another app cannot make an owned session look healthy. */
function ownedListener(record: OwnedProcess): boolean {
  if (!record.readyPort) return false;
  if (process.platform === "linux" && linuxListenerOwned(record.readyPort, record.pid)) return true;
  try {
    const output = execFileSync("lsof", [
      "-nP", `-iTCP:${record.readyPort}`, "-sTCP:LISTEN", "-Fp",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = output.split("\n")
      .filter((line) => /^p\d+$/.test(line))
      .map((line) => Number(line.slice(1)));
    return pids.some((pid) => descendsFromGroup(pid, record.pid));
  } catch { return false; }
}

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

/** A persistent supervisor keeps the process group identifiable if a launcher exits. */
async function spawnManaged(
  name: string,
  spec: CommandSpec,
  root: string,
  sessionDir: string,
): Promise<{ owned: OwnedProcess; child: ChildProcess; exitFile: string }> {
  const token = randomUUID();
  const log = path.join(sessionDir, `${name}.log`);
  const configFile = path.join(sessionDir, `${token}.command.json`);
  const exitFile = path.join(sessionDir, `${token}.exit.json`);
  const guardFile = path.join(sessionDir, `${token}.guard.pid`);
  await fs.writeFile(configFile, JSON.stringify({
    command: spec.command,
    args: spec.args ?? [],
    cwd: spec.cwd ?? root,
    env: { ...process.env, ...spec.env },
    exitFile,
    guardFile,
  }), { mode: 0o600 });
  const logFd = openSync(log, "a", 0o600);
  const child = spawn(process.execPath, [supervisorPath, configFile], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const birth = birthOf(child.pid!);
    if (!birth) throw new Error(`Could not identify ${name} supervisor`);
    let guardPid = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { guardPid = Number(await fs.readFile(guardFile, "utf8")); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    const guardBirth = guardPid ? birthOf(guardPid) : null;
    if (!guardBirth) throw new Error(`Could not identify ${name} guard`);
    await fs.rm(guardFile, { force: true });
    return { owned: { name, pid: child.pid!, birth, guardPid, guardBirth, log, exitFile }, child, exitFile };
  } catch (error) {
    await fs.rm(configFile, { force: true }).catch(() => undefined);
    if (child.pid) {
      const birth = birthOf(child.pid);
      if (birth) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
      }
    }
    throw error;
  }
}

export function spawnService(spec: ServiceSpec, root: string, dir: string) {
  return spawnManaged(spec.name, spec, root, dir);
}

export function spawnSeed(spec: CommandSpec, root: string, dir: string) {
  return spawnManaged("seed", spec, root, dir);
}

export async function waitForService(
  child: ChildProcess,
  spec: ServiceSpec,
  port: number,
  record: OwnedProcess,
  ensureActive: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + (spec.readyTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    await ensureActive();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${spec.name} supervisor exited before port ${port} was ready`);
    }
    try {
      const exit = JSON.parse(await fs.readFile(record.exitFile, "utf8")) as { code: number | null; signal: string | null };
      // A successful launcher may leave its server child listening in this group.
      if (exit.code !== 0 || exit.signal) {
        throw new Error(`${spec.name} command exited (${exit.signal ?? `code ${exit.code}`}) before port ${port} was ready; log: ${record.log}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (await portOpen(spec.readyHost ?? "127.0.0.1", port) && ownedListener({ ...record, readyPort: port })) {
      await ensureActive();
      // Record detached descendants now: once their launcher exits, ancestry can no longer find them.
      record.escapedGroups = mergeGroups(record.escapedGroups, findEscapedGroups(record.pid));
      child.unref();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${spec.name} did not listen on port ${port} in time`);
}

export async function waitForSeed(child: ChildProcess, exitFile: string, timeoutMs = 300_000, ensureActive?: () => Promise<void>): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Seed timeout must be positive");
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    await ensureActive?.();
    try {
      const result = JSON.parse(await fs.readFile(exitFile, "utf8")) as { code: number | null; signal: string | null };
      if (result.code !== 0) {
        throw new Error(`Fixture seed failed (${result.signal ?? result.code}); see seed.log`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Fixture seed timed out after ${timeoutMs}ms; see seed.log`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Fixture seed supervisor exited before recording a result");
}

/**
 * Stop the owned process group, including children left by an exited launcher and descendants that
 * moved into their own groups. Returns false unless every owned group is verified gone.
 */
export async function stopService(record: OwnedProcess): Promise<boolean> {
  const mainAlive = groupExists(record.pid);
  if (mainAlive && !isOwned(record) && !guardOwnsGroup(record)) return false;
  // An escaped group is only signalled while its recorded member is the same process (no PID reuse).
  const escaped = mergeGroups(record.escapedGroups, mainAlive ? findEscapedGroups(record.pid) : [])
    .filter((group) => birthOf(group.pid) === group.birth && groupExists(group.pgid));
  if (!mainAlive && !escaped.length) return true;
  const targets = [...(mainAlive ? [record.pid] : []), ...escaped.map((group) => group.pgid)];
  for (const pgid of targets) { try { process.kill(-pgid, "SIGTERM"); } catch { /* Already exited. */ } }
  const remaining = () => targets.filter(groupExists);
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && remaining().length) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pgid of remaining()) { try { process.kill(-pgid, "SIGKILL"); } catch { /* Already exited. */ } }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && remaining().length) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return remaining().length === 0;
}

export function processAlive(record: OwnedProcess): boolean {
  return isOwned(record) || guardOwnsGroup(record);
}

export async function processHealth(record: OwnedProcess): Promise<{ reachable: boolean | null; listenerOwned: boolean | null; checks: Array<{ name: string; reachable: boolean; listenerOwned: boolean }>; commandExit: object | null }> {
  let commandExit: object | null = null;
  try { commandExit = JSON.parse(await fs.readFile(record.exitFile, "utf8")) as object; }
  catch { /* The command has not exited. */ }
  const ports = record.readyChecks ?? (record.readyPort ? [{ name: "ready", port: record.readyPort, host: record.readyHost ?? "127.0.0.1" }] : []);
  const checks = await Promise.all(ports.map(async ({ name, port, host }) => ({
    name,
    reachable: await portOpen(host, port),
    listenerOwned: ownedListener({ ...record, readyPort: port }),
  })));
  return {
    reachable: checks.length ? checks.every((item) => item.reachable) : null,
    listenerOwned: checks.length ? checks.every((item) => item.listenerOwned) : null,
    checks,
    commandExit,
  };
}
