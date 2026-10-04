import { randomInt, randomUUID } from "node:crypto";
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
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}
/** Read the owner of the current lock: a lock file, or (from older localdev) a directory holding owner.json. */
async function lockOwner() {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat)
        return null;
    const file = stat.isDirectory() ? path.join(lockPath, "owner.json") : lockPath;
    const owner = await fs.readFile(file, "utf8").then((text) => JSON.parse(text), () => null);
    return { owner, directory: stat.isDirectory(), modifiedMs: stat.mtimeMs };
}
async function acquireLock() {
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    for (let attempt = 0; attempt < 600; attempt++) {
        // Write the owner record first, then hard-link it into place. link() never replaces an existing
        // file or directory, so a live holder's lock (new or legacy) can't be taken over.
        const staging = `${lockPath}.${process.pid}.${token}`;
        await fs.writeFile(staging, JSON.stringify({ pid: process.pid, time: Date.now(), token }), { mode: 0o600 });
        try {
            await fs.link(staging, lockPath);
            return async () => {
                // Release only our own lock, never one another process reclaimed after ours went stale.
                const current = await lockOwner();
                if (current?.owner?.token === token && !current.directory)
                    await fs.rm(lockPath, { force: true });
            };
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const current = await lockOwner();
            if (current?.owner) {
                if (Date.now() - current.owner.time > 30_000 && !pidExists(current.owner.pid)) {
                    await fs.rm(lockPath, { recursive: true, force: true });
                    continue;
                }
            }
            else if (current?.directory && Date.now() - current.modifiedMs > 30_000) {
                // Only an older localdev leaves a lock directory without an owner file. After 30 s its writer
                // is presumed dead; a legacy writer paused longer than that is a known mixed-version limit.
                await fs.rm(lockPath, { recursive: true, force: true });
                continue;
            }
        }
        finally {
            await fs.rm(staging, { force: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for the local session allocation lock");
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
