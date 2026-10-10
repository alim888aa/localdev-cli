import { createHash, randomInt, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { processExists } from "./process-table.js";
// The one owner of session state on disk: receipts, the allocation lock that serialises their read-modify-writes,
// and port reservation.
export const stateRoot = path.resolve(process.env.LOCAL_CLI_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "local-cli"));
const sessionsRoot = path.join(stateRoot, "sessions");
const lockPath = path.join(stateRoot, "allocation.lock");
/** The one session-ID check: IDs are UUIDs, and only an ID that passes may name a path under the state dir. */
export function isSessionId(id) {
    return /^[0-9a-f-]{36}$/.test(id);
}
function sessionPath(id) {
    if (!isSessionId(id))
        throw new Error("Invalid session ID");
    return path.join(sessionsRoot, id);
}
// Session temp dirs sit in /tmp: a Unix socket path is capped at 104 bytes on macOS (108 on Linux), which paths under
// the state dir or os.tmpdir() can pass. The hash keeps one state dir's orphan sweep off another's sessions.
const tempRoot = "/tmp";
const tempPrefix = `lc-${createHash("sha256").update(stateRoot).digest("hex").slice(0, 8)}-`;
const tempName = /^lc-[0-9a-f]{8}-([0-9a-f-]{36})$/;
class ForeignTempDirError extends Error {
    constructor(dir) { super(`Session temp dir is not the session's own; refusing to remove ${dir}`); }
}
/** Delete a stopped session's temp dir, then its session dir; a temp dir not of this ID's fixed shape throws first. */
export async function removeSessionDirs({ id, tempDir }) {
    if (tempDir && (path.dirname(tempDir) !== tempRoot || tempName.exec(path.basename(tempDir))?.[1] !== id)) {
        throw new ForeignTempDirError(tempDir);
    }
    if (tempDir)
        await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(sessionPath(id), { recursive: true, force: true });
}
/**
 * Remove this state dir's temp dirs whose session dir is gone (say, an older localdev stopped it). Made after its
 * session dir and removed before it, a live one is never taken. Never throws: what it can't remove is named on stderr.
 */
