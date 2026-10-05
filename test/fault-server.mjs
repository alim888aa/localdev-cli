import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

// A service for fault tests. Its state lives in its data dir: PUT/GET /data, and listen-delay-ms, which delays
// listening on the next start so a test can stop a session while a killed service restarts.
const port = Number(process.argv[2]);
const dataDir = process.argv[3];
mkdirSync(dataDir, { recursive: true });

// 192.0.2.1 is TEST-NET-1: never a real host. Blocked by --no-outbound, otherwise it times out or is unreachable.
const outside = { host: "192.0.2.1", port: 80 };
const netProbeSource = `const s=require("node:net").connect(${JSON.stringify(outside)});s.setTimeout(300,()=>{s.destroy();console.log("timeout")});s.once("connect",()=>{s.destroy();console.log("connected")});s.once("error",(e)=>console.log(e.code??e.message))`;

function netProbe() {
  return new Promise((resolve) => {
    const socket = net.connect(outside);
    socket.setTimeout(300, () => { socket.destroy(); resolve("timeout"); });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("error", (error) => resolve(error.code ?? error.message));
  });
}

async function fetchProbe() {
  try { await fetch(`http://${outside.host}/`, { signal: AbortSignal.timeout(300) }); return "connected"; }
  catch (error) { return error.cause?.code ?? error.name; }
}

const server = http.createServer(async (request, response) => {
  const send = (body) => { response.writeHead(200, { "content-type": "text/plain" }); response.end(body); };
  const { pathname } = new URL(request.url, "http://localhost");
  if (pathname.startsWith("/echo/")) return send(pathname.slice("/echo/".length));
  if (pathname === "/data") {
    const file = path.join(dataDir, "data.txt");
    if (request.method !== "PUT") return send(await readFile(file, "utf8").catch(() => ""));
    let body = "";
    for await (const chunk of request) body += chunk;
    await writeFile(file, body);
    return send("stored");
  }
  if (pathname === "/probe") {
    const loopback = process.env.LOCALDEV_LOOPBACK_URL;
    return send(JSON.stringify({ net: await netProbe(), fetch: await fetchProbe(),
      loopback: loopback ? await (await fetch(loopback)).text() : null,
      httpProxy: process.env.HTTP_PROXY ?? null, nodeOptions: process.env.NODE_OPTIONS ?? "" }));
  }
  if (pathname === "/probe-child") {
    const child = spawn(process.execPath, ["-e", netProbeSource], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("close", () => send(output.trim()));
    return;
  }
  send(dataDir);
});

let delay = 0;
try { delay = Number(readFileSync(path.join(dataDir, "listen-delay-ms"), "utf8")); } catch { /* listen at once */ }
setTimeout(() => server.listen(port, "127.0.0.1"), delay);
