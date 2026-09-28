# Local CLI

Run an isolated local verification session for a project. The shared CLI owns
session IDs, port allocation, process groups, a private data directory, receipts,
`status`, and `stop`. A project adapter defines its services, fixture seed, and URLs.

Install the shared command globally from an **exact commit** of its Git repo:

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

See [the adapter guide](docs/adapter.md) when adding another project. For local
CLI development, run `pnpm install`, `pnpm build`, and `pnpm test` here.

## File an issue

From any project checkout, run `localdev issue bug` or
`localdev issue request`. The command formats the report with checkout details
and applies the `bug` or `enhancement` label when published. It previews the
report before asking a person to publish. Unattended agents can supply a JSON
file and explicitly publish:

```sh
localdev issue bug --input report.json --submit
```

See [issue command examples and input fields](docs/issues.md). GitHub CLI
(`gh`) access to this private repo is required to publish.

Agents can use the shared [localdev issue-maker skill](skills/localdev-issue-maker/SKILL.md)
to check evidence, search for duplicates, and write the issue in this format.
Install it once per Codex user from this private repo, then project-specific
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
still collide. A session's `dataDir` belongs to that session only. The adapter
must keep fixtures local and never print passwords into service or seed logs.
If it creates credentials, put them in a `0600` file inside `sessionDir` and
return only its path as `credentialsFile`.

Receipts and logs live in `~/.local/state/local-cli/sessions/<id>/` by default.
Set `LOCAL_CLI_STATE_DIR` to move them. `stop <id>` removes only that session's
processes and directory. Each service and seed runs under a persistent process
group supervisor, so `stop` can still kill a server left behind by an exited
launcher. A guard in the same group keeps ownership verifiable if the supervisor
itself crashes. `status` probes each service port and reports `degraded` if one
goes down or another process takes its port. Listener ownership uses `lsof` and
the process group, so `lsof` must be available on the host. An in-flight seed is
recorded in the receipt before the CLI waits for
it. Seeds time out after five minutes by default; set `seed.timeoutMs` in an
adapter if a fixture needs a different limit. A failed startup stops launched
processes and keeps its receipt/logs until
`stop <id>` so the failure can be inspected.

The generic core has synthetic adapter tests. The SkateBhoarder adapter is in
that project's `local.adapter.mjs`, with project-specific agent instructions in
`docs/agents/local-suite.md`.
