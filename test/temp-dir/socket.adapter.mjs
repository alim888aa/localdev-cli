import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A project adapter that points TMPDIR at a private dir, as Firebase adapters do for the Functions emulator.
export default {
  ports: ["testApp"],
  defaultFixture: "base",
  createSession({ dataDir, tempDir, ports }) {
    const tmp = tempDir ?? path.join(dataDir, "tmp");
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    return {
      services: [{
        name: "app",
        command: process.execPath,
        args: [fileURLToPath(new URL("socket-server.mjs", import.meta.url)), String(ports.testApp)],
        env: { TMPDIR: tmp },
        readyPort: "testApp",
        readyTimeoutMs: 5000,
      }],
      urls: { app: `http://127.0.0.1:${ports.testApp}` },
    };
  },
};
