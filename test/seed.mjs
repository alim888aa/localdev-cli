import { writeFile } from "node:fs/promises";
import path from "node:path";

await writeFile(path.join(process.argv[2], "seed.txt"), "ready\n");
