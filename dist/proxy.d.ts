import type { OwnedProcess, ProxyUnit, ServiceSpec, SessionReceipt } from "./types.js";
/** One proxied port: the proxy listens on the public port and forwards to the service's bind port. */
export interface ProxyRoute {
    port: string;
    unit: ProxyUnit;
    listen: number;
    target: number;
}
export type ProxyMode = "fail" | "slow" | "hold";
/** What one use of a proxy fault counts on a port: an HTTP request, or a TCP connection. */
export type CountUnit = "request" | "connection";
export declare function countUnit(unit: ProxyUnit): CountUnit;
export type ProxyControl = {
    op: "set";
    port: string;
    mode: ProxyMode;
    ms?: number;
    count?: number;
} | {
    op: "release";
    port: string;
    count?: number;
} | {
    op: "clear";
    port: string;
} | {
    op: "state";
};
/** A proxied port's live state. `remaining` is null when the fault lasts until cleared. */
export interface ProxyPortState {
    port: string;
    unit: CountUnit;
    mode: "pass" | ProxyMode;
    ms?: number;
    remaining: number | null;
    held: number;
    /** When the current fault was set. */
    since?: string;
}
export type ProxyReply = {
    ok: true;
    ports: ProxyPortState[];
    released?: number;
} | {
    ok: false;
    error: string;
    port?: ProxyPortState;
};
/** Refuses an adapter service named like the fault proxy, which status and stop must tell apart. */
export declare function checkServiceName(name: string): void;
/**
 * How startup launches the session's fault proxy (through launchService, like any service), or null when the
 * adapter proxies no port. The proxy listens on, and is ready on, the public ports.
 */
export declare function proxyLaunch(receipt: SessionReceipt): {
    spec: ServiceSpec;
    ports: Record<string, number>;
    role: NonNullable<OwnedProcess["role"]>;
} | null;
/** Sends one control request to the session's proxy. Rejects when the proxy cannot be reached in time. */
export declare function controlProxy(receipt: SessionReceipt, request: ProxyControl, timeoutMs?: number): Promise<ProxyReply>;
