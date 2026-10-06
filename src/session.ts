import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { checkCleanupPaths, checkPlan, launchDescription, loadAdapter } from "./adapter.js";
import { gitCommit, projectRoot } from "./checkout.js";
import { activeFaults, resumeAllFaults } from "./fault.js";
import { launchService } from "./launch.js";
import { outboundRefusals, refusalExplanation, type OutboundPolicy } from "./outbound.js";
import { assertProcessRuntime, birthOf, isSameProcess } from "./process-table.js";
import { countUnit, proxyLaunch } from "./proxy.js";
import {
  bindPortsOf, findReceipt, isSessionId, reserveSession, SessionGoneError, sessionPath, updateLockedReceipt, updateReceipt,
} from "./state.js";
import { processAlive, processHealth, spawnSupervised, stopService, waitForSeed } from "./supervised.js";
import type { OwnedProcess, ServiceSpec, SessionReceipt } from "./types.js";

// The session lifecycle: startup (duplicate matching, reservation, launch, seed, ready), status's view and stop.

interface StartupChoice {
  parallel: boolean;
  replace: boolean;
  replaceId?: string;
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

type ProcessHealth = Awaited<ReturnType<typeof processHealth>>;

/**
 * The one health verdict, so duplicate matching and status cannot drift. A process is alive when its group is owned
 * and running and none of its ports is unreachable or held by another process. A ready session with a port that is
 * unreachable or not owned is degraded; one is healthy when it has processes and every one is alive.
 */
export async function sessionHealth(receipt: SessionReceipt): Promise<{
  processes: Array<{ record: OwnedProcess; groupOwned: boolean; alive: boolean; health: ProcessHealth }>;
  healthy: boolean;
  degraded: boolean;
}> {
  const processes = await Promise.all(receipt.processes.map(async (record) => {
    const groupOwned = processAlive(record);
    const health = await processHealth(record);
    return { record, groupOwned, alive: groupOwned && health.listenerOwned !== false && health.reachable !== false, health };
  }));
  return {
    processes,
    healthy: processes.length > 0 && processes.every((item) => item.alive),
    degraded: receipt.state === "ready" && processes.some(({ health }) => health.reachable === false || health.listenerOwned === false),
  };
}

async function matchingSessions(receipts: SessionReceipt[], root: string, fixture: string): Promise<SessionReceipt[]> {
  const candidates = receipts.filter((item) => item.fixture === fixture);
  const matches = await Promise.all(candidates.map(async (item) => {
    if (await projectRoot(item.projectRoot) !== root) return null;
    if (item.state === "starting") {
      return isSameProcess(item.ownerPid, item.ownerBirth) ? item : null;
    }
    if (item.state !== "ready" && item.state !== "stopping" && item.state !== "failed") return null;
    return (await sessionHealth(item)).healthy ? item : null;
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
    const selected = answer.startsWith("replace ") ? answer.slice("replace ".length) : undefined;
    if (selected && isSessionId(selected) && matches.some((item) => item.id === selected)) {
      return { parallel: false, replace: true, replaceId: selected };
    }
    throw new Error("Startup cancelled; existing sessions were left running");
  } finally {
    reader.close();
  }
}

async function cleanupPaths(receipt: SessionReceipt): Promise<void> {
  checkCleanupPaths(receipt.cleanupPaths ?? [], receipt.id, receipt.projectRoot);
  for (const item of receipt.cleanupPaths ?? []) await fs.rm(item, { recursive: true, force: true });
}

class StartupStoppedError extends Error {
  constructor(id: string) { super(`Session ${id} was stopped during startup`); }
}

/** A separate stop command may cancel startup while a service or seed is waiting. */
async function ensureState(id: string, state: SessionReceipt["state"]): Promise<void> {
  if ((await findReceipt(id))?.state !== state) throw new StartupStoppedError(id);
}

function ensureStarting(id: string): Promise<void> { return ensureState(id, "starting"); }

/**
 * Record startup's own fields (cleanup paths, plan, processes) while the session is still starting. Under the
 * state lock with a fresh read, so a concurrent stop's "stopping" is never overwritten: startup ends instead.
 */
async function saveStarting(receipt: SessionReceipt): Promise<void> {
  await updateReceipt(receipt.id, (stored) => {
    if (stored.state !== "starting") throw new StartupStoppedError(receipt.id);
    Object.assign(stored, startupFields(receipt));
  }).catch(stoppedIfGone(receipt.id));
}

/** The fields startup fills in after reservation; the rest of a stored receipt (its state, faults) is not startup's. */
function startupFields({ cleanupPaths, urls, credentialsFile, services, processes }: SessionReceipt): Partial<SessionReceipt> {
  return { cleanupPaths, urls, credentialsFile, services, processes };
}

function stoppedIfGone(id: string): (error: unknown) => never {
  return (error) => { throw error instanceof SessionGoneError ? new StartupStoppedError(id) : error; };
}

export interface StartOptions {
  fixture?: string;
  /** Project checkout; defaults to the current directory. */
  project?: string;
  /** Adapter file; defaults to <project>/local.adapter.mjs. */
  adapter?: string;
  /** --replace: true for "the one match", or a session ID. */
  replace?: true | string;
  parallel?: boolean;
  outbound?: OutboundPolicy;
}

/** `localdev startup`: start a session and return its status view, or throw once everything it started is stopped. */
export async function startSession(options: StartOptions): Promise<object> {
  assertProcessRuntime();
  const root = await projectRoot(options.project ?? process.cwd(), { mustExist: true });
  const adapterPath = path.resolve(options.adapter ?? path.join(root, "local.adapter.mjs"));
  const { adapter, proxyPorts } = await loadAdapter(adapterPath);
  const fixture = options.fixture ?? adapter.defaultFixture;
  if (!fixture || typeof fixture !== "string" || !fixture.trim()) {
    throw new Error(`No fixture named. Set defaultFixture in ${adapterPath} or run localdev startup <fixture>`);
  }
  const ownerBirth = birthOf(process.pid);
  if (!ownerBirth) throw new Error("Could not verify startup process identity");
  const parallel = Boolean(options.parallel);
  if (parallel && options.replace) throw new Error("Choose either --replace or --parallel");
  const replaceId = typeof options.replace === "string" ? options.replace : undefined;
  if (replaceId && !isSessionId(replaceId)) throw new Error(`Invalid --replace session ID: ${replaceId}`);
  let choice: StartupChoice = { parallel, replace: Boolean(options.replace), replaceId };
  let receipt: SessionReceipt;
  for (;;) {
    try {
      receipt = await reserveSession(adapter.ports, (id, dir, ports, bindPorts) => ({
        id, fixture, projectRoot: root, commit: gitCommit(root), adapterPath,
        sessionDir: dir, dataDir: path.join(dir, "data"), ports,
        ...(Object.keys(proxyPorts).length ? { bindPorts, proxyPorts } : {}),
        ...(options.outbound ? { outbound: options.outbound } : {}),
        urls: {}, processes: [], state: "starting", ownerPid: process.pid, ownerBirth,
        createdAt: new Date().toISOString(),
      }), async (receipts) => {
        const matches = await matchingSessions(receipts, root, fixture);
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
        // beforeAllocate already holds the allocation lock, so the locked variants.
        const stopping = await updateLockedReceipt(selected.id, markStopping).catch(nullIfGone);
        if (stopping) await stopReceipt(stopping, { lockHeld: true });
      }, Object.keys(proxyPorts));
      break;
    } catch (error) {
      if (!(error instanceof DuplicateSessionError) || !process.stdin.isTTY || choice.parallel || choice.replace) throw error;
      choice = await askAboutDuplicates(error.matches);
    }
  }
  try {
    const context = {
      id: receipt.id, fixture, projectRoot: root,
      sessionDir: receipt.sessionDir, dataDir: receipt.dataDir, ports: receipt.ports, bindPorts: bindPortsOf(receipt),
    };
    receipt.cleanupPaths = adapter.cleanupPaths?.(context) ?? [];
    checkCleanupPaths(receipt.cleanupPaths, receipt.id, root);
    await saveStarting(receipt);
    // The fault proxy starts first and holds the public ports of proxied names for the whole boot.
    const proxy = proxyLaunch(receipt);
    if (proxy) await launch(receipt, proxy.spec, { ports: proxy.ports, role: proxy.role });
    const plan = await adapter.createSession(context);
    checkPlan(plan);
    receipt.urls = plan.urls ?? {};
    receipt.credentialsFile = plan.credentialsFile;
    // Kept (0600, never shown by status) so fault --mode kill can restart a service.
    receipt.services = plan.services;
    await saveStarting(receipt);
    for (const service of plan.services) await launch(receipt, service, { ports: context.bindPorts, outbound: receipt.outbound });
    if (plan.seed) {
      await ensureStarting(receipt.id);
      const { owned, child, exitFile } = await spawnSupervised("seed", plan.seed, root, receipt.sessionDir, receipt.outbound);
      receipt.processes.push(owned);
      await saveStarting(receipt);
      await waitForSeed(child, exitFile, plan.seed.timeoutMs, () => ensureStarting(receipt.id));
      if (!(await stopService(owned))) throw new Error("Could not verify ownership of the seed group during cleanup");
      receipt.processes = receipt.processes.filter((item) => item.pid !== owned.pid);
      await saveStarting(receipt);
    }
    // Read, check and commit under the lock stop's markStopping takes: ready only if nothing stopped it meanwhile.
    // It also saves startup's last field changes (escaped groups found by the last readiness wait).
    await updateReceipt(receipt.id, (stored) => {
      if (stored.state !== "starting") throw new StartupStoppedError(receipt.id);
      Object.assign(stored, startupFields(receipt), { state: "ready" });
    }).catch(stoppedIfGone(receipt.id));
    receipt.state = "ready";
    await ensureState(receipt.id, "ready");
    return await describeSession(receipt);
  } catch (error) {
    receipt.error = (error instanceof Error ? error.message : String(error)) +
      (receipt.outbound === "deny" ? refusalExplanation(outboundRefusals(receipt.sessionDir)) : "");
    for (const owned of [...receipt.processes].reverse()) await stopService(owned);
    await cleanupPaths(receipt);
    if (error instanceof StartupStoppedError) throw error;
    await updateReceipt(receipt.id, (stored) => {
      if (stored.state === "stopping") throw new StartupStoppedError(receipt.id);
      Object.assign(stored, startupFields(receipt), { error: receipt.error, state: "failed" });
    }).catch(stoppedIfGone(receipt.id));
    throw new Error(`Session ${receipt.id} failed: ${receipt.error}. Logs: ${receipt.sessionDir}`);
  }
}

/** Start one long-running process for startup: record it before waiting, so stop can always find it. */
async function launch(receipt: SessionReceipt, spec: ServiceSpec,
  options: Omit<Parameters<typeof launchService>[1], "root" | "sessionDir">): Promise<void> {
  await ensureStarting(receipt.id);
  const launched = await launchService(spec, { root: receipt.projectRoot, sessionDir: receipt.sessionDir, ...options });
  receipt.processes.push(launched.owned);
  await saveStarting(receipt);
  await launched.ready(() => ensureStarting(receipt.id));
  // Readiness records escaped groups in memory; save them now, so a stop before the next write still finds them.
  await saveStarting(receipt);
}

/** A session as status and startup show it: never the service specs, env or credentials themselves. */
export async function describeSession(receipt: SessionReceipt): Promise<object> {
  const health = await sessionHealth(receipt);
  const processes = health.processes.map(({ record, groupOwned, alive, health }) => ({
    name: record.name,
    ...(record.role ? { role: record.role } : {}),
    launchMode: record.launchMode ?? null,
    launch: launchDescription(record.launchMode),
    pid: record.pid,
    guardPid: record.guardPid,
    birth: record.birth,
    groupOwned,
    alive,
    ...health,
  }));
  const { faults, proxy } = await activeFaults(receipt);
  return {
    id: receipt.id,
    state: health.degraded ? "degraded" : receipt.state,
    fixture: receipt.fixture,
    checkout: receipt.projectRoot,
    commit: receipt.commit,
    ports: receipt.ports,
    proxiedPorts: Object.fromEntries(Object.entries(receipt.proxyPorts ?? {})
      .map(([name, unit]) => [name, countUnit(unit)])),
    outbound: receipt.outbound === "deny" ? "blocked" : "allowed",
    ...(receipt.outbound === "deny" ? { outboundRefused: outboundRefusals(receipt.sessionDir).length } : {}),
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

/** `localdev stop`: stop one session; a stopped or unknown ID is reported as already gone. */
export async function stopSession(id: string): Promise<{ id: string; stopped: true; alreadyGone?: true }> {
  const receipt = await updateReceipt(id, markStopping).catch(nullIfGone);
  if (!receipt) return { id, stopped: true, alreadyGone: true };
  await stopReceipt(receipt);
  return { id, stopped: true };
}

function nullIfGone(error: unknown): null {
  if (error instanceof SessionGoneError) return null;
  throw error;
}

/**
 * The first step of stop, run on a fresh read under the state lock (updateReceipt): resume the faults recorded so
 * far, then mark it stopping so no new fault can start. Returns the receipt to stop.
 */
function markStopping(receipt: SessionReceipt): SessionReceipt {
  receipt.state = "stopping";
  resumeAllFaults(receipt);
  return receipt;
}

/**
 * Stop a receipt markStopping returned; runs outside the lock because service shutdown can take seconds, except for
 * startup --replace, which already holds it (lockHeld).
 */
async function stopReceipt(receipt: SessionReceipt, { lockHeld = false } = {}): Promise<void> {
  const id = receipt.id;
  for (const owned of [...receipt.processes].reverse()) {
    if (!(await stopService(owned))) {
      const error = `Could not verify ownership of ${owned.name} process group`;
      await (lockHeld ? updateLockedReceipt : updateReceipt)(id, (stored) => {
        stored.error = error;
        stored.state = "failed";
      });
      throw new Error(`${error}; session ${id} was kept for inspection`);
    }
  }
  await cleanupPaths(receipt);
  await fs.rm(sessionPath(id), { recursive: true, force: true });
}
