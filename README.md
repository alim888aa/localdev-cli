# localdev

Run an isolated local verification session for a project, built for coding
agents that boot an app, check their work and hand proof to other agents. The shared CLI owns
session IDs, port allocation, process groups, a private data directory, receipts,
`status`, and `stop`. A project adapter defines its services, fixture seed, and URLs.

Install the shared command globally from an **exact commit** of its Git repo.
The repo is public, so no GitHub access is needed (Node 22 or newer):

```sh
pnpm add --global 'git+https://github.com/alim888aa/localdev-cli.git#<commit-sha>'
```

Each project keeps a `local.adapter.mjs` and its own agent setup instructions.
From that project's checkout, run:

```sh
localdev startup                 # the adapter's defaultFixture
localdev startup messages        # a named project fixture
localdev startup messages --parallel  # deliberately run a second copy
localdev startup messages --replace   # stop one matching session and restart
localdev status
localdev stop <session-id>
localdev help                      # all commands and examples
```

Repeated startup from the same checkout and fixture shows the healthy existing
session before using more ports or starting more servers. Terminal users can
choose to replace it or keep both; unattended agents must pass `--replace` or
`--parallel` explicitly. Different checkouts and fixtures can run together.

Ports named `web` or `app` prefer the first available port in 3000–3010 across
all projects and worktrees. The allocator skips live listeners and ports already
reserved by other sessions. If the range is full, it falls back to a free port
in 20000–59999. Emulator and other named ports keep their independent allocation.

See [the adapter guide](docs/adapter.md) when adding another project. For local
CLI development, run `pnpm install`, `pnpm build`, and `pnpm test` here.

## Keep a session offline

