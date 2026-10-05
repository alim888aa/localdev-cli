import net from "node:net";
import { fileURLToPath } from "node:url";
export function countUnit(unit) {
    return unit === "http" ? "request" : "connection";
}
const PROXY_NAME = "localdev-proxy";
const proxyProcessPath = fileURLToPath(new URL("./proxy-process.js", import.meta.url));
/** Refuses an adapter service named like the fault proxy, which status and stop must tell apart. */
export function checkServiceName(name) {
    if (name === PROXY_NAME)
        throw new Error(`Service name ${PROXY_NAME} is reserved for the fault proxy`);
}
/**
 * How startup launches the session's fault proxy (through launchService, like any service), or null when the
 * adapter proxies no port. The proxy listens on, and is ready on, the public ports.
 */
export function proxyLaunch(receipt) {
    const names = Object.keys(receipt.proxyPorts ?? {});
    if (!names.length)
        return null;
    const routes = names.map((port) => ({
        port, unit: receipt.proxyPorts[port], listen: receipt.ports[port], target: receipt.bindPorts[port],
    }));
    const spec = {
        name: PROXY_NAME,
        command: process.execPath,
        args: [proxyProcessPath, JSON.stringify(routes)],
        cwd: receipt.sessionDir,
        readyPorts: names,
    };
    return { spec, ports: receipt.ports, role: "proxy" };
}
/**
 * macOS limits a unix socket path to 104 bytes, and a session dir under a long state dir is already close to that.
 * So the proxy listens on the relative "proxy.sock" in its session dir, and this connects to it from inside that
 * directory. That is safe because libuv passes the path to connect() synchronously, before chdir is undone, and
 * the CLI runs nothing else concurrently that depends on the working directory. No other module changes directory.
 */
function connectInSessionDir(sessionDir) {
    const previous = process.cwd();
    process.chdir(sessionDir);
    try {
        return net.connect({ path: "proxy.sock" });
    }
    finally {
        process.chdir(previous);
    }
}
/** Sends one control request to the session's proxy. Rejects when the proxy cannot be reached in time. */
export function controlProxy(receipt, request, timeoutMs = 2_000) {
    return new Promise((resolve, reject) => {
        const socket = connectInSessionDir(receipt.sessionDir);
        let answer = "";
        const fail = (error) => { socket.destroy(); reject(new Error(`The fault proxy of session ${receipt.id} did not answer: ${error.message}`)); };
        socket.setTimeout(timeoutMs, () => fail(new Error("timed out")));
        socket.setEncoding("utf8");
        socket.once("error", fail);
        socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
        socket.on("data", (chunk) => { answer += chunk; });
        socket.once("end", () => {
            try {
                resolve(JSON.parse(answer));
            }
            catch {
                fail(new Error("unreadable reply"));
            }
        });
    });
}
