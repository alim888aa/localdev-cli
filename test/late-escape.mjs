import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A server in the session group that, after readiness, starts a non-listening helper in its own group.
const here = path.dirname(fileURLToPath(import.meta.url));
const [port, dataDir] = process.argv.slice(2);
spawn(process.execPath, [path.join(here, "server.mjs"), port, dataDir], { stdio: "inherit" });
setTimeout(() => {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  writeFileSync(path.join(dataDir, "helper.pid"), String(helper.pid));
}, 1000);
setInterval(() => {}, 60_000);
