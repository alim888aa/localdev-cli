import { mkdirSync } from "node:fs";
import path from "node:path";

// A project adapter that points TMPDIR at a private dir, as Firebase adapters do for the Functions emulator.
export default {
  ports: ["app"],
  defaultFixture: "base",
  createSession({ projectRoot, dataDir, tempDir, ports }) {
    const tmp = tempDir ?? path.join(dataDir, "tmp");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    return {
      services: [{
        name: "app",
        command: process.execPath,
        args: [path.join(projectRoot, "test", "socket-server.mjs"), String(ports.app)],
        env: { TMPDIR: tmp },
        readyPort: "app",
        readyTimeoutMs: 5000,
      }],
      urls: { app: `http://127.0.0.1:${ports.app}` },
    };
  },
};
