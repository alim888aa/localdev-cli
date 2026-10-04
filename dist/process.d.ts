import { type ChildProcess } from "node:child_process";
import type { CommandSpec, OwnedProcess, ServiceSpec } from "./types.js";
export declare function birthOf(pid: number): string | null;
export declare function spawnService(spec: ServiceSpec, root: string, dir: string): Promise<{
    owned: OwnedProcess;
    child: ChildProcess;
    exitFile: string;
}>;
export declare function spawnSeed(spec: CommandSpec, root: string, dir: string): Promise<{
    owned: OwnedProcess;
    child: ChildProcess;
    exitFile: string;
}>;
export declare function waitForService(child: ChildProcess, spec: ServiceSpec, port: number, record: OwnedProcess, ensureActive: () => Promise<void>): Promise<void>;
export declare function waitForSeed(child: ChildProcess, exitFile: string, timeoutMs?: number, ensureActive?: () => Promise<void>): Promise<void>;
/**
 * Stop the owned process group, including children left by an exited launcher and descendants that
 * moved into their own groups. Returns false unless every owned group is verified gone.
 */
export declare function stopService(record: OwnedProcess): Promise<boolean>;
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
