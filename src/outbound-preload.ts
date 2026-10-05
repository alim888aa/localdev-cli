// Loaded into every Node process of a `localdev startup --no-outbound` session (NODE_OPTIONS=--import). It refuses
// TCP connections to anything but loopback and unix sockets, which covers http, https, tls and fetch. A hostname is
// resolved first, so names that point at loopback (localhost, /etc/hosts aliases) still work. Not a sandbox: other
// runtimes, UDP and DNS lookups themselves are not covered.
import dns from "node:dns";
import net from "node:net";

function refused(host: string): Error {
  return Object.assign(new Error(`localdev --no-outbound blocked a connection to ${host}; only loopback is allowed in this session`),
    { code: "ELOCALDEV_OUTBOUND" });
}

function isLoopback(address: string): boolean {
  if (net.isIPv4(address)) return address.startsWith("127.");
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1" || lower.startsWith("::ffff:127.");
}

type LookupCallback = (error: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;
type Lookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;

/** Resolves as usual, then keeps only loopback answers; none left means the connection is refused. */
function loopbackLookup(lookup: Lookup): Lookup {
  return (hostname, options, callback) => lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    if (Array.isArray(address)) {
      const kept = address.filter((item) => isLoopback(item.address));
      return kept.length ? callback(null, kept) : callback(refused(hostname));
    }
    return address !== undefined && isLoopback(address) ? callback(null, address, family) : callback(refused(hostname));
  });
}

type ConnectOptions = { path?: string; host?: string; port?: number | string; lookup?: Lookup };
const connect = net.Socket.prototype.connect as (this: net.Socket, ...args: unknown[]) => net.Socket;

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  // Node calls connect with its own normalized [options, callback] array, or users pass (options, cb),
  // (port, host, cb) or (path, cb).
  let options: ConnectOptions;
  if (Array.isArray(args[0])) options = args[0][0] as ConnectOptions;
  else if (typeof args[0] === "object" && args[0] !== null) options = args[0] as ConnectOptions;
  else if (typeof args[0] === "string" && !/^\d+$/.test(args[0])) options = { path: args[0] };
  else {
    options = { port: args[0] as number, host: typeof args[1] === "string" ? args[1] : undefined };
    const callback = args.find((item) => typeof item === "function");
    args = callback ? [options, callback] : [options];
  }
  if (options.path === undefined) {
    const host = options.host || "localhost";
    if (net.isIP(host)) {
      if (!isLoopback(host)) {
        process.nextTick(() => this.destroy(refused(host)));
        return this;
      }
    } else {
      options.lookup = loopbackLookup(options.lookup ?? (dns.lookup as unknown as Lookup));
    }
  }
  return connect.apply(this, args);
} as typeof net.Socket.prototype.connect;
