import path from "node:path";

// The fault proxy fixture: api and rawsvc sit behind the proxy (HTTP and TCP units); app is not proxied.
// fixture.adapter.mjs declares no proxyPorts, so every test using it shows such sessions get no proxy.
export default {
  ports: ["app", "proxied", "raw"],
  proxyPorts: { proxied: "http", raw: "tcp" },
  defaultFixture: "faults",
  createSession({ fixture, projectRoot, dataDir, ports, bindPorts }) {
    // "download": the app fetches something from outside before it listens, like an emulator's first-run download.
    if (fixture !== "faults" && fixture !== "download") throw new Error(`Unknown fixture: ${fixture}`);
    const server = path.join(projectRoot, "test", "fault-server.mjs");
    const service = (name, port, readyPort) => ({
      name, command: process.execPath, args: [server, String(port), path.join(dataDir, name)],
      // HTTP_PROXY and NODE_OPTIONS show how --no-outbound composes with an adapter's own env.
      env: { LOCALDEV_TEST_SECRET: "private-test-value", LOCALDEV_LOOPBACK_URL: `http://127.0.0.1:${ports.proxied}/echo/loopback`,
        HTTP_PROXY: "http://127.0.0.1:9", NODE_OPTIONS: "--max-old-space-size=256" },
      readyPort, readyTimeoutMs: 10_000,
    });
    if (fixture === "download") {
      const app = service("app", ports.app, "app");
      return { services: [{ ...app, env: { ...app.env, LOCALDEV_DOWNLOAD_AT_START: "1" } }], urls: { app: `http://127.0.0.1:${ports.app}` } };
    }
    return {
      services: [service("api", bindPorts.proxied, "proxied"), service("rawsvc", bindPorts.raw, "raw"), service("app", ports.app, "app")],
      urls: { app: `http://127.0.0.1:${ports.app}`, api: `http://127.0.0.1:${ports.proxied}` },
    };
  },
};
