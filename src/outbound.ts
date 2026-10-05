/** A session's outbound network policy: "deny" blocks its services and seed from reaching anything but loopback. */
export type OutboundPolicy = "deny";

const preload = new URL("./outbound-preload.js", import.meta.url).href;
const proxyVariables = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * The environment for a process under the policy, applied after the adapter's env so an adapter cannot undo it.
 * Node processes, including their Node children, load a preload that refuses non-loopback connections. The proxy
 * variables are cleared so nothing tunnels out through an egress proxy (Codex cloud sets one); in the cloud that
 * also cuts off most non-Node tools, while on a Mac they are not enforced (docs/adapter.md).
 */
export function applyOutboundPolicy(env: NodeJS.ProcessEnv, policy: OutboundPolicy | undefined): NodeJS.ProcessEnv {
  if (policy !== "deny") return env;
  const denied: NodeJS.ProcessEnv = { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ") };
  for (const name of proxyVariables) denied[name] = "";
  delete denied.NODE_USE_ENV_PROXY;
  return denied;
}
