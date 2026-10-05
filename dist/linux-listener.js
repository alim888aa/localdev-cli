import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { readProcTable } from "./process-table.js";
/** Read the socket inode for TCP listeners on one port in the current network namespace. */
function listenerInodes(port, procRoot) {
    const inodes = new Set();
    let readAny = false;
    for (const file of ["tcp", "tcp6"]) {
        try {
            const rows = readFileSync(path.join(procRoot, "net", file), "utf8").split("\n");
            readAny = true;
            for (const row of rows.slice(1)) {
                const fields = row.trim().split(/\s+/);
                if (fields.length < 10 || fields[3] !== "0A")
                    continue;
                const localPort = Number.parseInt(fields[1].split(":").at(-1) ?? "", 16);
                if (localPort === port && /^\d+$/.test(fields[9]))
                    inodes.add(fields[9]);
            }
        }
        catch { /* Some hosts disable one address family. */ }
    }
    return readAny ? inodes : null;
}
function processTable(procRoot) {
    const entries = readProcTable(procRoot);
    return entries && new Map(entries.map(({ pid, parent, group }) => [pid, { parent, group }]));
}
function belongsToGroup(pid, group, table) {
    const seen = new Set();
    let current = pid;
    while (current > 1 && !seen.has(current)) {
        seen.add(current);
        const info = table.get(current);
        if (!info)
            return false;
        if (info.group === group)
            return true;
        current = info.parent;
    }
    return false;
}
function holdsSocket(pid, inodes, procRoot) {
    let descriptors;
    try {
        descriptors = readdirSync(path.join(procRoot, String(pid), "fd"));
    }
    catch {
        return false;
    }
    for (const descriptor of descriptors) {
        try {
            const target = readlinkSync(path.join(procRoot, String(pid), "fd", descriptor));
            const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
            if (inode && inodes.has(inode))
                return true;
        }
        catch { /* A descriptor may close during inspection. */ }
    }
    return false;
}
/** null means procfs is unavailable; false means no verified owned listener. */
export function linuxListenerOwned(port, group, procRoot = "/proc") {
    const inodes = listenerInodes(port, procRoot);
    if (!inodes)
        return null;
    if (inodes.size === 0)
        return false;
    const table = processTable(procRoot);
    if (!table)
        return null;
    for (const pid of table.keys()) {
        if (belongsToGroup(pid, group, table) && holdsSocket(pid, inodes, procRoot))
            return true;
    }
    return false;
}
/** Every PID holding a TCP listener on the port, whoever owns it; null means procfs is unavailable. */
export function linuxListenerPids(port, procRoot = "/proc") {
    const inodes = listenerInodes(port, procRoot);
    if (!inodes)
        return null;
    if (inodes.size === 0)
        return [];
    const table = processTable(procRoot);
    if (!table)
        return null;
    return [...table.keys()].filter((pid) => holdsSocket(pid, inodes, procRoot));
}
