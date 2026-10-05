export interface ProcessEntry {
    pid: number;
    parent: number;
    group: number;
    zombie: boolean;
}
/** Every process in a procfs root; null when it cannot be read. Exported for linux-listener and its tests. */
export declare function readProcTable(procRoot?: string): ProcessEntry[] | null;
/**
 * A process's birth, to record now and compare later with isSameProcess. Null when the process is gone or
 * unreadable. Never compare births directly: their format depends on the backend that recorded them.
 */
export declare function birthOf(pid: number): string | null;
/**
 * Whether pid is still the process whose birth was recorded, never a later one reusing the PID. The recorded
 * format picks the backend, so a receipt written by an older localdev (ps start times) still matches wherever ps
 * works.
 */
export declare function isSameProcess(pid: number, recordedBirth: string | null | undefined): boolean;
/** The whole process table, or null when it cannot be read (callers then fail safe). */
export declare function listProcesses(): ProcessEntry[] | null;
/** One process, or null when it is gone or unreadable. */
export declare function processEntry(pid: number): ProcessEntry | null;
