import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runSync } from "./run-sync.js";
const PROC_BIRTH = "proc:";
const useProc = process.platform === "linux" && readableProc("/proc");
// /proc start times count clock ticks since boot, and receipts outlive reboots, so a /proc birth also names the
// boot: a process after a reboot never matches one recorded before it, even with the same PID and start tick.
const bootId = useProc ? readBootId("/proc") : "";
function readBootId(procRoot) {
    try {
        return readFileSync(path.join(procRoot, "sys", "kernel", "random", "boot_id"), "utf8").trim();
    }
    catch { /* Fall back to the boot time. */ }
    try {
        return `btime${/^btime (\d+)$/m.exec(readFileSync(path.join(procRoot, "stat"), "utf8"))?.[1] ?? ""}`;
    }
    catch {
        return "unknown";
    }
}
function readableProc(procRoot) {
    try {
        readFileSync(path.join(procRoot, "self", "stat"), "utf8");
        return true;
    }
    catch {
        return false;
    }
}
/** The fields of /proc/<pid>/stat after the command name, which may itself contain spaces and parentheses. */
function procStat(pid, procRoot) {
    try {
        const raw = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
        const end = raw.lastIndexOf(")");
        return end < 0 ? null : raw.slice(end + 1).trim().split(/\s+/);
    }
    catch {
        return null;
    }
}
// After the command name: state, parent, group, ..., and start time (stat field 22, index 19 here).
function procEntry(pid, procRoot) {
    const fields = procStat(pid, procRoot);
    if (!fields)
        return null;
    const parent = Number(fields[1]);
    const group = Number(fields[2]);
    if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(group))
        return null;
    return { pid, parent, group, zombie: fields[0] === "Z" || fields[0] === "X" };
}
function procBirth(pid, procRoot = "/proc") {
    const start = procStat(pid, procRoot)?.[19];
    return start && /^\d+$/.test(start) ? `${PROC_BIRTH}${bootId}:${start}` : null;
}
/** Every process in a procfs root; null when it cannot be read. Exported for linux-listener and its tests. */
export function readProcTable(procRoot = "/proc") {
    let entries;
    try {
        entries = readdirSync(procRoot);
    }
    catch {
        return null;
    }
    return entries.filter((entry) => /^\d+$/.test(entry))
        .map((entry) => procEntry(Number(entry), procRoot))
        .filter((entry) => entry !== null);
}
function psBirth(pid) {
    try {
        return runSync("ps", ["-o", "lstart=", "-p", String(pid)]).trim() || null;
    }
    catch {
        return null;
    }
}
function psTable() {
    let output;
    try {
        output = runSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="]);
    }
    catch {
        return null;
    }
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
export function birthOf(pid) {
    return useProc ? procBirth(pid) : psBirth(pid);
}
/**
 * Whether pid is still the process whose birth was recorded, never a later one reusing the PID. The recorded
 * format picks the backend, so a receipt written by an older localdev (ps start times) still matches wherever ps
 * works.
 */
export function isSameProcess(pid, recordedBirth) {
    return compareBirth(pid, recordedBirth) === "same";
}
/**
 * The tri-state behind isSameProcess, for callers that must tell a reused PID ("different") from a birth that
 * could not be read ("unknown": the process is gone, or it exists but is unreadable and may still be the one).
 */
export function compareBirth(pid, recordedBirth) {
    if (!recordedBirth)
        return "unknown";
    const current = recordedBirth.startsWith(PROC_BIRTH) ? procBirth(pid) : psBirth(pid);
    if (current === null)
        return "unknown";
    return current === recordedBirth ? "same" : "different";
}
/** The whole process table, or null when it cannot be read (callers then fail safe). */
export function listProcesses() {
    return useProc ? readProcTable() : psTable();
}
/** One process, or null when it is gone or unreadable. */
export function processEntry(pid) {
    if (useProc)
        return procEntry(pid, "/proc");
    try {
        const [parent, group, stat] = runSync("ps", ["-o", "ppid=,pgid=,stat=", "-p", String(pid)]).trim().split(/\s+/);
        const entry = { pid, parent: Number(parent), group: Number(group), zombie: (stat ?? "").startsWith("Z") };
        return Number.isSafeInteger(entry.parent) && Number.isSafeInteger(entry.group) ? entry : null;
    }
    catch {
        return null;
    }
}
