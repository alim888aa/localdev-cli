import type { SessionReceipt } from "./types.js";
export declare const stateRoot: string;
/** The one session-ID check: IDs are UUIDs, and only an ID that passes may name a path under the state dir. */
export declare function isSessionId(id: string): boolean;
export declare function sessionPath(id: string): string;
export declare function readReceipt(id: string): Promise<SessionReceipt>;
/** A receipt, or null when there is none (stop removes it, so stopped and unknown IDs look alike). Other errors throw. */
export declare function findReceipt(id: string): Promise<SessionReceipt | null>;
/** Thrown by updateReceipt when the session has no receipt; callers that expect that catch it. */
export declare class SessionGoneError extends Error {
    readonly id: string;
    constructor(id: string);
}
/**
 * The one receipt read-modify-write: under the state lock, read the receipt fresh, let fn check and change it, and
 * write it back if fn returns (a throw writes nothing). Throws SessionGoneError when it is missing. Not reentrant
 * (see withStateLock): code already holding the lock uses updateLockedReceipt.
 */
export declare function updateReceipt<T>(id: string, fn: (receipt: SessionReceipt) => Promise<T> | T): Promise<T>;
/** updateReceipt for a caller that already holds the state lock, such as reserveSession's beforeAllocate. */
export declare function updateLockedReceipt<T>(id: string, fn: (receipt: SessionReceipt) => Promise<T> | T): Promise<T>;
/**
 * updateReceipt without the final write: for a check that must not interleave with a change but changes nothing, or
 * a change that must be written (writeReceipt) before a side effect, such as recording a pause before signalling.
 */
export declare function withReceipt<T>(id: string, fn: (receipt: SessionReceipt) => Promise<T> | T): Promise<T>;
/** The ports a session's services listen on. Receipts store bindPorts only when ports are proxied. */
export declare function bindPortsOf(receipt: SessionReceipt): Record<string, number>;
export declare function listReceipts(): Promise<SessionReceipt[]>;
/** Write a receipt as is: only for a new receipt, or inside updateReceipt or withReceipt (lock held, read fresh). */
export declare function writeReceipt(receipt: SessionReceipt): Promise<void>;
export declare const lockPort: number;
/**
 * Run fn under the allocation lock. Receipt read-modify-writes go through updateReceipt, which uses it, so two
 * commands cannot each write back a receipt missing the other's change. Not reentrant: code already inside
 * reserveSession's beforeAllocate holds the lock and must not call this or updateReceipt (it would wait forever).
 */
export declare function withStateLock<T>(fn: () => Promise<T>): Promise<T>;
/**
 * Reserve a complete port set before another CLI invocation can allocate one. Each name in bindNames also gets a
 * private bind port (always from the random range); the others bind their public port. beforeAllocate runs with the
 * lock held (see withStateLock). Unique, non-empty port names are checked here, the one owner of that rule.
 */
export declare function reserveSession(names: string[], makeReceipt: (id: string, dir: string, ports: Record<string, number>, bindPorts: Record<string, number>) => SessionReceipt, beforeAllocate?: (receipts: SessionReceipt[]) => Promise<void>, bindNames?: string[]): Promise<SessionReceipt>;
