import { type ProxyMode } from "./proxy.js";
import type { PauseFault, SessionReceipt } from "./types.js";
export declare const faultModes: readonly ["pause", "fail", "slow", "hold", "kill"];
export type FaultMode = typeof faultModes[number];
export declare function isFaultMode(mode: string): mode is FaultMode;
export type FaultRequest = {
    mode: "pause";
    port: string;
} | {
    mode: "kill";
    port: string;
} | {
    mode: "fail" | "hold";
    port: string;
    count?: number;
} | {
    mode: "slow";
    port: string;
    ms: number;
    count?: number;
};
/** A fault as status and the fault command show it. `unit` says what a count counts, or that it acts on processes. */
export type FaultView = (PauseFault & {
    unit: "process";
}) | {
    port: string;
    mode: "kill";
    unit: "process";
    service: string;
    state: "restarting" | "interrupted";
    since: string;
} | {
    port: string;
    mode: ProxyMode;
    unit: "request" | "connection";
    ms?: number;
    remaining: number | null;
    held: number;
    since?: string;
};
type ClearedFault = (PauseFault & {
    resumed: number[];
}) | {
    port: string;
    mode: "kill";
    service: string;
} | {
    port: string;
    mode: ProxyMode;
    unit: "request" | "connection";
    released: number;
};
/**
 * Every active fault, for status. The proxy is asked only when the session has one; when it cannot be reached its
 * faults are unknown, so status reports the proxy as unreachable instead of listing them.
 */
export declare function activeFaults(receipt: SessionReceipt): Promise<{
    faults: FaultView[];
    proxy?: "unreachable";
}>;
export type KillResult = {
    port: string;
    mode: "kill";
    service: string;
    sharedPorts: string[];
    oldPid: number;
    pid: number;
};
/** Start one fault. Every mode goes through here; `localdev fault` only parses its flags. */
export declare function applyFault(id: string, request: FaultRequest): Promise<FaultView | KillResult>;
/** Let held requests on a port through, oldest first: `count` of them, or all. */
export declare function releaseHeld(id: string, portName: string, count?: number): Promise<{
    port: string;
    released: number;
    held: number;
}>;
/**
 * Clear one port's faults, or every fault when no port is named. Paused processes resume before their record goes;
 * one that could not be resumed keeps its record, and the command fails after saving that, naming the PIDs. Proxy
 * faults end at once and their held requests go on in arrival order. A kill still restarting is left alone.
 */
export declare function clearFaults(id: string, portName?: string): Promise<ClearedFault[]>;
/**
 * Stop calls this first: a paused process keeps SIGTERM pending until it is continued. Unresolved members stay
 * recorded, so a stop that cannot verify termination keeps them for inspection. The caller writes the receipt.
 * Proxy faults need nothing here: stopping the proxy ends them and drops what it held.
 */
export declare function resumeAllFaults(receipt: SessionReceipt): void;
export {};
