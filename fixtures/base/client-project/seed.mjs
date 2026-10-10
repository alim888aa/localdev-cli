// Usage: node seed.mjs DATA_DIR [--fail]
// Writes the rows the api serves. With --fail it exits 1, to exercise a failed seed.
import {writeFile} from "node:fs/promises";
import path from "node:path";

const [dataDir, flag] = process.argv.slice(2);
if (flag === "--fail") {
  console.error("seed failed on purpose");
  process.exit(1);
}
await writeFile(path.join(dataDir, "items.json"), JSON.stringify([{id: 1, name: "first"}, {id: 2, name: "second"}]));
