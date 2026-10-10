# localdev context

The shared vocabulary for localdev. Use these words in code, PRs, issues, and
review findings. If a new concept shows up, or a word starts meaning two
things, update this file in the same PR.

## What localdev is for

localdev gives a coding agent an isolated local world to prove its work in: it
boots a project's app and emulators with their own ports, data and logs, loads
a fixture, and hands back a session ID and URLs that other agents can check.
It can also break a service on purpose (faults) and keep a session offline.
The CLI owns the session; each project's adapter says what to run.

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

## Clients

Who asks for things, and how.

- **The human** asks in the localdev `Factory · owner` T3 thread.
- **Agents** file bugs and requests with `localdev issue bug|request --submit`
  (docs/issues.md). Today that applies the plain `bug` / `enhancement` labels,
  not `source:feedback` (#30 fixes that). Until every client runs a CLI
  with #30, triage reads a new issue with only `bug` or `enhancement` as
  `source:feedback`.
- **Factory jobs in other projects** (agent-org skills `worker`, `verifier`,
  `upkeep`, `review-regressions`, `issue-maker`, `setup-factory`) call
  `localdev startup <fixture>`, `status` and `stop` for browser proof.
  `setup-factory` requires `localdev startup base` to work in every project.
- **kpop-city-connect**: `local.adapter.mjs` plus `scripts/localdev/` (adapter
  modules, seeds, fixture accounts). Uses `proxyPorts` (auth, storage and
  dataconnect as http, firestore as tcp) and `bindPorts`. Its AGENTS.md uses
  `localdev startup --parallel --no-outbound`. It runs the Firebase Functions
  emulator only in its `admin` fixture, with its own short `TMPDIR` workaround
  for the macOS socket-path limit. It gets the CLI from the global install.
- **SkatebHoarder** (SkatebHoarder-tmp and skatebhoarder): `local.adapter.mjs`
  plus a `./scripts/localdev` wrapper that runs a vendored copy in
  `tools/localdev/dist/cli.js`, pinned to commit `6a6427e` in
  `tools/localdev/SOURCE.md` (31 commits behind main; it lacks `fault` and
  `--no-outbound`). Fixtures: messages, catalog, moderation, tags, site,
  cleanup, identification. It uses `ports` only, no `proxyPorts`; its
  `cleanupPaths` returns `.local-cli-<id>.*` paths; it sets `TMPDIR` under the
  session `dataDir`. Its docs also pin a global install,
  `pnpm add --global 'git+https://github.com/alim888aa/localdev-cli.git#<sha>'`.
  It files issues with `issue bug --input --session --submit --cli-ref`.
- **video-capture and control-center**: `local.adapter.mjs` with a `base`
  fixture, run through the global install.
- **The global install** on this machine is a pnpm global from a GitHub tarball
  of one commit (main's head when it was set up).

Adapters rely on this contract (docs/adapter.md): a default export with
`ports`, `defaultFixture`, optional `proxyPorts`, optional `cleanupPaths()` and
`createSession(ctx)` returning services, a seed, URLs and a credentials file.
`ctx` carries `id`, `fixture`, `projectRoot`, `sessionDir`, `dataDir`, `ports`
and `bindPorts`. The CLI owns the env vars `LOCAL_CLI_STATE_DIR`,
`LOCAL_CLI_LOCK_PORT` and `LOCALDEV_OUTBOUND_*`.

## How a fix reaches clients

Nothing is automatic. A merge to main reaches:

- **Projects on the global install** only after someone runs
  `pnpm add -g git+https://github.com/alim888aa/localdev-cli.git#<merged sha>`
  on the machine.
- **SkatebHoarder** only after its own PR copies `dist/*.js` into
  `tools/localdev/` and bumps `SOURCE.md` (plus any adapter change).

The package version stays 0.2.1, so the commit is the only real version. After
a client-facing fix merges, the owner asks each client project's factory
(manager thread) to re-pin, and reinstalls the global.

## Must never break

Clients call these, so change them additively. Each says where it's called
from.

- `startup [fixture]` with `--parallel`, `--replace [ID]`, `--no-outbound`,
  `--project` and `--adapter`: factory jobs, `setup-factory` (`startup base`),
  kpop-city-connect (`--parallel --no-outbound`) and SkatebHoarder. Who uses
  `--replace`, `--project` and `--adapter` is unknown (guess: all three are
  in use).
- `status [id]`: factory jobs, and project agent guides (guess).
- `stop <id>`: every job that started a session.
- `help`: agents reading usage (guess).
- `issue bug|request` with `--input`, `--session`, `--submit`, `--cli-ref`
  (and `--project`): agents in any project; SkatebHoarder passes `--cli-ref`.
- `fault ...`: only factory verification so far.
- The adapter contract in docs/adapter.md: old adapters keep working, so
  changes are additive.
- Receipt compatibility across versions: a newer CLI reads older receipts
  (no `services`, no `bindPorts`, the legacy `allocation.lock` directory), and
  mixed versions share one state directory.
- JSON on stdout for `startup`, `status`, `stop` and `fault` (DESIGN.md). `help`
  and `issue` print text.
- Never signal a process whose identity isn't verified.
- Never delete outside the session's own paths (the `cleanupPaths` guard).
- `status` never prints env, specs or credentials.

## Direction

Owned by the owner; changing it is a council call.

- localdev becomes the one way any agent in any project gets an isolated,
  provable local world on this Mac, and later in cloud sandboxes (#7 and #23
  are open).
- Bets now: reliability over features (fail closed, clear errors, sessions
  that never leak); a project-neutral adapter contract; fault injection to
  prove error handling.
- Won't do: project-specific logic (Firebase, seeds) in the CLI, a UI, a
  package registry release, managing remote or cloud infra itself.
