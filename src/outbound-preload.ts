// Loaded into every Node process of a `localdev startup --no-outbound` session (NODE_OPTIONS=--import). It refuses
// TCP connections to anything but loopback and unix sockets, which covers http, https, tls and fetch. A hostname is
// resolved first, so names that point at loopback (localhost, /etc/hosts aliases) still work. Not a sandbox: other
// runtimes, UDP and DNS lookups themselves are not covered.
import dns from "node:dns";
import { appendFileSync } from "node:fs";
import net from "node:net";

// Tools often swallow the error text, so each refusal is also recorded in the session's private file (see
// outbound.ts), at most MAX_RECORDED per process, for startup's explanation and status.
const refusalLog = process.env.LOCALDEV_OUTBOUND_LOG;
const service = process.env.LOCALDEV_OUTBOUND_SERVICE ?? "unknown";
const MAX_RECORDED = 100;
let recorded = 0;

function refused(host: string, port: unknown): Error {
  if (refusalLog && recorded < MAX_RECORDED) {
    recorded++;
    try {
      appendFileSync(refusalLog, JSON.stringify({ at: new Date().toISOString(), host, port: Number(port) || null, service, pid: process.pid }) + "\n",
        { mode: 0o600 });
    } catch { /* The record is evidence only; the refusal itself still happens. */ }
  }
  return Object.assign(new Error(`localdev --no-outbound blocked a connection to ${host}; only loopback is allowed in this session`),
    { code: "ELOCALDEV_OUTBOUND" });
}

// Loopback by address, not spelling: BlockList parses each address, so 0::1 matches ::1, and IPv4-mapped IPv6
// (::ffff:7f00:1, ::ffff:127.0.0.1) is checked against the IPv4 range.
const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function isLoopback(address: string): boolean {
  const family = net.isIP(address);
  return family !== 0 && loopback.check(address, family === 4 ? "ipv4" : "ipv6");
}

type LookupCallback = (error: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;
type Lookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;

/** Resolves as usual, then keeps only loopback answers; none left means the connection is refused. */
function loopbackLookup(lookup: Lookup, port: unknown): Lookup {
  return (hostname, options, callback) => lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    if (Array.isArray(address)) {
      const kept = address.filter((item) => isLoopback(item.address));
      return kept.length ? callback(null, kept) : callback(refused(hostname, port));
    }
    return address !== undefined && isLoopback(address) ? callback(null, address, family) : callback(refused(hostname, port));
  });
}

type ConnectOptions = { path?: string | null; host?: string; port?: number | string; lookup?: Lookup };
const connect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  // Node calls connect with its own normalized [options, callback] array, or users pass (options, cb),
  // (port, host, cb) or (path, cb).
  let options: ConnectOptions;
  if (Array.isArray(args[0])) options = args[0][0] as ConnectOptions;
  else if (typeof args[0] === "object" && args[0] !== null) options = args[0] as ConnectOptions;
  // Node's own rule: a string that is not a number (" 80 " is one) names a pipe.
  else if (typeof args[0] === "string" && !(Number(args[0]) >= 0)) options = { path: args[0] };
  else {
    options = { port: args[0] as number, host: typeof args[1] === "string" ? args[1] : undefined };
    const callback = args.find((item) => typeof item === "function");
    args = callback ? [options, callback] : [options];
  }
  // Node itself treats any truthy path as IPC and anything else (undefined, null, "") as TCP; decide the same way.
  if (!options.path) {
    const host = options.host || "localhost";
    if (net.isIP(host)) {
      if (!isLoopback(host)) {
        process.nextTick(() => this.destroy(refused(host, options.port)));
        return this;
      }
    } else {
      options.lookup = loopbackLookup(options.lookup ?? (dns.lookup as unknown as Lookup), options.port);
    }
  }
  return connect.apply(this, args);
} as typeof net.Socket.prototype.connect;
