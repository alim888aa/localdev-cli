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
          args: ["dev", "--port", String(ports.web)],
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

## Cross-project isolation

All installations on the same machine use the same state directory and port
allocation lock by default: `~/.local/state/local-cli/`. This lets SH and a
different project start simultaneously without choosing the same allocated
ports. The allocator also checks whether another process already listens on a
candidate port. It leaves existing servers running. A separate
`LOCAL_CLI_STATE_DIR` opts out of the shared lock, so avoid setting it in normal
agent workflows. A service that ignores its assigned port can still collide;
the adapter must wire every port it declares.
