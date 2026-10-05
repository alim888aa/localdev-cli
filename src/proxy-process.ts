// The session's fault proxy: a session-owned process (started like any service) that holds each opted-in public
// port and forwards to the service's bind port. Faults on a port fail, slow or hold its requests ("http") or
// connections ("tcp"). The live fault state exists only here; the CLI reads and changes it over proxy.sock.
import http from "node:http";
import net from "node:net";
import { rmSync } from "node:fs";
import { pipeline } from "node:stream";
import type { ProxyControl, ProxyPortState, ProxyReply, ProxyRoute } from "./proxy.js";

type Pending = { proceed: () => void; dropped: () => boolean };
type PortState = {
  route: ProxyRoute;
  mode: "pass" | "fail" | "slow" | "hold";
  ms?: number;
  /** Requests or connections the fault still applies to; null until cleared. */
  remaining: number | null;
  held: Pending[];
  since?: string;
};

const routes = JSON.parse(process.argv[2]) as ProxyRoute[];
const ports = new Map(routes.map((route) => [route.port, { route, mode: "pass", remaining: null, held: [] } as PortState]));

// One arriving request or connection: forwarded, delayed, refused or parked by the port's fault. A fault with a
// count applies to that many arrivals, then the port passes traffic again (requests it parked stay held).
function admit(state: PortState, proceed: () => void, refuse: () => void, dropped: () => boolean): void {
  const { mode, ms } = state;
  if (mode === "pass") return proceed();
  if (state.remaining !== null && --state.remaining <= 0) passTraffic(state);
  if (mode === "fail") return refuse();
  if (mode === "slow") { setTimeout(() => { if (!dropped()) proceed(); }, ms); return; }
  state.held.push({ proceed, dropped });
}

function passTraffic(state: PortState): void {
  state.mode = "pass";
  state.remaining = null;
  delete state.ms;
  delete state.since;
}

/** Lets held arrivals through, oldest first, skipping clients that already went away. */
function release(state: PortState, count: number): number {
  let released = 0;
  while (released < count && state.held.length) {
    const next = state.held.shift()!;
    if (next.dropped()) continue;
    next.proceed();
    released++;
  }
  return released;
}

function view(state: PortState): ProxyPortState {
  state.held = state.held.filter((item) => !item.dropped());
  return {
    port: state.route.port, unit: state.route.unit === "http" ? "request" : "connection", mode: state.mode,
    ...(state.ms === undefined ? {} : { ms: state.ms }), remaining: state.remaining, held: state.held.length,
    ...(state.since ? { since: state.since } : {}),
  };
}

// Hop-by-hop headers belong to one connection; Node frames the forwarded message itself.
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
function endToEnd(raw: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    if (!hopByHop.has(raw[index].toLowerCase())) kept.push(raw[index], raw[index + 1]);
  }
  return kept;
}

const agent = new http.Agent({ keepAlive: true });

/**
 * Forwards one admitted HTTP request with a single paired cleanup: an abort, error or early close on either side
 * tears down both. A truncated upstream answer cuts the client's response instead of leaving it waiting, and a
 * client that goes away releases the upstream request.
 */
function forwardHttp(request: http.IncomingMessage, response: http.ServerResponse, target: number): void {
  let ended = false;
  const end = (error?: unknown) => {
    if (ended || !error) return;
    ended = true;
    upstream.destroy();
    // Before any answer the client sees a reset, as from a crashed service; after it, a cut-off response.
    if (!response.headersSent) request.socket.resetAndDestroy();
    else response.destroy();
  };
  const upstream = http.request({ host: "127.0.0.1", port: target, method: request.method, path: request.url,
    headers: endToEnd(request.rawHeaders), agent }, (answer) => {
    answer.on("error", end);
    response.writeHead(answer.statusCode ?? 502, answer.statusMessage, endToEnd(answer.rawHeaders));
    pipeline(answer, response, end);
  });
  // Kept for the whole exchange: the upstream socket can fail after the request body was sent.
  upstream.on("error", end);
  request.on("error", end);
  response.once("close", () => { if (!response.writableFinished) end(new Error("the client closed the connection")); });
  pipeline(request, upstream, end);
}

function serveHttp(state: PortState): net.Server {
  const { target } = state.route;
  // No request timeout: a held request waits as long as the fault holds it.
  const server = http.createServer({ requestTimeout: 0 }, (request, response) => {
    const dropped = () => response.destroyed || request.socket.destroyed;
    admit(state, () => forwardHttp(request, response, target), () => request.socket.resetAndDestroy(), dropped);
  });
  // Websocket upgrades (e.g. dev-server HMR) count as one request and are relayed raw once admitted.
  server.on("upgrade", (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    admit(state, () => {
      const upstream = net.connect({ host: "127.0.0.1", port: target }, () => {
        const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
        for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
        upstream.write(lines.join("\r\n") + "\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(socket).pipe(upstream);
      });
      upstream.once("error", () => socket.resetAndDestroy());
      socket.once("error", () => upstream.destroy());
    }, () => socket.resetAndDestroy(), () => socket.destroyed);
  });
  return server;
}

function serveTcp(state: PortState): net.Server {
  const { target } = state.route;
  return net.createServer({ pauseOnConnect: true }, (client) => {
    client.once("error", () => undefined);
    admit(state, () => {
      const upstream = net.connect({ host: "127.0.0.1", port: target });
      upstream.once("error", () => client.resetAndDestroy());
      client.once("error", () => upstream.destroy());
      client.pipe(upstream).pipe(client);
      client.resume();
    }, () => client.resetAndDestroy(), () => client.destroyed);
  });
}

function control(request: ProxyControl): ProxyReply {
  if (request.op === "state") return { ok: true, ports: [...ports.values()].map(view) };
  const state = ports.get(request.port);
  if (!state) return { ok: false, error: `Port ${request.port} is not proxied` };
  if (request.op === "set") {
    // Checked here as well as by the CLI, so two fault commands cannot both set the same port.
    const current = view(state);
    if (current.mode !== "pass" || current.held) return { ok: false, error: "busy", port: current };
    state.mode = request.mode;
    state.remaining = request.count ?? null;
    state.since = new Date().toISOString();
    if (request.mode === "slow") state.ms = request.ms;
    return { ok: true, ports: [view(state)] };
  }
  if (request.op === "release") {
    const released = release(state, request.count ?? Infinity);
    return { ok: true, released, ports: [view(state)] };
  }
  // clear: back to pass-through, and everything held goes on in arrival order.
  const before = view(state);
  passTraffic(state);
  const released = release(state, Infinity);
  return { ok: true, released, ports: [before] };
}

function listen(server: net.Server, target: number | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(typeof target === "number" ? { host: "127.0.0.1", port: target, exclusive: true } : target, () => resolve());
  });
}

// The control socket is relative to the working directory (the session dir): macOS limits socket paths to 104 bytes.
rmSync("proxy.sock", { force: true });
const controlServer = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end < 0) return;
    let reply: ProxyReply;
    try { reply = control(JSON.parse(buffer.slice(0, end)) as ProxyControl); }
    catch (error) { reply = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    socket.end(JSON.stringify(reply) + "\n");
  });
  socket.once("error", () => undefined);
});
// Control first: once the public ports answer (the readiness check), the CLI can already set faults.
await listen(controlServer, "proxy.sock");
for (const state of ports.values()) await listen(state.route.unit === "http" ? serveHttp(state) : serveTcp(state), state.route.listen);
console.log(`localdev fault proxy ready: ${routes.map((route) => `${route.port} ${route.listen}->${route.target} (${route.unit})`).join(", ")}`);
