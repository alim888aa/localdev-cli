/** A session's outbound network policy: "deny" blocks its services and seed from reaching anything but loopback. */
export type OutboundPolicy = "deny";
/** One connection the guard refused, as the preload records it. */
export type OutboundRefusal = {
    at: string;
    host: string;
    port: number | null;
    service: string;
    pid: number;
};
/**
 * The environment for a process under the policy, applied after the adapter's env so an adapter cannot undo it.
 * Node processes, including their Node children, load a preload that refuses non-loopback connections. The proxy
 * variables are cleared so nothing tunnels out through an egress proxy (Codex cloud sets one); in the cloud that
 * also cuts off most non-Node tools, while on a Mac they are not enforced (docs/adapter.md).
 */
export declare function applyOutboundPolicy(env: NodeJS.ProcessEnv, policy: OutboundPolicy | undefined, record?: {
    sessionDir: string;
    service: string;
}): NodeJS.ProcessEnv;
/** The refusals recorded in a session, oldest first; unreadable lines are skipped. */
export declare function outboundRefusals(sessionDir: string): OutboundRefusal[];
/**
 * Why a guarded startup may have failed: the hosts the guard refused, per service, and the safe way forward.
 * Empty when nothing was refused (the failure had another cause).
 */
export declare function refusalExplanation(refusals: OutboundRefusal[]): string;
