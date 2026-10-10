import fs from "node:fs/promises";
import path from "node:path";

// Delay only the real proxy, before it binds, so the test can take a selected public port.
if (process.argv[1]?.endsWith("/proxy-process.js") && process.env.PROXY_GATE_DIR) {
  const dir = process.env.PROXY_GATE_DIR;
  const id = path.basename(process.cwd());
  const selected = path.join(dir, id + ".json");
  await fs.writeFile(selected + ".pending", JSON.stringify({ id, sessionDir: process.cwd(), routes: JSON.parse(process.argv[2]) }));
  await fs.rename(selected + ".pending", selected);
  while (!await fs.access(path.join(dir, "release-" + id)).then(() => true, () => false)) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
