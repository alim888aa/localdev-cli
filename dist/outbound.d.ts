/** A session's outbound network policy: "deny" blocks its services and seed from reaching anything but loopback. */
export type OutboundPolicy = "deny";
/**
 * The environment for a process under the policy, applied after the adapter's env so an adapter cannot undo it.
 * Node processes, including their Node children, load a preload that refuses non-loopback connections. The proxy
 * variables are cleared so nothing tunnels out through an egress proxy (Codex cloud sets one); in the cloud that
 * also cuts off most non-Node tools, while on a Mac they are not enforced (docs/adapter.md).
 */
export declare function applyOutboundPolicy(env: NodeJS.ProcessEnv, policy: OutboundPolicy | undefined): NodeJS.ProcessEnv;
