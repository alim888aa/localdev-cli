import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runSync } from "./run-sync.js";

// The one owner of process facts: parent, group, zombie state and birth (a start time that tells a process from a
// later one reusing its PID). Linux reads /proc, so status and stop spawn no ps per check. Other platforms ask ps.

export interface ProcessEntry { pid: number; parent: number; group: number; zombie: boolean }

const PROC_BIRTH = "proc:";
const useProc = process.platform === "linux" && readableProc("/proc");
// /proc start times count clock ticks since boot, and receipts outlive reboots, so a /proc birth also names the
// boot: a process after a reboot never matches one recorded before it, even with the same PID and start tick.
// Without a valid boot identity there is no /proc birth at all (null: unknown), never a shared placeholder.
const bootId = useProc ? readBootId("/proc") : null;

/** The boot identity a /proc birth carries, or null when none is valid. Exported for tests. */
export function readBootId(procRoot: string): string | null {
  try {
    const id = readFileSync(path.join(procRoot, "sys", "kernel", "random", "boot_id"), "utf8").trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  } catch { /* Fall back to the boot time. */ }
  try {
    const btime = /^btime (\d+)$/m.exec(readFileSync(path.join(procRoot, "stat"), "utf8"))?.[1];
    if (btime && Number(btime) > 0) return `btime${btime}`;
  } catch { /* No boot identity. */ }
  return null;
}

function readableProc(procRoot: string): boolean {
  try { readFileSync(path.join(procRoot, "self", "stat"), "utf8"); return true; }
  catch { return false; }
}

/** The fields of /proc/<pid>/stat after the command name, which may itself contain spaces and parentheses. */
function procStat(pid: number, procRoot: string): string[] | null {
  try {
    const raw = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const end = raw.lastIndexOf(")");
    return end < 0 ? null : raw.slice(end + 1).trim().split(/\s+/);
  } catch { return null; }
}

// After the command name: state, parent, group, ..., and start time (stat field 22, index 19 here).
function procEntry(pid: number, procRoot: string): ProcessEntry | null {
  const fields = procStat(pid, procRoot);
  if (!fields) return null;
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(group)) return null;
  return { pid, parent, group, zombie: fields[0] === "Z" || fields[0] === "X" };
}

function procBirth(pid: number, procRoot = "/proc", boot = bootId): string | null {
  const start = procStat(pid, procRoot)?.[19];
  return boot && start && /^\d+$/.test(start) ? `${PROC_BIRTH}${boot}:${start}` : null;
}

