import { type OutboundPolicy } from "./outbound.js";
import { processHealth } from "./supervised.js";
import type { OwnedProcess, SessionReceipt } from "./types.js";
type ProcessHealth = Awaited<ReturnType<typeof processHealth>>;
/** Shared health verdict for matching and status: every process must be owned, alive and reachable. */
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
