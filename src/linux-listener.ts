import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

type ProcessInfo = { parent: number; group: number };

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

function processTable(procRoot: string): Map<number, ProcessInfo> | null {
  const table = new Map<number, ProcessInfo>();
  let entries: string[];
  try { entries = readdirSync(procRoot); }
  catch { return null; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(path.join(procRoot, entry, "stat"), "utf8");
      const end = raw.lastIndexOf(")");
      if (end < 0) continue;
      // Fields after (comm) begin with state, parent PID, then process group.
      const fields = raw.slice(end + 1).trim().split(/\s+/);
      const parent = Number(fields[1]);
      const group = Number(fields[2]);
      if (Number.isSafeInteger(parent) && Number.isSafeInteger(group)) {
        table.set(Number(entry), { parent, group });
      }
    } catch { /* The process may have exited while we read it. */ }
  }
  return table;
}

function belongsToGroup(pid: number, group: number, table: Map<number, ProcessInfo>): boolean {
  const seen = new Set<number>();
  let current = pid;
  while (current > 1 && !seen.has(current)) {
    seen.add(current);
    const info = table.get(current);
    if (!info) return false;
    if (info.group === group) return true;
    current = info.parent;
  }
  return false;
}

/** null means procfs is unavailable; false means no verified owned listener. */
export function linuxListenerOwned(port: number, group: number, procRoot = "/proc"): boolean | null {
  const inodes = listenerInodes(port, procRoot);
  if (!inodes) return null;
  if (inodes.size === 0) return false;
  const table = processTable(procRoot);
  if (!table) return null;
  for (const pid of table.keys()) {
    if (!belongsToGroup(pid, group, table)) continue;
    let descriptors: string[];
    try { descriptors = readdirSync(path.join(procRoot, String(pid), "fd")); }
    catch { continue; }
    for (const descriptor of descriptors) {
      try {
        const target = readlinkSync(path.join(procRoot, String(pid), "fd", descriptor));
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && inodes.has(inode)) return true;
      } catch { /* A descriptor may close during inspection. */ }
    }
  }
  return false;
}
