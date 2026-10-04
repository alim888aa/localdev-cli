import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// launcher (stays in the session group) -> anchor (its own group) -> server (anchor's group).
// The anchor exits after the server is ready, so the escaped group outlives the process that created it.
const here = path.dirname(fileURLToPath(import.meta.url));
const [role, ...rest] = process.argv.slice(2);
if (role === "anchor") {
  spawn(process.execPath, [path.join(here, "server.mjs"), ...rest], { stdio: "inherit" });
  setTimeout(() => process.exit(0), 1500);
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "anchor", role, ...rest], { detached: true, stdio: "inherit" });
  setInterval(() => {}, 60_000);
}
