import type { ProcessIdentity } from "./types.js";
/** The /proc backend: every PID holding a TCP listener on the port; null means procfs is unavailable. Exported for tests. */
export declare function procListenerPids(port: number, procRoot?: string): number[] | null;
/** PIDs listening on a TCP port, whoever owns them. Ownership is checked by ownedListener or ownedListenerProcesses. */
export declare function listenerPids(port: number): number[];
/**
 * The health check: a listener on the port descends from the record's process group, so another app cannot make an
 * owned session look healthy. Ancestry only; signalling a listener needs ownedListenerProcesses.
 */
export declare function ownedListener(record: {
    pid: number;
}, port: number): boolean;
/**
 * Listeners on a port that descend from one of the given verified process groups (a session process's own group
 * and its recorded escaped groups: supervised.ts ownedGroups), with their births, safe to signal. A listener from
 * another session or an unrelated app is never returned.
 */
export declare function ownedListenerProcesses(groups: number[], port: number): ProcessIdentity[];
