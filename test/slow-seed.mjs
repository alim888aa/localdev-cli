import { writeFile } from "node:fs/promises";
import path from "node:path";

await writeFile(path.join(process.argv[2], "seed.pid"), String(process.pid));
setInterval(() => undefined, 60_000);
