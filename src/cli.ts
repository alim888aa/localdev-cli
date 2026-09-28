#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { processAlive, processHealth, spawnSeed, spawnService, stopService, waitForSeed, waitForService } from "./process.js";
import { listReceipts, readReceipt, reserveSession, sessionPath, writeReceipt } from "./state.js";
import { issueCommand } from "./issue.js";
import { helpFor } from "./help.js";
import type { ProjectAdapter, SessionReceipt } from "./types.js";

function usage(): never {
  throw new Error("Usage: localdev startup [fixture] [--project DIR] [--adapter FILE] | status [ID] | stop ID | issue bug|request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1]) usage();
  return args[index + 1];
}

function gitCommit(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

function validateCleanupPaths(paths: string[], id: string, root: string): void {
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

function launchDescription(mode: string | undefined): string | null {
  if (mode === undefined) return null;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(mode)) {
    throw new Error("Service launchMode must be a short, lowercase mode ID without arguments or secrets");
  }
  return launchModeDescriptions.get(mode) ?? mode;
}

async function cleanupPaths(receipt: SessionReceipt): Promise<void> {
  validateCleanupPaths(receipt.cleanupPaths ?? [], receipt.id, receipt.projectRoot);
  for (const item of receipt.cleanupPaths ?? []) await fs.rm(item, { recursive: true, force: true });
}

async function publicReceipt(receipt: SessionReceipt): Promise<object> {
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

async function startup(args: string[]): Promise<void> {
  const requestedFixture = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const projectRoot = path.resolve(option(args, "--project") ?? process.cwd());
  const adapterPath = path.resolve(option(args, "--adapter") ?? path.join(projectRoot, "local.adapter.mjs"));
  const imported = await import(pathToFileURL(adapterPath).href);
  const adapter = imported.default as ProjectAdapter;
  if (!adapter || !Array.isArray(adapter.ports) || typeof adapter.createSession !== "function") {
    throw new Error(`Invalid adapter: ${adapterPath}`);
  }
  const fixture = requestedFixture ?? adapter.defaultFixture;
  if (!fixture || typeof fixture !== "string" || !fixture.trim()) {
    throw new Error(`No fixture named. Set defaultFixture in ${adapterPath} or run localdev startup <fixture>`);
  }
  const receipt = await reserveSession(adapter.ports, (id, dir, ports) => ({
    id, fixture, projectRoot, commit: gitCommit(projectRoot), adapterPath,
    sessionDir: dir, dataDir: path.join(dir, "data"), ports,
    urls: {}, processes: [], state: "starting", ownerPid: process.pid,
    createdAt: new Date().toISOString(),
  }));
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
    if (!plan.services?.length) throw new Error("Adapter did not define any services");
    if (new Set(plan.services.map((item) => item.name)).size !== plan.services.length) {
      throw new Error("Service names must be unique");
    }
    for (const service of plan.services) launchDescription(service.launchMode);
    receipt.urls = plan.urls ?? {};
    receipt.credentialsFile = plan.credentialsFile;
    await writeReceipt(receipt);
    for (const service of plan.services) {
      const names = service.readyPorts ?? (service.readyPort ? [service.readyPort] : []);
      if (!names.length) throw new Error(`Service ${service.name} has no readiness ports`);
      const checks = names.map((name) => {
        const port = receipt.ports[name];
        if (!port) throw new Error(`Unknown readyPort: ${name}`);
        return { name, port, host: service.readyHost ?? "127.0.0.1" };
      });
      const { owned, child } = await spawnService(service, projectRoot, receipt.sessionDir);
      owned.launchMode = service.launchMode;
      owned.readyPort = checks[0].port;
      owned.readyHost = checks[0].host;
      owned.readyChecks = checks;
      receipt.processes.push(owned);
      await writeReceipt(receipt);
      for (const check of checks) await waitForService(child, service, check.port, owned);
    }
    if (plan.seed) {
      const { owned, child, exitFile } = await spawnSeed(plan.seed, projectRoot, receipt.sessionDir);
      receipt.processes.push(owned);
      await writeReceipt(receipt);
      await waitForSeed(child, exitFile, plan.seed.timeoutMs);
      if (!(await stopService(owned))) throw new Error("Could not verify ownership of the seed group during cleanup");
      receipt.processes = receipt.processes.filter((item) => item.pid !== owned.pid);
      await writeReceipt(receipt);
    }
    receipt.state = "ready";
    await writeReceipt(receipt);
    console.log(JSON.stringify(await publicReceipt(receipt), null, 2));
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    for (const owned of [...receipt.processes].reverse()) await stopService(owned);
    await cleanupPaths(receipt);
    receipt.state = "failed";
    await writeReceipt(receipt);
    throw new Error(`Session ${receipt.id} failed: ${receipt.error}. Logs: ${receipt.sessionDir}`);
  }
}

async function status(id?: string): Promise<void> {
  const receipts = id ? [await readReceipt(id)] : await listReceipts();
  console.log(JSON.stringify(await Promise.all(receipts.map(publicReceipt)), null, 2));
}

async function stop(id?: string): Promise<void> {
  if (!id) usage();
  let receipt: SessionReceipt;
  try { receipt = await readReceipt(id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(JSON.stringify({ id, stopped: true, alreadyGone: true }));
      return;
    }
    throw error;
  }
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
  console.log(JSON.stringify({ id, stopped: true }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const help = helpFor(argv);
  if (help) {
    console.log(help);
    return;
  }
  const [command, ...args] = argv;
  if (command === "startup") await startup(args);
  else if (command === "status") await status(args[0]);
  else if (command === "stop") await stop(args[0]);
  else if (command === "issue") await issueCommand(args);
  else usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
