import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.once("spawn", () => process.exit(0));
