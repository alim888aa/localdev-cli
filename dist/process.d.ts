import { type ChildProcess } from "node:child_process";
import type { CommandSpec, OwnedProcess, ServiceSpec } from "./types.js";
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
export declare function waitForService(child: ChildProcess, spec: ServiceSpec, port: number, record: OwnedProcess): Promise<void>;
export declare function waitForSeed(child: ChildProcess, exitFile: string, timeoutMs?: number): Promise<void>;
/** Stop the owned process group, including children left by an exited launcher. */
export declare function stopService(record: OwnedProcess): Promise<boolean>;
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
