# ADR 0001: The fault proxy covers only ports the adapter opts in

Status: accepted (2026-10-05, localdev #17)

## Context

`localdev fault` gained `fail`, `slow` and `hold`, plus `--count` and
`--release` (issue #17). Unlike `pause` and `kill`, which signal a process,
these need something in the request path. Today an adapter gives each port
number to both the service, which binds it, and its clients, which connect to
it. A proxy needs those to differ.

Options:

- **(a) Proxy every port from startup.** Every service binds a hidden internal
  port and clients use the public one. That changes the adapter contract for
  every port.
- **(b) Proxy only ports the adapter opts in.**
- **(c) Insert the proxy lazily when a fault is set.** By then the service
  already holds the public port. Taking it over needs SO_REUSEPORT (which
  balances load rather than intercepting, needs the service's cooperation, and
  behaves differently on macOS), pf/iptables redirects (root), or restarting
  clients.

## Decision

**(b).** An adapter declares `proxyPorts: { <name>: "http" | "tcp" }`. For those
names `context.bindPorts[name]` is a separate port the service binds on
127.0.0.1, and `context.ports[name]` is held by the session's fault proxy.

- The proxy is a session process started through the same launcher as
  services, before them. stop, ownership checks and escaped-group cleanup cover
  it like any service. It holds the public ports through the whole boot.
- **What a fault counts:** on `"http"` ports one HTTP/1.1 request (a websocket
  upgrade is one request), and on `"tcp"` ports one accepted connection.
  `pause` and `kill` act on processes and work on every port. Status shows each
  fault's `unit`.
- **Where state lives:** the proxy is the only owner of fail/slow/hold state,
  meaning live counts and held requests. The CLI controls it over `proxy.sock` in
  the session dir. The receipt records only faults that change processes (pause,
  and kill while it restarts). Stopping the proxy undoes everything it held.

(a) was rejected:
- Many services bind and advertise from one setting (Firebase hub and UI, Data
  Connect's postgres port, websocket ports), so they can't be split.
- Every existing adapter would break.
- Every session would pay a proxy hop on all traffic, including HMR websockets
  and gRPC, even when no fault is ever set.

(c) is impossible without root or service cooperation.

## Consequences

- Adapters without `proxyPorts` are unchanged: no proxy process, and
  `bindPorts` equals `ports`.
- A project opts ports in through its own adapter, so SkateBhoarder needs an
  adapter change before hunters can fail, slow or hold its services.
- Clients that discover a service through the Firebase hub get its bind port
  and bypass the proxy. Faults reach clients configured with `ports`.
- The HTTP unit speaks HTTP/1.1 only. h2c and gRPC ports use `"tcp"`.
- If the proxy dies, its faults and held requests die with it. Status shows
  the proxy process as dead (the session is degraded) and `proxy: "unreachable"`.

See [the adapter guide](../adapter.md#faults) for the adapter-facing contract.
