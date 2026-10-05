import { spawnService, waitForService } from "./process.js";
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
export async function launchService(spec: ServiceSpec, { root, sessionDir, ports }: {
  root: string; sessionDir: string; ports: Record<string, number>;
}): Promise<LaunchedService> {
  const names = spec.readyPorts ?? (spec.readyPort ? [spec.readyPort] : []);
  if (!names.length) throw new Error(`Service ${spec.name} has no readiness ports`);
  const checks = names.map((name) => {
    const port = ports[name];
    if (!port) throw new Error(`Unknown readyPort: ${name}`);
    return { name, port, host: spec.readyHost ?? "127.0.0.1" };
  });
  const { owned, child } = await spawnService(spec, root, sessionDir);
  owned.launchMode = spec.launchMode;
  owned.readyPort = checks[0].port;
  owned.readyHost = checks[0].host;
  owned.readyChecks = checks;
  return {
    owned,
    async ready(ensureActive) {
      for (const check of checks) await waitForService(child, spec, check.port, owned, ensureActive);
    },
  };
}