export async function removeOrphanTempDirs() {
    const names = await fs.readdir(tempRoot).catch((error) => {
        console.error(`Could not look for orphaned session temp dirs in ${tempRoot}: ${error.message}`);
        return [];
    });
    for (const name of names) {
        const id = name.startsWith(tempPrefix) ? tempName.exec(name)?.[1] : undefined;
        if (!id)
            continue;
        const dir = path.join(tempRoot, name);
        try {
            const live = await fs.lstat(sessionPath(id)).then(() => true, (error) => {
                if (error.code === "ENOENT")
                    return false;
                throw error;
            });
            const stat = live ? null : await fs.lstat(dir);
            if (stat?.isDirectory() && stat.uid === process.getuid?.())
                await fs.rm(dir, { recursive: true, force: true });
        }
        catch (error) {
            console.error(`Could not remove orphaned session temp dir ${dir}: ${error.message}`);
        }
    }
}
export async function readReceipt(id) {
    const raw = await fs.readFile(path.join(sessionPath(id), "receipt.json"), "utf8");
    return JSON.parse(raw);
}
/** A receipt, or null when there is none (stop removes it, so stopped and unknown IDs look alike). Other errors throw. */
export async function findReceipt(id) {
    try {
        return await readReceipt(id);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
/** Thrown by updateReceipt when the session has no receipt; callers that expect that catch it. */
export class SessionGoneError extends Error {
    id;
    constructor(id) {
        super(`No session ${id}; it is unknown or already stopped`);
        this.id = id;
    }
}
/**
 * The one receipt read-modify-write: under the state lock, read the receipt fresh, let fn check and change it, and
 * write it back if fn returns (a throw writes nothing). Throws SessionGoneError when it is missing. Not reentrant
 * (see withStateLock): code already holding the lock uses updateLockedReceipt.
 */
export function updateReceipt(id, fn) {
    return withStateLock(() => updateLockedReceipt(id, fn));
}
/** updateReceipt for a caller that already holds the state lock, such as reserveSession's beforeAllocate. */
export async function updateLockedReceipt(id, fn) {
    const receipt = await requireReceipt(id);
    const result = await fn(receipt);
    await writeReceipt(receipt);
    return result;
}
/**
 * updateReceipt without the final write: for a check that must not interleave with a change but changes nothing, or
 * a change that must be written (writeReceipt) before a side effect, such as recording a pause before signalling.
 */
export function withReceipt(id, fn) {
    return withStateLock(async () => fn(await requireReceipt(id)));
}
async function requireReceipt(id) {
    const receipt = await findReceipt(id);
    if (!receipt)
        throw new SessionGoneError(id);
    return receipt;
}
/** The ports a session's services listen on. Receipts store bindPorts only when ports are proxied. */
export function bindPortsOf(receipt) {
    return receipt.bindPorts ?? receipt.ports;
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
/** Write a receipt as is: only for a new receipt, or inside updateReceipt or withReceipt (lock held, read fresh). */
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
// The allocation lock is a loopback TCP listener. The kernel lets one process listen on the port and frees it
// when that process exits, so a lock can never go stale and nothing ever has to reclaim one. The port is
// derived from the state directory (outside the 20000-59999 service range). LOCAL_CLI_LOCK_PORT overrides it;
// every process sharing a state directory must then use the same value, or they stop excluding each other.
export const lockPort = Number(process.env.LOCAL_CLI_LOCK_PORT) ||
    10_000 + (createHash("sha256").update(stateRoot).digest().readUInt32BE(0) % 10_000);
function listenOnce(port) {
    return new Promise((resolve, reject) => {
        // Nothing talks to the lock port; drop any stray connection so close() never waits on one.
        const server = net.createServer((socket) => socket.destroy());
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
        // An owner whose process is gone is crash debris and goes at once; a live owner is always waited for,
        // whatever wrote it. Without an owner file, only age can tell (the accepted >30 s legacy limit).
        const abandoned = owner ? !processExists(owner.pid) : Date.now() - modified > 30_000;
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
/**
 * Run fn under the allocation lock. Receipt read-modify-writes go through updateReceipt, which uses it, so two
 * commands cannot each write back a receipt missing the other's change. Not reentrant: code already inside
 * reserveSession's beforeAllocate holds the lock and must not call this or updateReceipt (it would wait forever).
 */
export async function withStateLock(fn) {
    const release = await acquireLock();
    try {
        return await fn();
    }
    finally {
        await release();
    }
}
/**
 * Reserve a complete port set before another CLI invocation can allocate one. Each name in bindNames also gets a
 * private bind port (always from the random range); the others bind their public port. beforeAllocate runs with the
 * lock held (see withStateLock). Unique, non-empty port names are checked here, the one owner of that rule.
 */
export async function reserveSession(names, makeReceipt, beforeAllocate, bindNames = []) {
    if (names.length === 0 || new Set(names).size !== names.length) {
        throw new Error("Adapter must declare unique port names");
    }
    const release = await acquireLock();
    try {
        await removeOrphanTempDirs();
        if (beforeAllocate)
            await beforeAllocate(await listReceipts());
        const used = new Set((await listReceipts())
            .filter((item) => item.state === "starting" || item.state === "ready" || item.state === "stopping")
            .flatMap((item) => [...Object.values(item.ports), ...Object.values(item.bindPorts ?? {})]));
        const ports = {};
        const bindPorts = {};
        for (const [index, name] of [...names, ...bindNames].entries()) {
            const into = index < names.length ? ports : bindPorts;
            let found = false;
            // App URLs stay predictable across worktrees; emulator ports remain isolated.
            if (into === ports && (name === "web" || name === "app")) {
                for (let candidate = 3000; candidate <= 3010; candidate++) {
                    if (used.has(candidate) || !(await canBind(candidate)))
                        continue;
                    into[name] = candidate;
                    used.add(candidate);
                    found = true;
                    break;
                }
            }
            for (let attempt = 0; !found && attempt < 1000; attempt++) {
                const candidate = randomInt(20_000, 60_000);
                if (used.has(candidate) || !(await canBind(candidate)))
                    continue;
                into[name] = candidate;
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
        // Not recursive, so an existing path (another user's, a planted link) fails; chmod because the umask masks mkdir.
        const tempDir = path.join(tempRoot, tempPrefix + id);
        await fs.mkdir(tempDir, { mode: 0o700 });
        await fs.chmod(tempDir, 0o700);
        const receipt = { ...makeReceipt(id, dir, ports, { ...ports, ...bindPorts }), tempDir };
        await writeReceipt(receipt);
        return receipt;
    }
    finally {
        await release();
    }
}
