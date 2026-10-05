import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { birthOf, descendsFromGroup, isSameProcess, processTable } from "./process-table.js";
import { runSync } from "./run-sync.js";
import type { ProcessIdentity } from "./types.js";

// The one owner of "who listens on a port". Linux reads /proc (socket inode, then the fds holding it); other
// platforms, and Linux when /proc shows nothing, ask lsof. An owned listener is a listener PID that descends from
// one of the owned process groups; nothing else counts, so another app on the port never looks like the session's.

/** Read the socket inode for TCP listeners on one port in the current network namespace. */
function listenerInodes(port: number, procRoot: string): Set<string> | null {
  const inodes = new Set<string>();
  let readAny = false;
  for (const file of ["tcp", "tcp6"]) {
    try {
      const rows = readFileSync(path.join(procRoot, "net", file), "utf8").split("\n");
      readAny = true;
      for (const row of rows.slice(1)) {
        const fields = row.trim().split(/\s+/);
        if (fields.length < 10 || fields[3] !== "0A") continue;
        const localPort = Number.parseInt(fields[1].split(":").at(-1) ?? "", 16);
        if (localPort === port && /^\d+$/.test(fields[9])) inodes.add(fields[9]);
      }
    } catch { /* Some hosts disable one address family. */ }
  }
  return readAny ? inodes : null;
}

function holdsSocket(pid: number, inodes: Set<string>, procRoot: string): boolean {
  let descriptors: string[];
  try { descriptors = readdirSync(path.join(procRoot, String(pid), "fd")); }
  catch { return false; }
  for (const descriptor of descriptors) {
    try {
      const target = readlinkSync(path.join(procRoot, String(pid), "fd", descriptor));
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) return true;
    } catch { /* A descriptor may close during inspection. */ }
  }
  return false;
}

/** The /proc backend: every PID holding a TCP listener on the port; null means procfs is unavailable. Exported for tests. */
export function procListenerPids(port: number, procRoot = "/proc"): number[] | null {
  const inodes = listenerInodes(port, procRoot);
  if (!inodes) return null;
  if (inodes.size === 0) return [];
  const table = processTable(procRoot);
  if (!table) return null;
  return [...table.keys()].filter((pid) => holdsSocket(pid, inodes, procRoot));
}

function lsofListenerPids(port: number): number[] {
  try {
    const output = runSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
    return [...new Set(output.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
  } catch { return []; } // lsof exits 1 when nothing listens.
}

/** PIDs listening on a TCP port, whoever owns them. Ownership is checked by ownedListener or ownedListenerProcesses. */
export function listenerPids(port: number): number[] {
  if (process.platform === "linux") {
    const pids = procListenerPids(port);
    if (pids?.length) return pids;
  }
  return lsofListenerPids(port);
}

/**
 * The health check: a listener on the port descends from the record's process group, so another app cannot make an
 * owned session look healthy. Ancestry only; signalling a listener needs ownedListenerProcesses.
 */
export function ownedListener(record: { pid: number }, port: number): boolean {
  const pids = listenerPids(port);
  const table = processTable();
  return pids.some((pid) => descendsFromGroup(pid, record.pid, table));
}

/**
 * Listeners on a port that descend from one of the given verified process groups (a session process's own group
 * and its recorded escaped groups: supervised.ts ownedGroups), with their births, safe to signal. A listener from
 * another session or an unrelated app is never returned.
 */
export function ownedListenerProcesses(groups: number[], port: number): ProcessIdentity[] {
  if (!groups.length) return [];
  const owned: ProcessIdentity[] = [];
  for (const pid of listenerPids(port)) {
    // Birth first, then ancestry from a table read after it, then the same birth again: a PID that exits and is
    // reused around the ancestry check would otherwise be recorded with the newcomer's birth (or certified by a
    // table read before the newcomer existed) and later pass signalProcess.
    const birth = birthOf(pid);
    if (birth === null) continue;
    const table = processTable();
    if (!groups.some((pgid) => descendsFromGroup(pid, pgid, table))) continue;
    if (isSameProcess(pid, birth)) owned.push({ pid, birth });
  }
  return owned;
}
