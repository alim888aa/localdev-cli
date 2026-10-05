import type { OwnedProcess, ServiceSpec } from "./types.js";
/** A spawned service: record `owned` in the receipt first, then wait for it with ready(). */
export interface LaunchedService {
    owned: OwnedProcess;
    ready(ensureActive: () => Promise<void>): Promise<void>;
}
/**
 * The one way localdev starts a long-running process: startup's services, the fault proxy, and a service restarted
 * by `fault --mode kill`. Two phases, so a caller can spawn and record under the state lock and wait for
 * readiness outside it. `ports` maps the spec's ready port names to the ports it listens on (bind ports for
 * services, public ports for the proxy).
 */
export declare function launchService(spec: ServiceSpec, { root, sessionDir, ports }: {
    root: string;
    sessionDir: string;
    ports: Record<string, number>;
}): Promise<LaunchedService>;
