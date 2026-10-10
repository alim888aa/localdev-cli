// Serves the base fixture's README on 127.0.0.1 so the outer session has one small service.
// Usage: node serve-readme.mjs PORT FILE
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";

const port = Number(process.argv[2]);
const file = process.argv[3];
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !file) {
  console.error("Usage: node serve-readme.mjs PORT FILE");
  process.exit(2);
}

createServer(async (_request, response) => {
  response.writeHead(200, {"content-type": "text/plain; charset=utf-8", "cache-control": "no-store"});
  response.end(await readFile(file));
}).listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({status: "serving", url: `http://127.0.0.1:${port}/`}));
});
