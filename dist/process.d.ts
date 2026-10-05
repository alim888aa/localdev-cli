import { type ChildProcess } from "node:child_process";
import { type OutboundPolicy } from "./outbound.js";
import type { CommandSpec, OwnedProcess, ProcessIdentity, ServiceSpec } from "./types.js";
export declare function birthOf(pid: number): string | null;
/** PIDs listening on a TCP port, whoever owns them. Ownership is checked by the caller. */
export declare function listenerPids(port: number): number[];
/**
 * Listeners on a port that belong to this session process: inside its verified group, or inside a recorded
 * escaped group that still has a verified member (its creator may have exited, so ancestry alone misses it).
 * A listener from another session or an unrelated app is never returned, so it can never be signalled.
 */
export declare function ownedListenerProcesses(record: OwnedProcess, port: number): ProcessIdentity[];
/**
 * Signal one recorded process only while it is still the same process (start time), never a reused PID.
 * "gone" means confirmed exited or reused; "failed" means it may still be the recorded process but was not signalled.
 */
export declare function signalProcess(member: ProcessIdentity, signal: NodeJS.Signals): "signalled" | "gone" | "failed";
export declare function spawnService(spec: ServiceSpec, root: string, dir: string, outbound?: OutboundPolicy): Promise<{
    owned: OwnedProcess;
    child: ChildProcess;
    exitFile: string;
}>;
export declare function spawnSeed(spec: CommandSpec, root: string, dir: string, outbound?: OutboundPolicy): Promise<{
    owned: OwnedProcess;
    child: ChildProcess;
    exitFile: string;
}>;
export declare function waitForService(child: ChildProcess, spec: ServiceSpec, port: number, record: OwnedProcess, ensureActive: () => Promise<void>): Promise<void>;
export declare function waitForSeed(child: ChildProcess, exitFile: string, timeoutMs?: number, ensureActive?: () => Promise<void>): Promise<void>;
/**
 * Stop the owned process group, including children left by an exited launcher and descendants that
 * moved into their own groups. Returns false unless every owned group is verified gone. `hard` sends SIGKILL at
 * once, like a crash, for `fault --mode kill`.
 */
export declare function stopService(record: OwnedProcess, { hard }?: {
    hard?: boolean;
}): Promise<boolean>;
/** The owned group still has a live (non-zombie) member and its identity checks out. */
export declare function processAlive(record: OwnedProcess): boolean;
export declare function processHealth(record: OwnedProcess): Promise<{
    reachable: boolean | null;
    listenerOwned: boolean | null;
    checks: Array<{
        name: string;
        reachable: boolean;
        listenerOwned: boolean;
    }>;
    commandExit: object | null;
}>;
