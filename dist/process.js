import { spawn } from "node:child_process";
import { closeSync, openSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxListenerOwned, linuxListenerPids } from "./linux-listener.js";
import { applyOutboundPolicy } from "./outbound.js";
import { birthOf, compareBirth, isSameProcess, listProcesses, processEntry } from "./process-table.js";
import { runSync } from "./run-sync.js";
const supervisorPath = fileURLToPath(new URL("./supervisor.js", import.meta.url));
function tableMap() {
    const entries = listProcesses();
    return entries && new Map(entries.map((entry) => [entry.pid, entry]));
}
/** The recorded process is still the same one (birth) and still in the group about to be signalled. */
function memberStillIn(member, pgid) {
    return isSameProcess(member.pid, member.birth) && processEntry(member.pid)?.group === pgid;
}
function isOwned(record) {
    return isSameProcess(record.pid, record.birth);
}
function guardOwnsGroup(record) {
    return isSameProcess(record.guardPid, record.guardBirth) && processEntry(record.guardPid)?.group === record.pid;
}
function groupExists(pgid) {
    try {
        process.kill(-pgid, 0);
    }
    catch {
        return false;
    }
    // Exited members stay signalable as zombies until reaped, and some sandboxes' PID 1 reaps slowly.
    // Only a live member means the group is still running; an unreadable table counts as running.
    const table = listProcesses();
    return table === null || table.some((entry) => entry.group === pgid && !entry.zombie);
}
function descendsFromGroup(pid, pgid, table) {
    const seen = new Set();
    let current = pid;
    while (table && current > 1 && !seen.has(current)) {
        seen.add(current);
        const entry = table.get(current);
        if (!entry)
            return false;
        if (entry.group === pgid)
            return true;
        current = entry.parent;
    }
    return false;
}
/**
 * Descendants of the owned group that moved into their own process group, which a group signal misses.
 * Every current member is recorded, so the group stays verifiable after the process that created it exits.
 */
function findEscapedGroups(pgid) {
    const table = tableMap() ?? new Map();
    const groups = new Set();
    for (const [, info] of table) {
        if (info.group === pgid || groups.has(info.group))
            continue;
        const seen = new Set();
        let current = info.parent;
        while (current > 1 && !seen.has(current)) {
            seen.add(current);
            const ancestor = table.get(current);
            if (!ancestor)
                break;
            if (ancestor.group === pgid) {
                groups.add(info.group);
                break;
            }
            current = ancestor.parent;
        }
    }
    return [...groups].map((group) => ({
        pgid: group,
        members: [...table.values()].filter((info) => info.group === group)
            .map(({ pid }) => ({ pid, birth: birthOf(pid) }))
            .filter((member) => member.birth !== null),
    })).filter((group) => group.members.length);
}
function mergeGroups(...lists) {
    const merged = new Map();
    for (const list of lists) {
        for (const stored of list ?? []) {
            const members = "members" in stored ? stored.members : [{ pid: stored.pid, birth: stored.birth }];
            const known = merged.get(stored.pgid) ?? new Map();
            for (const member of members)
                if (!known.has(member.pid))
                    known.set(member.pid, member);
            merged.set(stored.pgid, known);
        }
    }
    return [...merged].map(([pgid, members]) => ({ pgid, members: [...members.values()] }));
}
/** Check the listener PID, so another app cannot make an owned session look healthy. */
function ownedListener(record) {
    if (!record.readyPort)
        return false;
    if (process.platform === "linux" && linuxListenerOwned(record.readyPort, record.pid))
        return true;
    try {
        const output = runSync("lsof", ["-nP", `-iTCP:${record.readyPort}`, "-sTCP:LISTEN", "-Fp"]);
        const pids = output.split("\n")
            .filter((line) => /^p\d+$/.test(line))
            .map((line) => Number(line.slice(1)));
        const table = tableMap();
        return pids.some((pid) => descendsFromGroup(pid, record.pid, table));
    }
    catch {
        return false;
    }
}
/** PIDs listening on a TCP port, whoever owns them. Ownership is checked by the caller. */
export function listenerPids(port) {
    if (process.platform === "linux") {
        const pids = linuxListenerPids(port);
        if (pids?.length)
            return pids;
    }
    try {
        const output = runSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
        return [...new Set(output.split("\n").filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))];
    }
    catch {
        return [];
    } // lsof exits 1 when nothing listens.
}
/**
 * Listeners on a port that belong to this session process: inside its verified group, or inside a recorded
 * escaped group that still has a verified member (its creator may have exited, so ancestry alone misses it).
 * A listener from another session or an unrelated app is never returned, so it can never be signalled.
 */
