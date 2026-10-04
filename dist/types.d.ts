/** A project adapter declares its port names and turns a fixture into local commands. */
export interface ProjectAdapter {
    ports: string[];
    /** Fixture used by plain `localdev startup`. */
    defaultFixture?: string;
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
    ports: Record<string, number>;
}
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
/** An active `localdev fault`: the session's own listener processes on one adapter port, frozen with SIGSTOP. */
export interface FaultRecord {
    /** Adapter port name, as in the receipt's ports. */
    port: string;
    mode: "pause";
    pids: ProcessIdentity[];
    /** Other session ports served by the same process; they are frozen too. */
    sharedPorts: string[];
    since: string;
}
export interface OwnedProcess {
    name: string;
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
    ports: Record<string, number>;
    urls: Record<string, string>;
    credentialsFile?: string;
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
