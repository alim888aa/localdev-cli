import type { OutboundPolicy } from "./outbound.js";
import type { OwnedProcess, ServiceSpec } from "./types.js";
/** A failed app/web readiness wait with an unrelated listener: startup may retry the allocation. */
export declare class StartupPortCollisionError extends Error {
    constructor(name: string, port: number);
}
/**
 * A spawned service: record `owned` in the receipt first, then wait for it with ready(). If ready() fails, the
 * caller either stops every recorded process (startup) or calls abandon() for this one alone (a kill's restart).
 */
export interface LaunchedService {
    owned: OwnedProcess;
    ready(ensureActive: () => Promise<void>): Promise<void>;
    /** Stops this process group; false if its ownership could not be verified, so it must stay recorded. */
    abandon(): Promise<boolean>;
}
/**
 * The one way localdev starts a long-running process: startup's services, the fault proxy, and a service restarted
 * by `fault --mode kill`. Two phases, so a caller can spawn and record under the state lock and wait for
 * readiness outside it. `ports` maps the spec's ready port names to the ports it listens on (bind ports for
 * services, public ports for the proxy). `outbound` is the session's network policy (never applied to the proxy).
 */
export declare function launchService(spec: ServiceSpec, { root, sessionDir, ports, outbound, role }: {
    root: string;
    sessionDir: string;
    ports: Record<string, number>;
    outbound?: OutboundPolicy;
    role?: OwnedProcess["role"];
}): Promise<LaunchedService>;
