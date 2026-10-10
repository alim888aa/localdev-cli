import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Opens a Unix socket in os.tmpdir() the way Firebase's Functions emulator does, and serves its path once bound.
const port = Number(process.argv[2]);
const socketPath = path.join(os.tmpdir(), `fire_emu_${randomBytes(8).toString("hex")}.sock`);
net.createServer().once("error", (error) => {
  console.error(error.message);
  process.exit(1);
}).listen(socketPath, () => {
  http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ tmpdir: os.tmpdir(), socketPath }));
  }).listen(port, "127.0.0.1");
});
