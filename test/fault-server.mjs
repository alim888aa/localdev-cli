import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// A service for fault tests. Its state lives in its data dir: PUT/GET /data; listen-delay-ms, which delays
// listening on the next start so a test can stop a session while a killed service restarts; and fail-on-start,
// which makes the next start exit at once.
const port = Number(process.argv[2]);
const dataDir = process.argv[3];
mkdirSync(dataDir, { recursive: true });
try { readFileSync(path.join(dataDir, "fail-on-start")); process.exit(1); } catch { /* start normally */ }
let openHangs = 0;

// 192.0.2.1 is TEST-NET-1: never a real host. Blocked by --no-outbound, otherwise it times out or is unreachable.
const outside = { host: "192.0.2.1", port: 80 };
const netProbeSource = `const s=require("node:net").connect(${JSON.stringify(outside)});s.setTimeout(300,()=>{s.destroy();console.log("timeout")});s.once("connect",()=>{s.destroy();console.log("connected")});s.once("error",(e)=>console.log(e.code??e.message))`;

function netProbe(options = outside) {
  return new Promise((resolve) => {
    const socket = net.connect(options);
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
  if (pathname === "/probe-variants") {
    // Another interface of this machine (or TEST-NET when there is none): outside loopback, so it must be refused.
    const external = Object.values(os.networkInterfaces()).flat()
      .find((item) => item && !item.internal && item.family === "IPv4")?.address ?? outside.host;
    return send(JSON.stringify({
      emptyPath: await netProbe({ host: external, port, path: "" }),
      nullPath: await netProbe({ host: external, port, path: null }),
      spelledV6Loopback: await netProbe({ host: "0::1", port }),
      mappedLoopback: await netProbe({ host: "::ffff:7f00:1", port }),
    }));
  }
  if (pathname === "/truncated") {
    // Promises 100 bytes, sends 10, then drops the connection.
    response.writeHead(200, { "content-length": "100" });
    response.write("0123456789");
    return setImmediate(() => request.socket.destroy());
  }
  if (pathname === "/hang") {
    openHangs++;
    response.once("close", () => { openHangs--; });
    return;
  }
  if (pathname === "/hangs") return send(String(openHangs));
  if (pathname === "/probe-child") {
    const child = spawn(process.execPath, ["-e", netProbeSource], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("close", () => send(output.trim()));
    return;
  }
  send(dataDir);
});

// Like a tool's first-run download: a failed fetch is reported in the tool's own words, and the start fails.
if (process.env.LOCALDEV_DOWNLOAD_AT_START && await netProbe() !== "connected") {
  console.error("Failed to make request to the download server");
  process.exit(1);
}

let delay = 0;
try { delay = Number(readFileSync(path.join(dataDir, "listen-delay-ms"), "utf8")); } catch { /* listen at once */ }
setTimeout(() => server.listen(port, "127.0.0.1"), delay);
