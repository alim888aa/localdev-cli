import type { OutboundPolicy } from "./outbound.js";
/** A project adapter declares its port names and turns a fixture into local commands. */
export interface ProjectAdapter {
    ports: string[];
    /** Fixture used by plain `localdev startup`. */
    defaultFixture?: string;
    /**
     * Ports to put behind the session's fault proxy, so `fault` can fail, slow or hold their traffic. "http" counts
     * one HTTP request per fault use; "tcp" counts one accepted connection (postgres, gRPC). The proxy holds
     * `ports[name]` and the service must bind `bindPorts[name]` on 127.0.0.1. See docs/adr/0001.
     */
    proxyPorts?: Record<string, ProxyUnit>;
    /** Pure, ID-scoped project paths to record before createSession can write files. */
    cleanupPaths?(context: SessionContext): string[];
    createSession(context: SessionContext): Promise<SessionPlan> | SessionPlan;
}
export interface SessionContext {
    id: string;
    fixture: string;
    projectRoot: string;
    sessionDir: string;
    dataDir: string;
    /**
     * A short, private (0700) temp dir for this session alone, for TMPDIR: Unix sockets made under dataDir can pass
     * the macOS 104-byte path limit. The CLI creates it and removes it with the session, once its `.localdev-session`
     * marker (keep it) proves it is the session's.
     */
    tempDir: string;
    /** Ports clients and URLs use. */
    ports: Record<string, number>;
    /** Ports services listen on; differs from ports only for proxyPorts names. */
    bindPorts: Record<string, number>;
}
export type ProxyUnit = "http" | "tcp";
export interface CommandSpec {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}
export interface ServiceSpec extends CommandSpec {
    name: string;
    /** Safe mode ID for status, such as next-turbopack or vite. Never put secrets here. */
    launchMode?: string;
    readyPort?: string;
    readyPorts?: string[];
    readyHost?: string;
    readyTimeoutMs?: number;
}
export interface SessionPlan {
    services: ServiceSpec[];
    seed?: CommandSpec;
    urls?: Record<string, string>;
    credentialsFile?: string;
}
/** A PID plus its start time, so a later signal can prove it is still the same process. */
export interface ProcessIdentity {
    pid: number;
    birth: string;
}
/**
 * A fault that changes the session's processes, so stop and --clear must be able to undo or see it. Proxy faults
 * (fail, slow, hold) live only in the fault proxy: stopping the proxy undoes them.
 */
export type FaultRecord = PauseFault | KillFault;
/** An active pause: the session's own listener processes on one adapter port, frozen with SIGSTOP. */
export interface PauseFault {
    /** Adapter port name, as in the receipt's ports. */
    port: string;
    mode: "pause";
    pids: ProcessIdentity[];
    /** Other session ports served by the same process; they are frozen too. */
    sharedPorts: string[];
    since: string;
}
/** A kill in progress: the service was killed and is being restarted by the fault command that owns this record. */
export interface KillFault {
    port: string;
    mode: "kill";
    service: string;
    /** The fault command doing the restart; a record whose owner has gone is reported as interrupted. */
    owner: ProcessIdentity;
    since: string;
}
export interface OwnedProcess {
    name: string;
    /** The session's fault proxy; services have no role. */
    role?: "proxy";
    launchMode?: string;
    pid: number;
    birth: string;
    guardPid: number;
    guardBirth: string;
    log: string;
    exitFile: string;
    readyPort?: number;
    readyHost?: string;
    readyChecks?: Array<{
        name: string;
        port: number;
        host: string;
    }>;
    /** Descendant process groups started with their own group (e.g. detached emulators). */
    escapedGroups?: Array<{
        pgid: number;
        members: ProcessIdentity[];
    }>;
}
export interface SessionReceipt {
    id: string;
    fixture: string;
    projectRoot: string;
    commit: string | null;
    adapterPath: string;
    sessionDir: string;
    dataDir: string;
    /** The session's SessionContext.tempDir; missing in receipts from before it existed. */
    tempDir?: string;
    ports: Record<string, number>;
    /** Missing in receipts from before the fault proxy; then services bind ports. */
    bindPorts?: Record<string, number>;
    proxyPorts?: Record<string, ProxyUnit>;
    urls: Record<string, string>;
    credentialsFile?: string;
    /** The adapter's service specs, env included, so kill can restart one. Never shown by status. */
    services?: ServiceSpec[];
    /** Set by startup --no-outbound; every service, seed and restart runs under it. */
    outbound?: OutboundPolicy;
    cleanupPaths?: string[];
    processes: OwnedProcess[];
    /** Recorded before any process is paused, so stop and --clear can always resume it. */
    faults?: FaultRecord[];
    state: "starting" | "ready" | "failed" | "stopping";
    ownerPid: number;
    ownerBirth?: string;
    createdAt: string;
    error?: string;
}