/** The PID /proc/self/stat names, which is the caller's own PID only when procRoot is its PID namespace's procfs. */
function procSelfPid(procRoot: string): number | null {
  try { return Number(/^(\d+) \(/.exec(readFileSync(path.join(procRoot, "self", "stat"), "utf8"))?.[1]) || null; }
  catch { return null; }
}

/** Every process in a procfs root; null when it cannot be read. Exported for the listener module and tests. */
export function readProcTable(procRoot = "/proc"): ProcessEntry[] | null {
  let entries: string[];
  try { entries = readdirSync(procRoot); }
  catch { return null; }
  return entries.filter((entry) => /^\d+$/.test(entry))
    .map((entry) => procEntry(Number(entry), procRoot))
    .filter((entry): entry is ProcessEntry => entry !== null);
}

function psBirth(pid: number): string | null {
  try { return runSync("ps", ["-o", "lstart=", "-p", String(pid)]).trim() || null; }
  catch { return null; }
}

function psTable(): ProcessEntry[] | null {
  let output: string;
  try { output = runSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="]); }
  catch { return null; }
  return output.trim().split("\n").flatMap((line) => {
    const [pid, parent, group, stat] = line.trim().split(/\s+/);
    const entry = { pid: Number(pid), parent: Number(parent), group: Number(group), zombie: (stat ?? "").startsWith("Z") };
    return Number.isSafeInteger(entry.pid) && Number.isSafeInteger(entry.group) ? [entry] : [];
  });
}

/**
 * A process's birth, to record now and compare later with isSameProcess. Null when the process is gone or
 * unreadable. Never compare births directly: their format depends on the backend that recorded them.
 */
export function birthOf(pid: number): string | null {
  return useProc ? procBirth(pid) : psBirth(pid);
}

/**
 * This process's birth, or why this runtime cannot verify process identity. Ask before starting anything: owned
 * processes are recorded and later signalled by the births this module reads, so a runtime where that read names
 * the wrong process, or nothing, must be refused. procRoot and pid read a procfs root instead (tests).
 */
export function ownIdentity(procRoot?: string, pid = process.pid): { birth: string } | { problem: string } {
  if (!procRoot && !useProc) {
    const birth = psBirth(pid);
    return birth ? { birth } : { problem: "ps cannot report this process's start time" };
  }
  const root = procRoot ?? "/proc";
  // Some sandboxes run Node in a PID namespace but show the outer namespace's /proc, where Node's PIDs name other
  // processes (#23). Reading through it would record and later signal an unrelated process.
  const selfPid = procSelfPid(root);
  if (selfPid !== pid) {
    const names = `it calls this process ${selfPid ?? "nothing"}, Node calls it ${pid}`;
    return { problem: `/proc belongs to another PID namespace (${names}); run localdev where /proc is mounted for its own PID namespace` };
  }
  const boot = procRoot ? readBootId(procRoot) : bootId;
  if (!boot) return { problem: "/proc has no boot identity (sys/kernel/random/boot_id or btime in /proc/stat)" };
  const birth = procBirth(pid, root, boot);
  return birth ? { birth } : { problem: "/proc cannot report this process's start time" };
}

/**
 * Whether pid is still the process whose birth was recorded, never a later one reusing the PID. The recorded
 * format picks the backend, so a receipt written by an older localdev (ps start times) still matches wherever ps
 * works.
 */
export function isSameProcess(pid: number, recordedBirth: string | null | undefined): boolean {
  return compareBirth(pid, recordedBirth) === "same";
}

/**
 * The tri-state behind isSameProcess, for callers that must tell a reused PID ("different") from a birth that
 * could not be read ("unknown": the process is gone, or it exists but is unreadable and may still be the one).
 */
export function compareBirth(pid: number, recordedBirth: string | null | undefined): "same" | "different" | "unknown" {
  if (!recordedBirth) return "unknown";
  const current = recordedBirth.startsWith(PROC_BIRTH) ? procBirth(pid) : psBirth(pid);
  if (current === null) return "unknown";
  return current === recordedBirth ? "same" : "different";
}

/** The whole process table, or null when it cannot be read (callers then fail safe). */
export function listProcesses(): ProcessEntry[] | null {
  return useProc ? readProcTable() : psTable();
}

/** One process, or null when it is gone or unreadable. */
export function processEntry(pid: number): ProcessEntry | null {
  if (useProc) return procEntry(pid, "/proc");
  try {
    const [parent, group, stat] = runSync("ps", ["-o", "ppid=,pgid=,stat=", "-p", String(pid)]).trim().split(/\s+/);
    const entry = { pid, parent: Number(parent), group: Number(group), zombie: (stat ?? "").startsWith("Z") };
    return Number.isSafeInteger(entry.parent) && Number.isSafeInteger(entry.group) ? entry : null;
  } catch { return null; }
}

export type ProcessTable = Map<number, ProcessEntry>;

/** The process table keyed by PID, or null when unreadable. procRoot reads a procfs root instead (tests). */
export function processTable(procRoot?: string): ProcessTable | null {
  const entries = procRoot ? readProcTable(procRoot) : listProcesses();
  return entries && new Map(entries.map((entry) => [entry.pid, entry]));
}

/**
 * Whether pid is in group pgid or has an ancestor that is: the one parent-chain walk. A child that moved into its
 * own group still descends from the group while its parent chain reaches it. False when the table is unreadable.
 */
export function descendsFromGroup(pid: number, pgid: number, table: ProcessTable | null = processTable()): boolean {
  const seen = new Set<number>();
  let current = pid;
  while (table && current > 1 && !seen.has(current)) {
    seen.add(current);
    const entry = table.get(current);
    if (!entry) return false;
    if (entry.group === pgid) return true;
    current = entry.parent;
  }
  return false;
}

/** The PID exists, whoever owns it: only ESRCH means gone (EPERM is a live process of another user). */
export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
