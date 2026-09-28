#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { birthOf, processAlive, processHealth, spawnSeed, spawnService, stopService, waitForSeed, waitForService } from "./process.js";
import { listReceipts, readReceipt, reserveSession, sessionPath, writeReceipt } from "./state.js";
import { issueCommand } from "./issue.js";
import { helpFor } from "./help.js";
function usage() {
    throw new Error("Usage: localdev startup [fixture] [--project DIR] [--adapter FILE] [--replace [ID] | --parallel] | status [ID] | stop ID | issue bug|request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]");
}
function option(args, name) {
    const index = args.indexOf(name);
    if (index < 0)
        return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--"))
        usage();
    return args[index + 1];
}
function startupChoice(args) {
    const parallel = args.includes("--parallel");
    const index = args.indexOf("--replace");
    if (parallel && index >= 0)
        throw new Error("Choose either --replace or --parallel");
    const replaceId = index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : undefined;
    if (replaceId && !/^[0-9a-f-]{36}$/.test(replaceId))
        throw new Error(`Invalid --replace session ID: ${replaceId}`);
    return { parallel, replace: index >= 0, replaceId };
}
class DuplicateSessionError extends Error {
    matches;
    constructor(matches) {
        const summary = matches.map(({ id, state, commit, urls }) => `${id} (${state}, ${safeSessionOrigin(urls)}, commit ${commit ?? "unknown"})`).join("; ");
        super(`Existing session for this checkout and fixture: ${summary}. Use --replace [ID] or --parallel.`);
        this.matches = matches;
    }
}
function safeSessionOrigin(urls) {
    const raw = urls.app ?? Object.values(urls)[0];
    if (!raw)
        return "no URL yet";
    try {
        const url = new URL(raw);
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "URL in status";
    }
    catch {
        return "URL in status";
    }
}
async function matchingSessions(receipts, root, fixture) {
    const candidates = receipts.filter((item) => item.fixture === fixture);
    const matches = await Promise.all(candidates.map(async (item) => {
        const itemRoot = await fs.realpath(item.projectRoot).catch(() => path.resolve(item.projectRoot));
        if (itemRoot !== root)
            return null;
        if (item.state === "starting") {
            return item.ownerBirth && birthOf(item.ownerPid) === item.ownerBirth ? item : null;
        }
        if (item.state !== "ready" && item.state !== "stopping" && item.state !== "failed")
            return null;
        if (!item.processes.length)
            return null;
        for (const record of item.processes) {
            if (!processAlive(record))
                return null;
            const health = await processHealth(record);
            if (health.reachable === false || health.listenerOwned === false)
                return null;
        }
        return item;
    }));
    return matches.filter((item) => item !== null);
}
async function askAboutDuplicates(matches) {
    console.error(new DuplicateSessionError(matches).message);
    const reader = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = (await reader.question("Type parallel, replace <id>, or press Enter to cancel: ")).trim();
        if (answer === "parallel")
            return { parallel: true, replace: false };
        if (answer === "replace" && matches.length === 1)
            return { parallel: false, replace: true, replaceId: matches[0].id };
        const selected = /^replace ([0-9a-f-]{36})$/.exec(answer)?.[1];
        if (selected && matches.some((item) => item.id === selected))
            return { parallel: false, replace: true, replaceId: selected };
        throw new Error("Startup cancelled; existing sessions were left running");
    }
    finally {
        reader.close();
    }
}
function gitCommit(root) {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return null;
    }
}
function validateCleanupPaths(paths, id, root) {
    for (const item of paths) {
        if (!path.isAbsolute(item) || path.dirname(item) !== root || !path.basename(item).startsWith(`.local-cli-${id}.`)) {
            throw new Error(`Adapter cleanup path must be ID-scoped in project root: ${item}`);
        }
    }
}
const launchModeDescriptions = new Map([
    ["next-turbopack", "next dev --turbopack"],
    ["next-webpack", "next dev --webpack"],
    ["vite", "vite"],
    ["tanstack-start", "tanstack start"],
]);
function launchDescription(mode) {
    if (mode === undefined)
        return null;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(mode)) {
        throw new Error("Service launchMode must be a short, lowercase mode ID without arguments or secrets");
    }
    return launchModeDescriptions.get(mode) ?? mode;
}
async function cleanupPaths(receipt) {
    validateCleanupPaths(receipt.cleanupPaths ?? [], receipt.id, receipt.projectRoot);
    for (const item of receipt.cleanupPaths ?? [])
        await fs.rm(item, { recursive: true, force: true });
}
async function publicReceipt(receipt) {
    const processes = await Promise.all(receipt.processes.map(async (record) => {
        const groupOwned = processAlive(record);
        const health = await processHealth(record);
        return {
            name: record.name,
            launchMode: record.launchMode ?? null,
            launch: launchDescription(record.launchMode),
            pid: record.pid,
            guardPid: record.guardPid,
            birth: record.birth,
            groupOwned,
            alive: groupOwned && health.listenerOwned !== false && health.reachable !== false,
            ...health,
        };
    }));
    const degraded = receipt.state === "ready" && processes.some((item) => item.reachable === false || item.listenerOwned === false);
    return {
        id: receipt.id,
        state: degraded ? "degraded" : receipt.state,
        fixture: receipt.fixture,
        checkout: receipt.projectRoot,
        commit: receipt.commit,
        ports: receipt.ports,
        urls: receipt.urls,
        dataDir: receipt.dataDir,
        credentialsFile: receipt.credentialsFile,
        logs: receipt.processes.map(({ name, log }) => ({ name, path: log })),
        processes,
        error: receipt.error,
    };
}
async function startup(args) {
    const requestedFixture = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
    const projectRoot = await fs.realpath(path.resolve(option(args, "--project") ?? process.cwd()));
    const adapterPath = path.resolve(option(args, "--adapter") ?? path.join(projectRoot, "local.adapter.mjs"));
    const imported = await import(pathToFileURL(adapterPath).href);
    const adapter = imported.default;
    if (!adapter || !Array.isArray(adapter.ports) || typeof adapter.createSession !== "function") {
        throw new Error(`Invalid adapter: ${adapterPath}`);
    }
    const fixture = requestedFixture ?? adapter.defaultFixture;
    if (!fixture || typeof fixture !== "string" || !fixture.trim()) {
        throw new Error(`No fixture named. Set defaultFixture in ${adapterPath} or run localdev startup <fixture>`);
    }
    const ownerBirth = birthOf(process.pid);
    if (!ownerBirth)
        throw new Error("Could not verify startup process identity");
    let choice = startupChoice(args);
    let receipt;
    for (;;) {
        try {
            receipt = await reserveSession(adapter.ports, (id, dir, ports) => ({
                id, fixture, projectRoot, commit: gitCommit(projectRoot), adapterPath,
                sessionDir: dir, dataDir: path.join(dir, "data"), ports,
                urls: {}, processes: [], state: "starting", ownerPid: process.pid, ownerBirth,
                createdAt: new Date().toISOString(),
            }), async (receipts) => {
                const matches = await matchingSessions(receipts, projectRoot, fixture);
                if (choice.replaceId && !matches.some((item) => item.id === choice.replaceId)) {
                    throw new Error(`Cannot replace ${choice.replaceId}: no healthy matching session for this checkout and fixture`);
                }
                if (!matches.length || choice.parallel)
                    return;
                if (!choice.replace)
                    throw new DuplicateSessionError(matches);
                const selected = choice.replaceId
                    ? matches.find((item) => item.id === choice.replaceId)
                    : matches.length === 1 ? matches[0] : undefined;
                if (!selected)
                    throw new DuplicateSessionError(matches);
                if (selected.state !== "ready") {
                    throw new Error(`Session ${selected.id} is still ${selected.state}; wait for it to settle before replacing it`);
                }
                await stopReceipt(selected);
            });
            break;
        }
        catch (error) {
            if (!(error instanceof DuplicateSessionError) || !process.stdin.isTTY || choice.parallel || choice.replace)
                throw error;
            choice = await askAboutDuplicates(error.matches);
        }
    }
    try {
        const context = {
            id: receipt.id, fixture, projectRoot,
            sessionDir: receipt.sessionDir, dataDir: receipt.dataDir, ports: receipt.ports,
        };
        receipt.cleanupPaths = adapter.cleanupPaths?.(context) ?? [];
        validateCleanupPaths(receipt.cleanupPaths, receipt.id, projectRoot);
        await writeReceipt(receipt);
        const plan = await adapter.createSession(context);
        if ("cleanupPaths" in plan) {
            throw new Error("Adapter cleanupPaths must be declared before createSession");
        }
        if (!plan.services?.length)
            throw new Error("Adapter did not define any services");
        if (new Set(plan.services.map((item) => item.name)).size !== plan.services.length) {
            throw new Error("Service names must be unique");
        }
        for (const service of plan.services)
            launchDescription(service.launchMode);
        receipt.urls = plan.urls ?? {};
        receipt.credentialsFile = plan.credentialsFile;
        await writeReceipt(receipt);
        for (const service of plan.services) {
            const names = service.readyPorts ?? (service.readyPort ? [service.readyPort] : []);
            if (!names.length)
                throw new Error(`Service ${service.name} has no readiness ports`);
            const checks = names.map((name) => {
                const port = receipt.ports[name];
                if (!port)
                    throw new Error(`Unknown readyPort: ${name}`);
                return { name, port, host: service.readyHost ?? "127.0.0.1" };
            });
            const { owned, child } = await spawnService(service, projectRoot, receipt.sessionDir);
            owned.launchMode = service.launchMode;
            owned.readyPort = checks[0].port;
            owned.readyHost = checks[0].host;
            owned.readyChecks = checks;
            receipt.processes.push(owned);
            await writeReceipt(receipt);
            for (const check of checks)
                await waitForService(child, service, check.port, owned);
        }
        if (plan.seed) {
            const { owned, child, exitFile } = await spawnSeed(plan.seed, projectRoot, receipt.sessionDir);
            receipt.processes.push(owned);
            await writeReceipt(receipt);
            await waitForSeed(child, exitFile, plan.seed.timeoutMs);
            if (!(await stopService(owned)))
                throw new Error("Could not verify ownership of the seed group during cleanup");
            receipt.processes = receipt.processes.filter((item) => item.pid !== owned.pid);
            await writeReceipt(receipt);
        }
        receipt.state = "ready";
        await writeReceipt(receipt);
        console.log(JSON.stringify(await publicReceipt(receipt), null, 2));
    }
    catch (error) {
        receipt.error = error instanceof Error ? error.message : String(error);
        for (const owned of [...receipt.processes].reverse())
            await stopService(owned);
        await cleanupPaths(receipt);
        receipt.state = "failed";
        await writeReceipt(receipt);
        throw new Error(`Session ${receipt.id} failed: ${receipt.error}. Logs: ${receipt.sessionDir}`);
    }
}
async function status(id) {
    const receipts = id ? [await readReceipt(id)] : await listReceipts();
    console.log(JSON.stringify(await Promise.all(receipts.map(publicReceipt)), null, 2));
}
async function stop(id) {
    if (!id)
        usage();
    let receipt;
    try {
        receipt = await readReceipt(id);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            console.log(JSON.stringify({ id, stopped: true, alreadyGone: true }));
            return;
        }
        throw error;
    }
    await stopReceipt(receipt);
    console.log(JSON.stringify({ id, stopped: true }));
}
async function stopReceipt(receipt) {
    const id = receipt.id;
    receipt.state = "stopping";
    await writeReceipt(receipt);
    for (const owned of [...receipt.processes].reverse()) {
        if (!(await stopService(owned))) {
            receipt.error = `Could not verify ownership of ${owned.name} process group`;
            receipt.state = "failed";
            await writeReceipt(receipt);
            throw new Error(`${receipt.error}; session ${id} was kept for inspection`);
        }
    }
    await cleanupPaths(receipt);
    await fs.rm(sessionPath(id), { recursive: true, force: true });
}
async function main() {
    const argv = process.argv.slice(2);
    const help = helpFor(argv);
    if (help) {
        console.log(help);
        return;
    }
    const [command, ...args] = argv;
    if (command === "startup")
        await startup(args);
    else if (command === "status")
        await status(args[0]);
    else if (command === "stop")
        await stop(args[0]);
    else if (command === "issue")
        await issueCommand(args);
    else
        usage();
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
