import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** Check the listener PID, so another app cannot make an owned session look healthy. */
function ownedListener(record: OwnedProcess): boolean {
  if (!record.readyPort) return false;
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
): Promise<void> {
  const deadline = Date.now() + (spec.readyTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${spec.name} supervisor exited before port ${port} was ready`);
    }
    if (await portOpen(spec.readyHost ?? "127.0.0.1", port) && ownedListener({ ...record, readyPort: port })) {
      child.unref();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${spec.name} did not listen on port ${port} in time`);
}

export async function waitForSeed(child: ChildProcess, exitFile: string, timeoutMs = 300_000): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Seed timeout must be positive");
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
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

/** Stop the owned process group, including children left by an exited launcher. */
export async function stopService(record: OwnedProcess): Promise<boolean> {
  if (!groupExists(record.pid)) return true;
  if (!isOwned(record) && !guardOwnsGroup(record)) return false;
  try { process.kill(-record.pid, "SIGTERM"); } catch { return false; }
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && groupExists(record.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (groupExists(record.pid)) {
    try { process.kill(-record.pid, "SIGKILL"); } catch { /* Group already exited. */ }
  }
  return true;
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
