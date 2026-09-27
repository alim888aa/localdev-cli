import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let commit;
try {
  const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (path.resolve(topLevel) !== path.resolve(root)) process.exit(0);
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // A packed copy keeps the stamp generated from the Git checkout.
  process.exit(0);
}

if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Could not stamp the localdev source commit");
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist", "build-info.json"), `${JSON.stringify({ commit })}\n`, { mode: 0o644 });
