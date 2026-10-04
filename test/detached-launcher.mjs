import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Like Firebase's emulator runner: the server gets its own process group while the launcher stays alive.
spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs"), ...process.argv.slice(2)], {
  detached: true,
  stdio: "inherit",
});
setInterval(() => {}, 60_000);