`localdev startup --no-outbound` stops the app, its workers and the seed from
reaching outside hosts, so local tests never call paid AI providers or real
services. Loopback traffic, including emulators and the session's other
services, still works. Blocked calls fail fast with `ELOCALDEV_OUTBOUND`, and
`status` shows `outbound: "blocked"`. It covers Node processes. See
[the adapter guide](docs/adapter.md#no-outbound) for its limits.

## Fail a service on purpose

Verifiers and edge case hunters can make one service of a session misbehave,
then restore it, without writing their own harness:

```sh
localdev fault <id> api --mode fail              # reset every request, like an outage
localdev fault <id> api --mode fail --count 1    # only the next request
localdev fault <id> api --mode slow --ms 3000    # delay every request by 3 s
localdev fault <id> api --mode hold              # park requests...
localdev fault <id> api --release --count 1      # ...and let them through one at a time, oldest first
localdev fault <id> dataconnect --mode pause     # freeze the process (SIGSTOP)
localdev fault <id> dataconnect --mode kill      # kill it like a crash; it restarts with its data
localdev fault <id> api --clear                  # end that port's fault (held requests go on)
localdev fault <id> --clear                      # end every fault
```

For example, to check a double submit during a slow save: `--mode slow --ms 3000`
on the backend, click Save twice in the browser, then `--clear`.

The port name comes from the session's `ports`.

- **pause and kill** work on any port. They act on the session's own process
  listening there, after checking it belongs to the session's process groups.
  `pause` freezes it: clients connect but time out, and it keeps its state.
  `kill` sends SIGKILL, starts it again from its recorded command, and returns
  once it is ready. Files under the session's data dir survive; in-memory state
  does not. A process serving several ports is paused or killed with all of
  them (`sharedPorts`).
- **fail, slow and hold** need the port behind the session's fault proxy, which
  the project's adapter opts in with `proxyPorts` (see
  [the adapter guide](docs/adapter.md#faults) and
  [ADR 0001](docs/adr/0001-fault-proxy-opt-in-ports.md)). `status` lists these
  ports under `proxiedPorts`. An HTTP port counts requests and a TCP port
  (postgres, gRPC) counts connections. `--count N` limits a fault to the next N;
  without it, the fault lasts until `--clear`.

`status` lists every active fault under `faults` with its `unit` and `remaining`
count, plus `held` for hold. A paused service still accepts TCP connections, so
its process keeps `reachable: true`; read `faults` to see what is frozen. `stop`
ends every fault: it resumes paused services, drops held requests and stops the
proxy with the session.

## File an issue

From any project checkout, run `localdev issue bug` or
`localdev issue request`. The command formats the report with checkout details
and applies the `source:feedback` label plus `type:bug` or `type:feature` when
published. It previews the
report before asking a person to publish. Unattended agents can supply a JSON
file and explicitly publish:

```sh
localdev issue bug --input report.json --submit
```

Every report names who sent it in a required `reporter` field: where the agent
runs, its agent or session ID, and the project. See
[issue command examples and input fields](docs/issues.md). Publishing with
`--submit` needs an authenticated GitHub CLI (`gh`). Without it, the command
prints a link that opens GitHub's new-issue form with the report filled in.
Issues are public.

Agents can use the shared [localdev issue-maker skill](skills/localdev-issue-maker/SKILL.md)
to check evidence, search for duplicates, and write the issue in this format.
Install it once per Codex user from this repo, then project-specific
agent guides can point to `$localdev-issue-maker`:

```sh
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo alim888aa/localdev-cli --path skills/localdev-issue-maker --method git
```

Keep one problem or request per issue. Remove passwords, tokens, private
credential files, and personal data before submitting. Link project-specific
issues in their own repo when the fault is in that project's adapter or fixture.

The default adapter is `<project>/local.adapter.mjs`. Pass `--adapter FILE` to
use another file. The adapter exports `ports` and `createSession(context)`:

The installed command is `localdev`. The shorter `local` name is a shell
reserved word in zsh, so it cannot be called reliably from agent terminals.

```js
export default {
  ports: ["app"],
  defaultFixture: "base",
  createSession({ fixture, projectRoot, dataDir, ports }) {
    return {
      services: [{
        name: "app",
        command: "node",
        args: ["server.mjs", String(ports.app), dataDir],
        cwd: projectRoot,
        readyPort: "app",
      }],
      urls: { app: `http://127.0.0.1:${ports.app}` },
    };
  },
};
```

Services can also list `readyPorts` when they open several listeners. The CLI
checks that each listener belongs to the service tree. An adapter may declare
`cleanupPaths(context)` for generated session files or directories in the
project root; each path must start with `.local-cli-<session-id>.`. This pure
method runs before `createSession`, and its paths are saved in the receipt before
the adapter writes anything. A killed startup can therefore be cleaned with
`stop <id>`.

The CLI passes every allocated port to the adapter. Adapters must pass those
ports to **every** service and seed command; a service with a hard-coded port can
still collide. A session's `dataDir` belongs to that session only. Its `tempDir`
is a short private directory (`/tmp/lc-<hash>-<session-id>`, mode 0700) for
`TMPDIR`: Unix sockets under `dataDir` can pass macOS's 104-byte path limit.
`status` shows it, and `stop <id>` removes it once its `.localdev-session`
marker proves it is that session's. The adapter
must keep fixtures local and never print passwords into service or seed logs.
If it creates credentials, put them in a `0600` file inside `sessionDir` and
return only its path as `credentialsFile`.

Receipts and logs live in `~/.local/state/local-cli/sessions/<id>/` by default.
Set `LOCAL_CLI_STATE_DIR` to move them. Port allocation is serialized by a lock
that listens on a loopback port derived from the state directory (10000–19999);
the operating system frees it if the holder dies, so it can never go stale. If
another program uses that port, set `LOCAL_CLI_LOCK_PORT`, and set the same
value for every localdev process that shares the state directory. `stop <id>` removes only that session's
processes, directory and temp dir. `startup` and `stop` also remove temp dirs
whose session directory is gone (for example, a session an older localdev
stopped). Each service and seed runs under a persistent process
group supervisor, so `stop` can still kill a server left behind by an exited
launcher. A guard in the same group keeps ownership verifiable if the supervisor
itself crashes. `status` probes each service port and reports `degraded` if one
goes down or another process takes its port. Listener ownership checks the
process group through Linux `/proc` or `lsof`; macOS requires `lsof`. On Linux,
`/proc` must belong to localdev's own PID namespace: a sandbox that shows the
outer namespace's `/proc` is refused at startup, before any session is created. An in-flight
seed is recorded in the receipt before the CLI waits for it. Seeds time out
after five minutes by default; set `seed.timeoutMs` in an
adapter if a fixture needs a different limit. A failed startup stops launched
processes and keeps its receipt/logs until
`stop <id>` so the failure can be inspected.

The generic core has synthetic adapter tests. Real adapters live in their own
projects, next to project-specific agent instructions.

## Security and license

Report security problems privately, as described in [SECURITY.md](SECURITY.md),
never in a public issue. localdev is released under the [MIT License](LICENSE).
