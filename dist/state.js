import { createHash, randomInt, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
export const stateRoot = path.resolve(process.env.LOCAL_CLI_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "local-cli"));
const sessionsRoot = path.join(stateRoot, "sessions");
const lockPath = path.join(stateRoot, "allocation.lock");
export function sessionPath(id) {
    if (!/^[0-9a-f-]{36}$/.test(id))
        throw new Error("Invalid session ID");
    return path.join(sessionsRoot, id);
}
export async function readReceipt(id) {
    const raw = await fs.readFile(path.join(sessionPath(id), "receipt.json"), "utf8");
    return JSON.parse(raw);
}
export async function listReceipts() {
    await fs.mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    const ids = await fs.readdir(sessionsRoot);
    const results = await Promise.all(ids.map(async (id) => {
        try {
            return await readReceipt(id);
        }
        catch {
            return null;
        }
    }));
    return results.filter((item) => item !== null);
}
export async function writeReceipt(receipt) {
    const target = path.join(sessionPath(receipt.id), "receipt.json");
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(temp, target);
}
async function canBind(port) {
    return new Promise((resolve) => {
        // Nothing talks to the lock port; drop any stray connection so close() never waits on one.
        const server = net.createServer((socket) => socket.destroy());
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}
// The allocation lock is a loopback TCP listener. The kernel lets one process listen on the port and frees it
// when that process exits, so a lock can never go stale and nothing ever has to reclaim one. The port is
// derived from the state directory (outside the 20000-59999 service range). LOCAL_CLI_LOCK_PORT overrides it;
// every process sharing a state directory must then use the same value, or they stop excluding each other.
export const lockPort = Number(process.env.LOCAL_CLI_LOCK_PORT) ||
    10_000 + (createHash("sha256").update(stateRoot).digest().readUInt32BE(0) % 10_000);
function listenOnce(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", (error) => error.code === "EADDRINUSE" ? resolve(null) : reject(error));
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.unref(); resolve(server); });
    });
}
/**
 * Older localdev versions lock by creating `allocation.lock/owner.json`. While holding the port lock (so no
 * other current localdev competes here) wait out a live legacy holder, clear an abandoned one, and take the
 * directory ourselves so legacy versions wait for us. A legacy writer paused more than 30 s between creating
 * the directory and writing its owner file is indistinguishable from a dead one: a known mixed-version limit.
 */
async function takeLegacyLock(token, deadline) {
    const ownerFile = path.join(lockPath, "owner.json");
    while (Date.now() < deadline) {
        try {
            await fs.mkdir(lockPath, { mode: 0o700 });
            await fs.writeFile(ownerFile, JSON.stringify({ pid: process.pid, time: Date.now(), token }));
            return;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
        const owner = await fs.readFile(ownerFile, "utf8").then((text) => JSON.parse(text), () => null);
        const modified = await fs.stat(lockPath).then((stat) => stat.mtimeMs, () => Date.now());
        const abandoned = owner ? Date.now() - owner.time > 30_000 && !pidExists(owner.pid) : Date.now() - modified > 30_000;
        if (abandoned)
            await fs.rm(lockPath, { recursive: true, force: true });
        else
            await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for an older localdev's allocation lock");
}
async function acquireLock() {
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 60_000;
    let server = null;
    while (!server) {
        server = await listenOnce(lockPort);
        if (server)
            break;
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for the local session allocation lock (127.0.0.1:${lockPort}); if another program uses that port, set LOCAL_CLI_LOCK_PORT`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const held = server;
    const token = randomUUID();
    try {
        await takeLegacyLock(token, deadline);
    }
    catch (error) {
        await new Promise((resolve) => held.close(() => resolve(undefined)));
        throw error;
    }
    return async () => {
        try {
            const owner = await fs.readFile(path.join(lockPath, "owner.json"), "utf8").then((text) => JSON.parse(text), () => null);
            if (owner?.token === token)
                await fs.rm(lockPath, { recursive: true, force: true });
        }
        finally {
            await new Promise((resolve) => held.close(() => resolve(undefined)));
        }
    };
}
function pidExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Reserve a complete port set before another CLI invocation can allocate one. */
export async function reserveSession(names, makeReceipt, beforeAllocate) {
    if (names.length === 0 || new Set(names).size !== names.length) {
        throw new Error("Adapter must declare unique port names");
    }
    const release = await acquireLock();
    try {
        if (beforeAllocate)
            await beforeAllocate(await listReceipts());
        const used = new Set((await listReceipts())
            .filter((item) => item.state === "starting" || item.state === "ready" || item.state === "stopping")
            .flatMap((item) => Object.values(item.ports)));
        const ports = {};
        for (const name of names) {
            let found = false;
            // App URLs stay predictable across worktrees; emulator ports remain isolated.
            if (name === "web" || name === "app") {
                for (let candidate = 3000; candidate <= 3010; candidate++) {
                    if (used.has(candidate) || !(await canBind(candidate)))
                        continue;
                    ports[name] = candidate;
                    used.add(candidate);
                    found = true;
                    break;
                }
            }
            for (let attempt = 0; !found && attempt < 1000; attempt++) {
                const candidate = randomInt(20_000, 60_000);
                if (used.has(candidate) || !(await canBind(candidate)))
                    continue;
                ports[name] = candidate;
                used.add(candidate);
                found = true;
                break;
            }
            if (!found)
                throw new Error(`Unable to reserve a port for ${name}`);
        }
        const id = randomUUID();
        const dir = sessionPath(id);
        await fs.mkdir(path.join(dir, "data"), { recursive: true, mode: 0o700 });
        const receipt = makeReceipt(id, dir, ports);
        await writeReceipt(receipt);
        return receipt;
    }
    finally {
        await release();
    }
}
