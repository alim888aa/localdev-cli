import type { SessionReceipt } from "./types.js";
export declare const stateRoot: string;
export declare function sessionPath(id: string): string;
export declare function readReceipt(id: string): Promise<SessionReceipt>;
export declare function listReceipts(): Promise<SessionReceipt[]>;
export declare function writeReceipt(receipt: SessionReceipt): Promise<void>;
export declare const lockPort: number;
/**
 * Run fn under the allocation lock. Receipt read-modify-writes that must not interleave (fault, the start of stop)
 * use it, so two commands cannot each write back a receipt missing the other's change. Not reentrant: code already
 * inside reserveSession's beforeAllocate holds the lock and must not call this.
 */
export declare function withStateLock<T>(fn: () => Promise<T>): Promise<T>;
/** Reserve a complete port set before another CLI invocation can allocate one. */
export declare function reserveSession(names: string[], makeReceipt: (id: string, dir: string, ports: Record<string, number>) => SessionReceipt, beforeAllocate?: (receipts: SessionReceipt[]) => Promise<void>): Promise<SessionReceipt>;
