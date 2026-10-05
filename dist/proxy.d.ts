import type { ProxyUnit, ServiceSpec, SessionReceipt } from "./types.js";
/** One proxied port: the proxy listens on the public port and forwards to the service's bind port. */
export interface ProxyRoute {
    port: string;
    unit: ProxyUnit;
    listen: number;
    target: number;
}
export type ProxyMode = "fail" | "slow" | "hold";
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
    unit: "request" | "connection";
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
export declare const PROXY_NAME = "localdev-proxy";
/** The proxy as a service spec for launchService, or null when the adapter proxies no port. */
export declare function proxySpec(receipt: SessionReceipt): ServiceSpec | null;
/** Sends one control request to the session's proxy. Rejects when the proxy cannot be reached in time. */
export declare function controlProxy(receipt: SessionReceipt, request: ProxyControl, timeoutMs?: number): Promise<ProxyReply>;
