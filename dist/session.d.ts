import type { OutboundPolicy } from "./outbound.js";
import { processHealth } from "./supervised.js";
import type { OwnedProcess, SessionReceipt } from "./types.js";
type ProcessHealth = Awaited<ReturnType<typeof processHealth>>;
/**
 * The one health verdict, so duplicate matching and status cannot drift. A process is alive when its group is owned
 * and running and none of its ports is unreachable or held by another process. A ready session with a port that is
 * unreachable or not owned is degraded; one is healthy when it has processes and every one is alive.
 */
export declare function sessionHealth(receipt: SessionReceipt): Promise<{
    processes: Array<{
        record: OwnedProcess;
        groupOwned: boolean;
        alive: boolean;
        health: ProcessHealth;
    }>;
    healthy: boolean;
    degraded: boolean;
}>;
export interface StartOptions {
    fixture?: string;
    /** Project checkout; defaults to the current directory. */
    project?: string;
    /** Adapter file; defaults to <project>/local.adapter.mjs. */
    adapter?: string;
    /** --replace: true for "the one match", or a session ID. */
    replace?: true | string;
    parallel?: boolean;
    outbound?: OutboundPolicy;
}
/** `localdev startup`: start a session and return its status view, or throw once everything it started is stopped. */
export declare function startSession(options: StartOptions): Promise<object>;
/** A session as status and startup show it: never the service specs, env or credentials themselves. */
export declare function describeSession(receipt: SessionReceipt): Promise<object>;
/** `localdev stop`: stop one session; a stopped or unknown ID is reported as already gone. */
export declare function stopSession(id: string): Promise<{
    id: string;
    stopped: true;
    alreadyGone?: true;
}>;
export {};
