import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export default {
  ports: ["app", "secondary"],
  defaultFixture: "base",
  cleanupPaths({ id, fixture, projectRoot }) {
    return fixture === "cleanup" || fixture === "slowsetup"
      ? [path.join(projectRoot, `.local-cli-${id}.build`)]
      : [];
  },
  async createSession({ id, fixture, projectRoot, dataDir, ports }) {
    const generated = fixture === "cleanup" || fixture === "slowsetup"
      ? path.join(projectRoot, `.local-cli-${id}.build`)
      : null;
    if (generated) {
      mkdirSync(generated);
      writeFileSync(path.join(generated, "generated.txt"), "generated\n");
    }
    if (fixture === "slowsetup")
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    const services = [{
      name: "app",
      command: process.execPath,
      args: [path.join(projectRoot, "test", fixture === "launcher" ? "launcher.mjs" : "server.mjs"), String(ports.app), dataDir],
      readyPort: "app",
      readyTimeoutMs: 5000,
    }];
    if (fixture === "broken") services.push({
      name: "broken",
      command: process.execPath,
      args: [path.join(projectRoot, "test", "missing.mjs")],
      readyPort: "secondary",
      readyTimeoutMs: 2000,
    });
    return {
      services,
      seed: {
        command: process.execPath,
        args: [path.join(projectRoot, "test", fixture === "slowseed" || fixture === "timedseed" ? "slow-seed.mjs" : "seed.mjs"), dataDir],
        ...(fixture === "timedseed" ? { timeoutMs: 500 } : {}),
      },
      urls: { app: `http://127.0.0.1:${ports.app}` },
    };
  },
};
