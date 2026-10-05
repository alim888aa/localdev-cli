import { readFileSync } from "node:fs";
import path from "node:path";

/** A session's outbound network policy: "deny" blocks its services and seed from reaching anything but loopback. */
export type OutboundPolicy = "deny";

/** One connection the guard refused, as the preload records it. */
export type OutboundRefusal = { at: string; host: string; port: number | null; service: string; pid: number };

const REFUSALS_FILE = "outbound-refused.jsonl";

const preload = new URL("./outbound-preload.js", import.meta.url).href;
const proxyVariables = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * The environment for a process under the policy, applied after the adapter's env so an adapter cannot undo it.
 * Node processes, including their Node children, load a preload that refuses non-loopback connections. The proxy
 * variables are cleared so nothing tunnels out through an egress proxy (Codex cloud sets one); in the cloud that
 * also cuts off most non-Node tools, while on a Mac they are not enforced (docs/adapter.md).
 */
export function applyOutboundPolicy(env: NodeJS.ProcessEnv, policy: OutboundPolicy | undefined,
  record?: { sessionDir: string; service: string }): NodeJS.ProcessEnv {
  if (policy !== "deny") return env;
  const denied: NodeJS.ProcessEnv = { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ") };
  // Where the preload records refusals, and whose they are (Node children inherit both).
  if (record) {
    denied.LOCALDEV_OUTBOUND_LOG = path.join(record.sessionDir, REFUSALS_FILE);
    denied.LOCALDEV_OUTBOUND_SERVICE = record.service;
  }
  for (const name of proxyVariables) denied[name] = "";
  delete denied.NODE_USE_ENV_PROXY;
  return denied;
}

/** The refusals recorded in a session, oldest first; unreadable lines are skipped. */
export function outboundRefusals(sessionDir: string): OutboundRefusal[] {
  let text: string;
  try { text = readFileSync(path.join(sessionDir, REFUSALS_FILE), "utf8"); }
  catch { return []; }
  return text.split("\n").flatMap((line) => {
    try {
      const item = JSON.parse(line) as OutboundRefusal;
      return typeof item?.host === "string" && typeof item.service === "string" ? [item] : [];
    } catch { return []; }
  });
}

/**
 * Why a guarded startup may have failed: the hosts the guard refused, per service, and the safe way forward.
 * Empty when nothing was refused (the failure had another cause).
 */
export function refusalExplanation(refusals: OutboundRefusal[]): string {
  if (!refusals.length) return "";
  const counts = new Map<string, number>();
  for (const { service, host, port } of refusals) {
    const key = `${service} → ${host}${port ? `:${port}` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const listed = [...counts].slice(0, 5).map(([key, count]) => count > 1 ? `${key} (${count}×)` : key).join(", ");
  const more = counts.size > 5 ? `, and ${counts.size - 5} more` : "";
  return ` The --no-outbound guard refused outside connections during startup: ${listed}${more}. If a tool was downloading ` +
    "something it needs (such as an emulator), warm its cache by starting this fixture once without --no-outbound " +
    "(or with the tool's own download command), then retry with the guard on.";
}
