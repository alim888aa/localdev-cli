# localdev context

The shared vocabulary for localdev. Use these words in code, PRs, issues, and
review findings. If a new concept shows up, or a word starts meaning two
things, update this file in the same PR.

## Sessions

- **Session**: one isolated run of a project checkout plus a fixture, named by
  a UUID, with its own ports, data directory, logs and processes. Stored states
  are `starting`, `ready`, `failed` and `stopping`. Status also derives
  `degraded` (ready, but a listener is unreachable or not owned) and `gone`
  (no receipt: stopped or unknown).
- **Receipt**: the session's `receipt.json` (0600) under the state directory.
  It is the source of truth for a session. Only `state` writes it, and every
  read-modify-write goes through `updateReceipt` (or `withReceipt` when the
  write must land before a side effect).
- **State lock**: the loopback-port mutex that serialises receipt changes and
  port reservation (`withStateLock`; the legacy directory is
  `allocation.lock`). Not reentrant. _Avoid_: "allocation lock" in new code.
- **Checkout**: the project directory a session runs from, always compared by
  its canonical path (`projectRoot`), plus its Git commit.

## Projects

- **Adapter**: the project's `local.adapter.mjs`. It declares port names and
  `proxyPorts`, and `createSession` turns a fixture into a plan. `adapter`
  loads and checks it; docs/adapter.md is its contract.
- **Fixture**: named test data a session starts with. `defaultFixture` is used
  when none is named.
- **Plan**: what `createSession` returns: services, an optional seed, URLs and
  a credentials file.
- **Service**: a long-running command from the plan. The fault proxy is not a
  service, though it runs the same way.
- **Seed**: a one-shot command that loads the fixture and must exit 0.

## Ports

- **Port name**: the adapter's name for a port (`web`, `dataconnect`). The
  CLI's `PORT` argument and a fault's `port` are names. A port number is
  always called a port number or `listen`/`target`.
- **Public port / bind port**: clients and URLs use the public port
  (`ports`). Services listen on the bind port (`bindPortsOf`), which differs
  only for proxied names.
- **Owned listener**: a process listening on a port that descends from one of
  the session's owned process groups. `listener` is its one owner, so another
  app on the port never counts as the session's.

## Processes

- **Runtime identity check**: before loading an adapter or reserving a session,
  startup rejects a readable Linux procfs whose self PID disagrees with Node.
  This reports an unsupported runtime; it does not translate PIDs or bypass ownership.

- **Owned process**: one supervised process group (services, the proxy, the
  seed): the supervisor's PID is the group ID, a guard keeps the group
  identifiable, and escaped groups are descendants that left it.
  `supervised` owns spawning, waiting and stopping them.
- **Birth**: a process's start time (`proc:<boot>:<tick>` on Linux, a `ps`
  start time elsewhere), recorded with its PID to tell it from a later process
  reusing the PID. Compare births only through `compareBirth` /
  `isSameProcess` in `process-table`.
- **Session health**: whether every owned process is alive, reachable and
  listener-owned (`sessionHealth`). Duplicate matching and status both use it.

## Faults

- **Fault**: a deliberate failure on one port of a session. `pause` and `kill`
  act on processes and are recorded in the receipt. `fail`, `slow` and `hold`
  act on traffic and live only in the fault proxy.
- **Fault proxy**: the session-owned process (`role: "proxy"`) that holds the
  public ports of proxied names and forwards to their bind ports (ADR 0001).
- **Unit**: what a fault counts. An adapter declares a proxied port as `http`
  or `tcp` (`ProxyUnit`), so its faults count a `request` or a `connection`
  (`CountUnit`). Pause and kill show `process`.
- **Outbound policy**: `startup --no-outbound` stores the policy `deny`, and
  status shows it as `outbound: "blocked"` (otherwise `"allowed"`). It is a
  Node preload plus cleared proxy variables, not a sandbox (docs/adapter.md).

## Ambiguities to watch

- "Service" in fault messages never includes the proxy or the seed.
- "Port" alone is ambiguous: say port name or port number.
- `OwnedProcess.readyPort` is a number, while `ServiceSpec.readyPort` is a
  name (kept for receipt compatibility).
