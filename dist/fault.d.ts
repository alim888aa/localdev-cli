import type { FaultRecord, SessionReceipt } from "./types.js";
export type FaultMode = FaultRecord["mode"];
export declare function isFaultMode(mode: string): mode is FaultMode;
/**
 * Freeze the session's own listener processes on one port with SIGSTOP. Clients can still connect (the kernel
 * accepts into the backlog) but get no response, like a hung service, and the service keeps its state.
 * Other services keep running because only the listener processes are signalled, not the session group.
 */
export declare function pauseService(receipt: SessionReceipt, portName: string): Promise<FaultRecord>;
/**
 * Clear one port's fault, or every fault when no port is named. Processes resume before the record goes; a process
 * that could not be resumed keeps its record, and the command fails after saving that, naming the PIDs.
 */
export declare function clearFaults(receipt: SessionReceipt, portName?: string): Promise<Array<FaultRecord & {
    resumed: number[];
}>>;
/**
 * Stop calls this first: a paused process keeps SIGTERM pending until it is continued. Unresolved members stay
 * recorded, so a stop that cannot verify termination keeps them for inspection. The caller writes the receipt.
 */
export declare function resumeAllFaults(receipt: SessionReceipt): void;
