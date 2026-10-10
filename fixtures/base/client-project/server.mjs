// Usage: node server.mjs ROLE PORT DATA_DIR   (ROLE is "api" or "web")
// api: GET /health, GET /items (the rows the seed wrote to DATA_DIR/items.json).
// web: GET / returns a small page that names the api URL (passed in API_URL).
import {readFile} from "node:fs/promises";
import {createServer} from "node:http";
import path from "node:path";

const [role, portArgument, dataDir] = process.argv.slice(2);
const port = Number(portArgument);
if ((role !== "api" && role !== "web") || !Number.isSafeInteger(port) || !dataDir) {
  console.error("Usage: node server.mjs api|web PORT DATA_DIR");
  process.exit(2);
}

createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (role === "web") {
    response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
    response.end(`<h1>scratch client</h1><p>api: ${process.env.API_URL ?? "unset"}</p>`);
  } else if (pathname === "/health") {
    response.writeHead(200, {"content-type": "application/json"});
    response.end(JSON.stringify({ok: true}));
  } else if (pathname === "/items") {
    try {
      const items = await readFile(path.join(dataDir, "items.json"), "utf8");
      response.writeHead(200, {"content-type": "application/json"});
      response.end(items);
    } catch {
      response.writeHead(500, {"content-type": "text/plain"});
      response.end("not seeded");
    }
  } else {
    response.writeHead(404, {"content-type": "text/plain"});
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({status: "serving", role, url: `http://127.0.0.1:${port}/`}));
});
