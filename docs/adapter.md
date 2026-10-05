# Add `localdev` to a project

The CLI is installed once per machine from a pinned Git commit. Keep the
project's `local.adapter.mjs` and its agent instructions **in the project repo**.
Agents run `localdev` from the checkout they are verifying. The CLI records
that checkout and its Git commit in every session receipt.

## Project setup

1. List **every** port the project starts in the adapter's `ports` array. Use
   names such as `web`, `auth`, `firestore`, `storage`, and `dataconnect`. Add
   ports used by Firebase's hub, UI, Postgres, or websockets too.
2. Set `defaultFixture: "base"` for plain `localdev startup`. The project decides
   what `base` seeds. Named fixtures such as `messages` can add their own data.
3. In `createSession(context)`, build the service commands and seed command.
   Pass `context.ports` to **every** listener and seed. Put emulator data and
   other mutable state under `context.dataDir`. If a framework writes build
   files into the checkout, make its build directory unique per session.
4. If the adapter writes files in the project root, declare those exact paths
   with the pure `cleanupPaths(context)` method **before** `createSession` runs.
   Each path must begin with `.local-cli-<session-id>.`.
5. Write an agent guide in the project repo with prerequisites, `startup`,
   named fixtures, URLs/credentials from the receipt, checks to run, and
   `stop <id>`. Never commit or paste test passwords; keep credentials in a
   `0600` file inside `context.sessionDir`.

The adapter's shape:

```js
import path from "node:path";

export default {
  ports: ["web"],
  defaultFixture: "base",
  cleanupPaths({ id, projectRoot }) {
    return []; // Declare any generated .local-cli-<id>.* project paths here.
  },
  async createSession({ fixture, projectRoot, ports }) {
    if (!["base", "messages"].includes(fixture))
      throw new Error(`Unknown fixture: ${fixture}`);
    return {
      services: [
        {
          name: "web",
          command: path.join(projectRoot, "node_modules", ".bin", "next"),
          args: ["dev", "--turbopack", "--port", String(ports.web)],
          launchMode: "next-turbopack",
          cwd: projectRoot,
          readyPort: "web",
        },
      ],
      urls: { app: `http://127.0.0.1:${ports.web}` },
    };
  },
};
```

Replace the service commands with the project's real commands. For Vite, pass
`--host 127.0.0.1 --port <assigned port> --strictPort`; for a TanStack app,
use that project's dev command and explicitly wire its assigned port. Firebase
needs a generated, session-specific config with *all* emulator ports changed;
see SkateBhoarder's `local.adapter.mjs` for a working example. The shared CLI
does not guess which framework or Firebase services a project uses.

## Faults

`localdev fault` needs nothing from the adapter for `pause` and `kill`. They act
on the session's process listening on a declared port. If verifiers need to
fail one service alone, run it as its own process on its own port. Services
sharing a process (such as a Firebase emulator hub) are paused or killed
together.

**kill and restart.** `kill` restarts the service from the spec `createSession`
returned, using the spec's `env` over the environment of the shell running
`localdev fault`, not the one that ran `startup`. Put everything a restart
needs (PATH additions, JAVA_HOME, emulator flags) in the spec's `env` or `args`.
Only state under `context.dataDir` survives a kill. An emulator that keeps data
in memory comes back empty unless it imports from and exports to `dataDir`.

**fail, slow and hold** need the port behind the session's fault proxy. Opt
ports in with `proxyPorts`, and bind those services on `context.bindPorts`:

```js
export default {
  ports: ["web", "api", "postgres"],
  proxyPorts: { api: "http", postgres: "tcp" },
  createSession({ ports, bindPorts }) {
    return {
      services: [
        // The service listens on its bind port; the proxy holds ports.api.
        { name: "api", command: "node", args: ["server.js", "--port", String(bindPorts.api)], readyPort: "api" },
        // ...
      ],
      // Clients, URLs and other services keep using ports.
      urls: { app: `http://127.0.0.1:${ports.web}`, api: `http://127.0.0.1:${ports.api}` },
    };
  },
};
```

- **One port, two numbers.** `context.ports[name]` is the public port, held by
  the proxy. `context.bindPorts[name]` is the port the service listens on. For
  names not in `proxyPorts`, the two are the same, so existing adapters work
  unchanged. The proxy starts before your services and forwards traffic
  untouched until a fault is set.
- **Bind on 127.0.0.1.** The proxy forwards to `127.0.0.1:<bindPort>`, so the
  service must listen there. Readiness checks use the bind port.
- **Pick the unit.** Use `"http"` for HTTP/1.1 servers, where a fault counts
  requests and websocket upgrades. Use `"tcp"` for anything else (postgres,
  gRPC/h2c such as the Firestore SDK port), where it counts connections.
- **Only opt in ports whose clients you point at `ports`.** Ports a service
  both binds and advertises from one setting can't be split, such as Firebase's
  hub, UI, websocket and Data Connect postgres ports. Leave those out. Clients
  that discover a service through the Firebase hub get its bind port and bypass
  the proxy, so faults reach only clients configured with `ports`. See
  [ADR 0001](adr/0001-fault-proxy-opt-in-ports.md).

## Cross-project isolation

All installations on the same machine use the same state directory and port
allocation lock by default: `~/.local/state/local-cli/`. This lets SH and a
different project start simultaneously without choosing the same allocated
ports. The allocator also checks whether another process already listens on a
candidate port. It leaves existing servers running. A separate
`LOCAL_CLI_STATE_DIR` opts out of the shared lock, so avoid setting it in normal
agent workflows. A service that ignores its assigned port can still collide;
the adapter must wire every port it declares.

`launchMode` is an optional, safe mode ID shown in startup and status. Built-in
IDs `next-turbopack`, `next-webpack`, `vite`, and `tanstack-start` display the
matching dev command; other short lowercase IDs display as written. This field
is a label for agents, not the command the CLI executes. Never put arguments,
environment values, credentials, or tokens in it. If omitted, status shows
`launch: null` rather than guessing from a command that may contain secrets.
