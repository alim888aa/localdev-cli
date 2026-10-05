#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { birthOf, processAlive, processHealth, spawnSeed, stopService, waitForSeed } from "./process.js";
import { listReceipts, readReceipt, reserveSession, sessionPath, withStateLock, writeReceipt } from "./state.js";
import { issueCommand } from "./issue.js";
import { activeFaults, applyFault, clearFaults, faultModes, isFaultMode, releaseHeld, resumeAllFaults, type FaultRequest } from "./fault.js";
import { helpFor } from "./help.js";
import { launchService } from "./launch.js";
import { checkServiceName, countUnit, proxyLaunch } from "./proxy.js";
import type { ProjectAdapter, ProxyUnit, ServiceSpec, SessionReceipt } from "./types.js";

function usage(): never {
  throw new Error("Usage: localdev startup [fixture] [--project DIR] [--adapter FILE] [--replace [ID] | --parallel] [--no-outbound] | status [ID] | stop ID | fault ID PORT --mode pause|fail|slow|hold|kill [--ms N] [--count N] | fault ID PORT --release [--count N] | fault ID [PORT] --clear | issue bug|request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) usage();
  return args[index + 1];
}

interface StartupChoice {
  parallel: boolean;
  replace: boolean;
  replaceId?: string;
}

function startupChoice(args: string[]): StartupChoice {
  const parallel = args.includes("--parallel");
  const index = args.indexOf("--replace");
  if (parallel && index >= 0) throw new Error("Choose either --replace or --parallel");
  const replaceId = index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : undefined;
  if (replaceId && !/^[0-9a-f-]{36}$/.test(replaceId)) throw new Error(`Invalid --replace session ID: ${replaceId}`);
  return { parallel, replace: index >= 0, replaceId };
}

class DuplicateSessionError extends Error {
  constructor(readonly matches: SessionReceipt[]) {
    const summary = matches.map(({ id, state, commit, urls }) =>
      `${id} (${state}, ${safeSessionOrigin(urls)}, commit ${commit ?? "unknown"})`).join("; ");
    super(`Existing session for this checkout and fixture: ${summary}. Use --replace [ID] or --parallel.`);
  }
}

function safeSessionOrigin(urls: Record<string, string>): string {
  const raw = urls.app ?? Object.values(urls)[0];
  if (!raw) return "no URL yet";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "URL in status";
  } catch { return "URL in status"; }
}

async function matchingSessions(receipts: SessionReceipt[], root: string, fixture: string): Promise<SessionReceipt[]> {
  const candidates = receipts.filter((item) => item.fixture === fixture);
  const matches = await Promise.all(candidates.map(async (item) => {
    const itemRoot = await fs.realpath(item.projectRoot).catch(() => path.resolve(item.projectRoot));
    if (itemRoot !== root) return null;
    if (item.state === "starting") {
      return item.ownerBirth && birthOf(item.ownerPid) === item.ownerBirth ? item : null;
    }
    if (item.state !== "ready" && item.state !== "stopping" && item.state !== "failed") return null;
    if (!item.processes.length) return null;
    for (const record of item.processes) {
      if (!processAlive(record)) return null;
      const health = await processHealth(record);
      if (health.reachable === false || health.listenerOwned === false) return null;
    }
    return item;
  }));
  return matches.filter((item): item is SessionReceipt => item !== null);
}

async function askAboutDuplicates(matches: SessionReceipt[]): Promise<StartupChoice> {
  console.error(new DuplicateSessionError(matches).message);
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await reader.question("Type parallel, replace <id>, or press Enter to cancel: ")).trim();
    if (answer === "parallel") return { parallel: true, replace: false };
    if (answer === "replace" && matches.length === 1) return { parallel: false, replace: true, replaceId: matches[0].id };
    const selected = /^replace ([0-9a-f-]{36})$/.exec(answer)?.[1];
    if (selected && matches.some((item) => item.id === selected)) return { parallel: false, replace: true, replaceId: selected };
    throw new Error("Startup cancelled; existing sessions were left running");
  } finally {
    reader.close();
  }
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

class StartupStoppedError extends Error {
  constructor(id: string) { super(`Session ${id} was stopped during startup`); }
}