export function ownedListenerProcesses(record, port) {
    const groups = mergeGroups(record.escapedGroups)
        .filter((group) => group.members.some((member) => memberStillIn(member, group.pgid)))
        .map((group) => group.pgid);
    if (processAlive(record))
        groups.unshift(record.pid);
    if (!groups.length)
        return [];
    const owned = [];
    for (const pid of listenerPids(port)) {
        // Birth first, then ancestry from a table read after it, then the same birth again: a PID that exits and is
        // reused around the ancestry check would otherwise be recorded with the newcomer's birth (or certified by a
        // table read before the newcomer existed) and later pass signalProcess.
        const birth = birthOf(pid);
        if (birth === null)
            continue;
        const table = tableMap();
        if (!groups.some((pgid) => descendsFromGroup(pid, pgid, table)))
            continue;
        if (isSameProcess(pid, birth))
            owned.push({ pid, birth });
    }
    return owned;
}
/**
 * Signal one recorded process only while it is still the same process (start time), never a reused PID.
 * "gone" means confirmed exited or reused; "failed" means it may still be the recorded process but was not signalled.
 */
export function signalProcess(member, signal) {
    const identity = compareBirth(member.pid, member.birth);
    if (identity === "different")
        return "gone";
    // Its birth could not be read: gone if the PID no longer exists, otherwise it may still be the recorded process.
    if (identity === "unknown")
        return processExists(member.pid) ? "failed" : "gone";
    try {
        process.kill(member.pid, signal);
        return "signalled";
    }
    catch (error) {
        return error.code === "ESRCH" ? "gone" : "failed";
    }
}
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
function portOpen(host, port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(2000);
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
}
/** A persistent supervisor keeps the process group identifiable if a launcher exits. */
async function spawnManaged(name, spec, root, sessionDir, outbound) {
    const token = randomUUID();
    const log = path.join(sessionDir, `${name}.log`);
    const configFile = path.join(sessionDir, `${token}.command.json`);
    const exitFile = path.join(sessionDir, `${token}.exit.json`);
    const guardFile = path.join(sessionDir, `${token}.guard.pid`);
    await fs.writeFile(configFile, JSON.stringify({
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? root,
        env: applyOutboundPolicy({ ...process.env, ...spec.env }, outbound),
        exitFile,
        guardFile,
    }), { mode: 0o600 });
    const logFd = openSync(log, "a", 0o600);
    const child = spawn(process.execPath, [supervisorPath, configFile], {
        cwd: root,
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    try {
        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
        const birth = birthOf(child.pid);
        if (!birth)
            throw new Error(`Could not identify ${name} supervisor`);
        let guardPid = 0;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                guardPid = Number(await fs.readFile(guardFile, "utf8"));
                break;
            }
            catch {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
        const guardBirth = guardPid ? birthOf(guardPid) : null;
        if (!guardBirth)
            throw new Error(`Could not identify ${name} guard`);
        await fs.rm(guardFile, { force: true });
        return { owned: { name, pid: child.pid, birth, guardPid, guardBirth, log, exitFile }, child, exitFile };
    }
    catch (error) {
        await fs.rm(configFile, { force: true }).catch(() => undefined);
        if (child.pid) {
            if (processEntry(child.pid)) {
                try {
                    process.kill(-child.pid, "SIGTERM");
                }
                catch { /* Already exited. */ }
            }
        }
        throw error;
    }
}
export function spawnService(spec, root, dir, outbound) {
    return spawnManaged(spec.name, spec, root, dir, outbound);
}
export function spawnSeed(spec, root, dir, outbound) {
    return spawnManaged("seed", spec, root, dir, outbound);
}
export async function waitForService(child, spec, port, record, ensureActive) {
    const deadline = Date.now() + (spec.readyTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
        await ensureActive();
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`${spec.name} supervisor exited before port ${port} was ready`);
        }
        try {
            const exit = JSON.parse(await fs.readFile(record.exitFile, "utf8"));
            // A successful launcher may leave its server child listening in this group.
            if (exit.code !== 0 || exit.signal) {
                throw new Error(`${spec.name} command exited (${exit.signal ?? `code ${exit.code}`}) before port ${port} was ready; log: ${record.log}`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (await portOpen(spec.readyHost ?? "127.0.0.1", port) && ownedListener({ ...record, readyPort: port })) {
            await ensureActive();
            // Record detached descendants now: once their launcher exits, ancestry can no longer find them.
            record.escapedGroups = mergeGroups(record.escapedGroups, findEscapedGroups(record.pid));
            child.unref();
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${spec.name} did not listen on port ${port} in time`);
}
export async function waitForSeed(child, exitFile, timeoutMs = 300_000, ensureActive) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error("Seed timeout must be positive");
    const deadline = Date.now() + timeoutMs;
    while (child.exitCode === null && child.signalCode === null) {
        await ensureActive?.();
        try {
            const result = JSON.parse(await fs.readFile(exitFile, "utf8"));
            if (result.code !== 0) {
                throw new Error(`Fixture seed failed (${result.signal ?? result.code}); see seed.log`);
            }
            return;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (Date.now() >= deadline)
            throw new Error(`Fixture seed timed out after ${timeoutMs}ms; see seed.log`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Fixture seed supervisor exited before recording a result");
}
/**
 * Stop the owned process group, including children left by an exited launcher and descendants that
 * moved into their own groups. Returns false unless every owned group is verified gone. `hard` sends SIGKILL at
 * once, like a crash, for `fault --mode kill`.
 */
export async function stopService(record, { hard = false } = {}) {
    const mainAlive = groupExists(record.pid);
    if (mainAlive && !isOwned(record) && !guardOwnsGroup(record))
        return false;
    const known = mergeGroups(record.escapedGroups, mainAlive ? findEscapedGroups(record.pid) : [])
        .filter((group) => groupExists(group.pgid));
    // An escaped group is signalled only while a recorded member is still the same process (no PID reuse).
    // A live group with no verifiable member fails closed so the receipt is kept for inspection.
    const verified = known.filter((group) => group.members.some((member) => memberStillIn(member, group.pgid)));
    const unverified = known.length - verified.length;
    if (!mainAlive && !verified.length)
        return unverified === 0;
    const targets = [...(mainAlive ? [record.pid] : []), ...verified.map((group) => group.pgid)];
    // Re-check identity before each signal: a group ID can be reused once all of its members exit.
    const stillOwned = (pgid) => pgid === record.pid
        ? isOwned(record) || guardOwnsGroup(record)
        : verified.find((group) => group.pgid === pgid).members.some((member) => memberStillIn(member, pgid));
    // SIGCONT after SIGTERM: a member paused by `localdev fault` (or by hand) only acts on SIGTERM once continued.
    for (const pgid of targets) {
        if (!stillOwned(pgid))
            continue;
        if (hard) {
            try {
                process.kill(-pgid, "SIGKILL");
            }
            catch { /* Already exited. */ }
            continue;
        }
        try {
            process.kill(-pgid, "SIGTERM");
        }
        catch {
            continue; /* Already exited. */
        }
        if (stillOwned(pgid)) {
            try {
                process.kill(-pgid, "SIGCONT");
            }
            catch { /* Already exited. */ }
        }
    }
    const remaining = () => targets.filter(groupExists);
    const deadline = Date.now() + (hard ? 0 : 4_000);
    while (Date.now() < deadline && remaining().length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // A remaining group whose identity can no longer be verified is not force-killed; it fails closed below.
    for (const pgid of remaining()) {
        if (stillOwned(pgid)) {
            try {
                process.kill(-pgid, "SIGKILL");
            }
            catch { /* Already exited. */ }
        }
    }
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && remaining().length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return remaining().length === 0 && unverified === 0;
}
/** The owned group still has a live (non-zombie) member and its identity checks out. */
export function processAlive(record) {
    return groupExists(record.pid) && (isOwned(record) || guardOwnsGroup(record));
}
export async function processHealth(record) {
    let commandExit = null;
    try {
        commandExit = JSON.parse(await fs.readFile(record.exitFile, "utf8"));
    }
    catch { /* The command has not exited. */ }
    const ports = record.readyChecks ?? (record.readyPort ? [{ name: "ready", port: record.readyPort, host: record.readyHost ?? "127.0.0.1" }] : []);
    const checks = await Promise.all(ports.map(async ({ name, port, host }) => ({
        name,
        reachable: await portOpen(host, port),
        listenerOwned: ownedListener({ ...record, readyPort: port }),
    })));
    return {
        reachable: checks.length ? checks.every((item) => item.reachable) : null,
        listenerOwned: checks.length ? checks.every((item) => item.listenerOwned) : null,
        checks,
        commandExit,
    };
}
