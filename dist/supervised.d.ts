import { type ChildProcess } from "node:child_process";
import { type OutboundPolicy } from "./outbound.js";
import type { CommandSpec, OwnedProcess, ProcessIdentity, ServiceSpec } from "./types.js";
/**
 * The process groups whose listeners count as this session process's own: its verified group, and each recorded
 * escaped group that still has a verified member (its creator may have exited, so ancestry alone misses it).
 * Pass them to listener.ts ownedListenerProcesses.
 */
export declare function ownedGroups(record: OwnedProcess): number[];
/**
 * Signal one recorded process only while it is still the same process (start time), never a reused PID.
 * "gone" means confirmed exited or reused; "failed" means it may still be the recorded process but was not signalled.
 */
export declare function signalProcess(member: ProcessIdentity, signal: NodeJS.Signals): "signalled" | "gone" | "failed";
/** What supervisor.ts recorded when the command exited. */
export interface CommandExit {
    code: number | null;
    signal: string | null;
    error?: string;
}
/** The command's recorded exit, or null while it has not exited (no exit file yet). Other read errors throw. */
export declare function readExit(exitFile: string): Promise<CommandExit | null>;
/**
 * Start a command in its own process group under a persistent supervisor, which keeps the group identifiable if a
 * launcher exits. `name` names the log (services use their spec name, the seed "seed").
 */
export declare function spawnSupervised(name: string, spec: CommandSpec, root: string, sessionDir: string, outbound?: OutboundPolicy): Promise<{
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
