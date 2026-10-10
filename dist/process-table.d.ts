export interface ProcessEntry {
    pid: number;
    parent: number;
    group: number;
    zombie: boolean;
}
/** The boot identity a /proc birth carries, or null when none is valid. Exported for tests. */
export declare function readBootId(procRoot: string): string | null;
/** Every process in a procfs root; null when it cannot be read. Exported for the listener module and tests. */
export declare function readProcTable(procRoot?: string): ProcessEntry[] | null;
/**
 * A process's birth, to record now and compare later with isSameProcess. Null when the process is gone or
 * unreadable. Never compare births directly: their format depends on the backend that recorded them.
 */
export declare function birthOf(pid: number): string | null;
/**
 * This process's birth, or why this runtime cannot verify process identity. Ask before starting anything: owned
 * processes are recorded and later signalled by the births this module reads, so a runtime where that read names
 * the wrong process, or nothing, must be refused. procRoot and pid read a procfs root instead (tests).
 */
export declare function ownIdentity(procRoot?: string, pid?: number): {
    birth: string;
} | {
    problem: string;
};
/**
 * Whether pid is still the process whose birth was recorded, never a later one reusing the PID. The recorded
 * format picks the backend, so a receipt written by an older localdev (ps start times) still matches wherever ps
 * works.
 */
export declare function isSameProcess(pid: number, recordedBirth: string | null | undefined): boolean;
/**
 * The tri-state behind isSameProcess, for callers that must tell a reused PID ("different") from a birth that
 * could not be read ("unknown": the process is gone, or it exists but is unreadable and may still be the one).
 */
export declare function compareBirth(pid: number, recordedBirth: string | null | undefined): "same" | "different" | "unknown";
/** The whole process table, or null when it cannot be read (callers then fail safe). */
export declare function listProcesses(): ProcessEntry[] | null;
/** One process, or null when it is gone or unreadable. */
export declare function processEntry(pid: number): ProcessEntry | null;
export type ProcessTable = Map<number, ProcessEntry>;
/** The process table keyed by PID, or null when unreadable. procRoot reads a procfs root instead (tests). */
export declare function processTable(procRoot?: string): ProcessTable | null;
/**
 * Whether pid is in group pgid or has an ancestor that is: the one parent-chain walk. A child that moved into its
 * own group still descends from the group while its parent chain reaches it. False when the table is unreadable.
 */
export declare function descendsFromGroup(pid: number, pgid: number, table?: ProcessTable | null): boolean;
/** The PID exists, whoever owns it: only ESRCH means gone (EPERM is a live process of another user). */
export declare function processExists(pid: number): boolean;
