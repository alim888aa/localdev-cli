// localdev adapter for a scratch client project, written by localdev's own base fixture.
// It is small on purpose: it shows the shape real clients use.
//
// Fixtures:
//   base        an "api" service (HTTP, behind the fault proxy so fail/slow/hold work) and a "web"
//               service, a seed that must exit 0, a credentials file and URLs.
//   seed-fails  the same, but the seed exits 1, so startup fails and keeps its receipt.
import {randomBytes} from "node:crypto";
import {writeFile} from "node:fs/promises";
import path from "node:path";

const fixtures = ["base", "seed-fails"];

export default {
  ports: ["web", "api"],
  proxyPorts: {api: "http"},
  defaultFixture: "base",

  cleanupPaths() {
    return [];
  },

  async createSession({fixture, projectRoot, sessionDir, dataDir, ports, bindPorts}) {
    if (!fixtures.includes(fixture)) {
      throw new Error(`Unknown fixture: ${fixture}. Known fixtures: ${fixtures.join(", ")}`);
    }
    const server = path.join(projectRoot, "server.mjs");
    const credentialsFile = path.join(sessionDir, "credentials.json");
    await writeFile(
      credentialsFile,
      JSON.stringify({user: "demo@example.test", password: randomBytes(12).toString("hex")}),
      {mode: 0o600},
    );
    return {
      services: [
        {
          name: "api",
          command: process.execPath,
          args: [server, "api", String(bindPorts.api), dataDir],
          cwd: dataDir,
          readyPort: "api",
          readyTimeoutMs: 15_000,
        },
        {
          name: "web",
          command: process.execPath,
          args: [server, "web", String(ports.web), dataDir],
          cwd: dataDir,
          env: {API_URL: `http://127.0.0.1:${ports.api}`},
          readyPort: "web",
          readyTimeoutMs: 15_000,
        },
      ],
      seed: {
        command: process.execPath,
        args: [path.join(projectRoot, "seed.mjs"), dataDir, ...(fixture === "seed-fails" ? ["--fail"] : [])],
        cwd: dataDir,
      },
      urls: {app: `http://127.0.0.1:${ports.web}/`, api: `http://127.0.0.1:${ports.api}/items`},
      credentialsFile,
    };
  },
};