/** A separate stop command may cancel startup while a service or seed is waiting. */
async function ensureState(id: string, state: SessionReceipt["state"]): Promise<void> {
  try {
    if ((await readReceipt(id)).state !== state) throw new StartupStoppedError(id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StartupStoppedError(id);
    throw error;
  }
}

function ensureStarting(id: string): Promise<void> { return ensureState(id, "starting"); }

async function publicReceipt(receipt: SessionReceipt): Promise<object> {
  const processes = await Promise.all(receipt.processes.map(async (record) => {
    const groupOwned = processAlive(record);
    const health = await processHealth(record);
    return {
      name: record.name,
      ...(record.role ? { role: record.role } : {}),
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
  const { faults, proxy } = await activeFaults(receipt);
  return {
    id: receipt.id,
    state: degraded ? "degraded" : receipt.state,
    fixture: receipt.fixture,
    checkout: receipt.projectRoot,
    commit: receipt.commit,
    ports: receipt.ports,
    proxiedPorts: Object.fromEntries(Object.entries(receipt.proxyPorts ?? {})
      .map(([name, unit]) => [name, countUnit(unit)])),
    outbound: receipt.outbound === "deny" ? "blocked" : "allowed",
    urls: receipt.urls,
    dataDir: receipt.dataDir,
    credentialsFile: receipt.credentialsFile,
    logs: receipt.processes.map(({ name, log }) => ({ name, path: log })),
    processes,
    faults,
    ...(proxy ? { proxy } : {}),
    error: receipt.error,
  };
}

async function startup(args: string[]): Promise<void> {
  const requestedFixture = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  const projectRoot = await fs.realpath(path.resolve(option(args, "--project") ?? process.cwd()));
  const adapterPath = path.resolve(option(args, "--adapter") ?? path.join(projectRoot, "local.adapter.mjs"));
  const imported = await import(pathToFileURL(adapterPath).href);
  const adapter = imported.default as ProjectAdapter;
  if (!adapter || !Array.isArray(adapter.ports) || typeof adapter.createSession !== "function") {
    throw new Error(`Invalid adapter: ${adapterPath}`);
  }
  const proxyPorts = adapterProxyPorts(adapter, adapterPath);
  const fixture = requestedFixture ?? adapter.defaultFixture;
  if (!fixture || typeof fixture !== "string" || !fixture.trim()) {
    throw new Error(`No fixture named. Set defaultFixture in ${adapterPath} or run localdev startup <fixture>`);
  }
  const ownerBirth = birthOf(process.pid);
  if (!ownerBirth) throw new Error("Could not verify startup process identity");
  let choice = startupChoice(args);
  let receipt: SessionReceipt;
  for (;;) {
    try {
      receipt = await reserveSession(adapter.ports, (id, dir, ports, bindPorts) => ({
        id, fixture, projectRoot, commit: gitCommit(projectRoot), adapterPath,
        sessionDir: dir, dataDir: path.join(dir, "data"), ports,
        ...(Object.keys(proxyPorts).length ? { bindPorts, proxyPorts } : {}),
        ...(args.includes("--no-outbound") ? { outbound: "deny" as const } : {}),
        urls: {}, processes: [], state: "starting", ownerPid: process.pid, ownerBirth,
        createdAt: new Date().toISOString(),
      }), async (receipts) => {
        const matches = await matchingSessions(receipts, projectRoot, fixture);
        if (choice.replaceId && !matches.some((item) => item.id === choice.replaceId)) {
          throw new Error(`Cannot replace ${choice.replaceId}: no healthy matching session for this checkout and fixture`);
        }
        if (!matches.length || choice.parallel) return;
        if (!choice.replace) throw new DuplicateSessionError(matches);
        const selected = choice.replaceId
          ? matches.find((item) => item.id === choice.replaceId)
          : matches.length === 1 ? matches[0] : undefined;
        if (!selected) throw new DuplicateSessionError(matches);
        if (selected.state !== "ready") {
          throw new Error(`Session ${selected.id} is still ${selected.state}; wait for it to settle before replacing it`);
        }
        // beforeAllocate already holds the allocation lock.
        const stopping = await markStopping(selected.id);
        if (stopping) await stopReceipt(stopping);
      }, Object.keys(proxyPorts));
      break;
    } catch (error) {
      if (!(error instanceof DuplicateSessionError) || !process.stdin.isTTY || choice.parallel || choice.replace) throw error;
      choice = await askAboutDuplicates(error.matches);
    }
  }
  try {
    const context = {
      id: receipt.id, fixture, projectRoot,
      sessionDir: receipt.sessionDir, dataDir: receipt.dataDir, ports: receipt.ports,
      bindPorts: receipt.bindPorts ?? receipt.ports,
    };
    receipt.cleanupPaths = adapter.cleanupPaths?.(context) ?? [];
    validateCleanupPaths(receipt.cleanupPaths, receipt.id, projectRoot);
    await writeReceipt(receipt);
    // The fault proxy starts first and holds the public ports of proxied names for the whole boot.
    const proxy = proxyLaunch(receipt);
    if (proxy) await launch(receipt, proxy.spec, { ports: proxy.ports, role: proxy.role });
    const plan = await adapter.createSession(context);
    if ("cleanupPaths" in plan) {
      throw new Error("Adapter cleanupPaths must be declared before createSession");
    }
    if (!plan.services?.length) throw new Error("Adapter did not define any services");
    if (new Set(plan.services.map((item) => item.name)).size !== plan.services.length) {
      throw new Error("Service names must be unique");
    }
    for (const service of plan.services) checkServiceName(service.name);
    for (const service of plan.services) launchDescription(service.launchMode);
    receipt.urls = plan.urls ?? {};
    receipt.credentialsFile = plan.credentialsFile;
    // Kept (0600, never shown by status) so fault --mode kill can restart a service.
    receipt.services = plan.services;
    await writeReceipt(receipt);
    for (const service of plan.services) await launch(receipt, service, { ports: context.bindPorts, outbound: receipt.outbound });
    if (plan.seed) {
      await ensureStarting(receipt.id);
      const { owned, child, exitFile } = await spawnSeed(plan.seed, projectRoot, receipt.sessionDir, receipt.outbound);
      receipt.processes.push(owned);
      await writeReceipt(receipt);
      await waitForSeed(child, exitFile, plan.seed.timeoutMs, () => ensureStarting(receipt.id));
      if (!(await stopService(owned))) throw new Error("Could not verify ownership of the seed group during cleanup");
      receipt.processes = receipt.processes.filter((item) => item.pid !== owned.pid);
      await writeReceipt(receipt);
    }
    await ensureStarting(receipt.id);
    receipt.state = "ready";
    await writeReceipt(receipt);
    await ensureState(receipt.id, "ready");
    console.log(JSON.stringify(await publicReceipt(receipt), null, 2));
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    for (const owned of [...receipt.processes].reverse()) await stopService(owned);
    await cleanupPaths(receipt);
    if (error instanceof StartupStoppedError) throw error;
    try {
      const latest = await readReceipt(receipt.id);
      if (latest.state === "stopping") throw new StartupStoppedError(receipt.id);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === "ENOENT") throw new StartupStoppedError(receipt.id);
      throw readError;
    }
    receipt.state = "failed";
    try { await writeReceipt(receipt); }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code === "ENOENT") throw new StartupStoppedError(receipt.id);
      throw writeError;
    }
    throw new Error(`Session ${receipt.id} failed: ${receipt.error}. Logs: ${receipt.sessionDir}`);
  }
}

/** Start one long-running process for startup: record it before waiting, so stop can always find it. */
async function launch(receipt: SessionReceipt, spec: ServiceSpec,
  options: Omit<Parameters<typeof launchService>[1], "root" | "sessionDir">): Promise<void> {
  await ensureStarting(receipt.id);
  const launched = await launchService(spec, { root: receipt.projectRoot, sessionDir: receipt.sessionDir, ...options });
  receipt.processes.push(launched.owned);
  await writeReceipt(receipt);
  await launched.ready(() => ensureStarting(receipt.id));
}

function adapterProxyPorts(adapter: ProjectAdapter, adapterPath: string): Record<string, ProxyUnit> {
  const declared = adapter.proxyPorts ?? {};
  if (typeof declared !== "object" || Array.isArray(declared)) throw new Error(`Invalid adapter proxyPorts: ${adapterPath}`);
  for (const [name, unit] of Object.entries(declared)) {
    if (!adapter.ports.includes(name)) throw new Error(`Adapter proxyPorts names unknown port ${name}; declare it in ports too`);
    if (unit !== "http" && unit !== "tcp") throw new Error(`Adapter proxyPorts.${name} must be "http" or "tcp"`);
  }
  return declared;
}

async function status(id?: string): Promise<void> {
  if (id) {
    let receipt: SessionReceipt;
    try { receipt = await readReceipt(id); }
    catch (error) {
      // stop removes the session, so a stopped or unknown ID is reported, not thrown (like stop's alreadyGone).
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      console.log(JSON.stringify([{ id, state: "gone" }], null, 2));
      return;
    }
    console.log(JSON.stringify([await publicReceipt(receipt)], null, 2));
    return;
  }
  console.log(JSON.stringify(await Promise.all((await listReceipts()).map(publicReceipt)), null, 2));
}

async function stop(id?: string): Promise<void> {
  if (!id) usage();
  const receipt = await withStateLock(() => markStopping(id));
  if (!receipt) {
    console.log(JSON.stringify({ id, stopped: true, alreadyGone: true }));
    return;
  }
  await stopReceipt(receipt);
  console.log(JSON.stringify({ id, stopped: true }));
}

function wholeNumber(args: string[], name: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = option(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > max) {
    throw new Error(name === "--ms" ? "--ms must be a whole number from 1 to 600000" : `${name} must be a positive whole number`);
  }
  return value;
}

async function fault(args: string[]): Promise<void> {
  const [id, second] = args;
  if (!id || id.startsWith("--")) usage();
  const portName = second && !second.startsWith("--") ? second : undefined;
  const mode = option(args, "--mode");
  const release = args.includes("--release");
  const clear = args.includes("--clear");
  if ([Boolean(mode), release, clear].filter(Boolean).length !== 1) throw new Error("Choose one of --mode, --release or --clear");
  const ms = wholeNumber(args, "--ms", 600_000);
  const count = wholeNumber(args, "--count");
  if (clear) {
    if (count !== undefined || ms !== undefined) throw new Error("--clear takes no --ms or --count");
    console.log(JSON.stringify({ id, cleared: await clearFaults(id, portName) }, null, 2));
    return;
  }
  if (release) {
    if (!portName) throw new Error("Name the port whose held requests to release, e.g. localdev fault <id> api --release");
    if (ms !== undefined) throw new Error("--ms applies only to --mode slow");
    console.log(JSON.stringify({ id, ...(await releaseHeld(id, portName, count)) }, null, 2));
    return;
  }
  if (!portName) throw new Error("Name the port to fault, e.g. localdev fault <id> dataconnect --mode pause");
  if (!isFaultMode(mode!)) throw new Error(`Unsupported fault mode ${mode}; supported: ${faultModes.join(", ")}`);
  if (mode === "slow" && ms === undefined) throw new Error("--mode slow needs --ms <milliseconds>, e.g. --ms 3000");
  if (mode !== "slow" && ms !== undefined) throw new Error("--ms applies only to --mode slow");
  if ((mode === "pause" || mode === "kill") && count !== undefined) {
    throw new Error("--count applies to fail, slow and hold, which count requests through the fault proxy; pause and kill act on the process at once");
  }
  const request: FaultRequest = mode === "slow" ? { mode, port: portName, ms: ms!, count }
    : mode === "fail" || mode === "hold" ? { mode, port: portName, count } : { mode, port: portName };
  console.log(JSON.stringify({ id, fault: await applyFault(id, request) }, null, 2));
}

/**
 * The first step of stop, called with the allocation lock held: re-read the receipt so faults recorded since any
 * earlier read are resumed too, then mark it stopping so no new fault can start. Null when the session is gone.
 */
async function markStopping(id: string): Promise<SessionReceipt | null> {
  let receipt: SessionReceipt;
  try { receipt = await readReceipt(id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  receipt.state = "stopping";
  resumeAllFaults(receipt);
  await writeReceipt(receipt);
  return receipt;
}

/** Stop a receipt markStopping returned; runs outside the lock because service shutdown can take seconds. */
async function stopReceipt(receipt: SessionReceipt): Promise<void> {
  const id = receipt.id;
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
  else if (command === "fault") await fault(args);
  else if (command === "issue") await issueCommand(args);
  else usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
