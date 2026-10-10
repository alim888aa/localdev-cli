import { listenerPids, ownedListener } from "./listener.js";
import { spawnSupervised, stopService, waitForService } from "./supervised.js";
/** A startup readiness failure with an unrelated app/web listener: startup may retry the allocation. */
export class StartupPortCollisionError extends Error {
    constructor(name, port) { super(`Port ${name} (${port}) was taken by an unrelated listener during startup`); }
}
/**
 * The one way localdev starts a long-running process: startup's services, the fault proxy, and a service restarted
 * by `fault --mode kill`. Two phases, so a caller can spawn and record under the state lock and wait for
 * readiness outside it. `ports` maps the spec's ready port names to the ports it listens on (bind ports for
 * services, public ports for the proxy). `outbound` is the session's network policy (never applied to the proxy).
 */
export async function launchService(spec, { root, sessionDir, ports, outbound, role }) {
    const names = spec.readyPorts ?? (spec.readyPort ? [spec.readyPort] : []);
    if (!names.length)
        throw new Error(`Service ${spec.name} has no readiness ports`);
    const checks = names.map((name) => {
        const port = ports[name];
        if (!port)
            throw new Error(`Unknown readyPort: ${name}`);
        return { name, port, host: spec.readyHost ?? "127.0.0.1" };
    });
    const { owned, child } = await spawnSupervised(spec.name, spec, root, sessionDir, outbound);
    if (role)
        owned.role = role;
    owned.launchMode = spec.launchMode;
    owned.readyPort = checks[0].port;
    owned.readyHost = checks[0].host;
    owned.readyChecks = checks;
    return {
        owned,
        async ready(ensureActive) {
            for (const check of checks) {
                try {
                    await waitForService(child, spec, check.port, owned, ensureActive);
                }
                catch (error) {
                    // Cancellation wins over a port collision, and never restarts a stopped session.
                    await ensureActive();
                    // A proxy can exit on a later port before its first readiness wait observes a listener.
                    const collision = (role === "proxy" ? checks : [check]).find(({ name, port }) => (name === "app" || name === "web") && listenerPids(port).length && !ownedListener(owned, port));
                    if (collision) {
                        throw new StartupPortCollisionError(collision.name, collision.port);
                    }
                    throw error;
                }
            }
        },
        async abandon() {
            const stopped = await stopService(owned);
            // The supervisor handle would otherwise keep the calling command alive.
            child.unref();
            return stopped;
        },
    };
}
