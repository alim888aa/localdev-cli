import { launchService } from "./launch.js";
import { birthOf, listenerPids, ownedListenerProcesses, signalProcess, stopService } from "./process.js";
import { controlProxy, type ProxyMode, type ProxyPortState } from "./proxy.js";
import { readReceipt, withStateLock, writeReceipt } from "./state.js";
import type { FaultRecord, KillFault, OwnedProcess, PauseFault, ProcessIdentity, SessionReceipt } from "./types.js";

// Faults have two homes. Those that change the session's processes (pause, and kill while it restarts) are recorded
// in the receipt, so stop and --clear can always undo or see them. Proxy faults (fail, slow, hold) exist only in
// the session's fault proxy, which owns their live counts and held requests; stopping the proxy undoes them.

export const faultModes = ["pause", "fail", "slow", "hold", "kill"] as const;
export type FaultMode = typeof faultModes[number];

export function isFaultMode(mode: string): mode is FaultMode {
  return (faultModes as readonly string[]).includes(mode);
}

export type FaultRequest =
  | { mode: "pause"; port: string }
  | { mode: "kill"; port: string }
  | { mode: "fail" | "hold"; port: string; count?: number }
  | { mode: "slow"; port: string; ms: number; count?: number };

/** A fault as status and the fault command show it. `unit` says what a count counts, or that it acts on processes. */
export type FaultView =
  | (PauseFault & { unit: "process" })
  | { port: string; mode: "kill"; unit: "process"; service: string; state: "restarting" | "interrupted"; since: string }
  | { port: string; mode: ProxyMode; unit: "request" | "connection"; ms?: number; remaining: number | null; held: number; since?: string };

type ClearedFault =
  | (PauseFault & { resumed: number[] })
  | { port: string; mode: "kill"; service: string }
  | { port: string; mode: ProxyMode; unit: "request" | "connection"; released: number };

function portNumber(receipt: SessionReceipt, portName: string): number {
  const port = receipt.ports[portName];
  if (!port) throw new Error(`Unknown port ${portName} in session ${receipt.id}; its ports are ${Object.keys(receipt.ports).join(", ")}`);
  return port;
}

/** The port the service behind portName listens on: its bind port when proxied. */
function bindPort(receipt: SessionReceipt, portName: string): number {
  return receipt.bindPorts?.[portName] ?? portNumber(receipt, portName);
}

async function readSession(id: string): Promise<SessionReceipt> {
  try { return await readReceipt(id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`No session ${id}; it is unknown or already stopped`);
    throw error;
  }
}

const proxyRecord = (receipt: SessionReceipt): OwnedProcess | undefined => receipt.processes.find((item) => item.role === "proxy");

function ownerAlive(fault: KillFault): boolean {
  return birthOf(fault.owner.pid) === fault.owner.birth;
}

function viewOf(fault: FaultRecord): FaultView {
  if (fault.mode === "pause") return { ...fault, unit: "process" };
  return { port: fault.port, mode: "kill", unit: "process", service: fault.service,
    state: ownerAlive(fault) ? "restarting" : "interrupted", since: fault.since };
}

/** A proxied port's state as a fault, or null while it passes traffic. A finished hold with requests still parked stays a hold fault. */
function proxyView(state: ProxyPortState): FaultView | null {
  if (state.mode === "pass" && !state.held) return null;
  const { port, unit, ms, remaining, held, since } = state;
  return { port, mode: state.mode === "pass" ? "hold" : state.mode, unit, ...(ms === undefined ? {} : { ms }),
    remaining: state.mode === "pass" ? 0 : remaining, held, ...(since ? { since } : {}) };
}

async function proxyStates(receipt: SessionReceipt, timeoutMs?: number): Promise<ProxyPortState[]> {
  if (!proxyRecord(receipt)) return [];
  const reply = await controlProxy(receipt, { op: "state" }, timeoutMs);
  if (!reply.ok) throw new Error(reply.error);
  return reply.ports;
}

/**
 * Every active fault, for status. The proxy is asked only when the session has one; when it cannot be reached its
 * faults are unknown, so status reports the proxy as unreachable instead of listing them.
 */
export async function activeFaults(receipt: SessionReceipt): Promise<{ faults: FaultView[]; proxy?: "unreachable" }> {
  const recorded = (receipt.faults ?? []).map(viewOf);
  try {
    const proxied = (await proxyStates(receipt, 1_000)).map(proxyView).filter((item): item is FaultView => item !== null);
    return { faults: [...recorded, ...proxied] };
  } catch {
    return { faults: recorded, proxy: "unreachable" };
  }
}

/** The session is ready and the port has no fault yet, in the receipt or in the proxy. */
async function ensureFaultable(receipt: SessionReceipt, portName: string): Promise<void> {
  if (receipt.state !== "ready") throw new Error(`Session ${receipt.id} is ${receipt.state}; faults need a ready session`);
  portNumber(receipt, portName);
  const recorded = (receipt.faults ?? []).find((item) => item.port === portName);
  if (recorded?.mode === "pause") {
    throw new Error(`Port ${portName} is already paused in session ${receipt.id}; run localdev fault ${receipt.id} ${portName} --clear first`);
  }
  if (recorded?.mode === "kill") {
    throw new Error(ownerAlive(recorded)
      ? `Service ${recorded.service} is restarting after a kill on ${portName}; wait for it to finish`
      : `An earlier kill of ${recorded.service} on ${portName} was interrupted; run localdev fault ${receipt.id} ${portName} --clear, then retry`);
  }
  if (!receipt.proxyPorts?.[portName]) return;
  const active = proxyView((await proxyStates(receipt)).find((item) => item.port === portName)!);
  if (active) throw busy(receipt, active);
}

function busy(receipt: SessionReceipt, active: FaultView): Error {
  if (active.mode === "hold" && active.remaining === 0) {
    return new Error(`Port ${active.port} still holds ${(active as { held: number }).held} requests from an earlier hold in session ${receipt.id}; run localdev fault ${receipt.id} ${active.port} --release or --clear first`);
  }
  return new Error(`Port ${active.port} already has an active ${active.mode} fault in session ${receipt.id}; run localdev fault ${receipt.id} ${active.port} --clear first`);
}

/** Listeners on the port owned by any of the session's services (never the proxy), once each. */
function sessionListeners(receipt: SessionReceipt, port: number): ProcessIdentity[] {
  const found = new Map<number, ProcessIdentity>();
  for (const record of receipt.processes) {
    if (record.role === "proxy") continue;
    for (const member of ownedListenerProcesses(record, port)) found.set(member.pid, member);
  }
  return [...found.values()];
}

/** One process can serve several ports (e.g. a Firebase emulator hub); pausing it freezes all of them. */
function sharedPorts(receipt: SessionReceipt, portName: string, pids: ProcessIdentity[]): string[] {
  return Object.keys(receipt.ports)
    .filter((name) => name !== portName && listenerPids(bindPort(receipt, name)).some((pid) => pids.some((member) => member.pid === pid)))
    .sort();
}

/**
 * Freeze the session's own listener processes on one port with SIGSTOP. Clients can still connect (the kernel
 * accepts into the backlog) but get no response, like a hung service, and the service keeps its state.
 * Other services keep running because only the listener processes are signalled, not the session group. On a
 * proxied port the service behind the proxy is paused, never the proxy, which serves every proxied port.
 */
async function pauseService(receipt: SessionReceipt, portName: string): Promise<PauseFault> {
  await ensureFaultable(receipt, portName);
  const port = bindPort(receipt, portName);
  const faults = receipt.faults ?? [];
  const pids = sessionListeners(receipt, port);
  if (!pids.length) throw new Error(`No listener owned by session ${receipt.id} on ${portName} (port ${port}); nothing was paused`);
  // Clearing one fault must not resume a process another fault still expects to be paused.
  const overlap = faults.find((item) => item.mode === "pause" && item.pids.some((member) => pids.some((other) => other.pid === member.pid)));
  if (overlap) throw new Error(`The process listening on ${portName} is already paused by the ${overlap.port} fault`);
  const fault: PauseFault = {
    port: portName, mode: "pause", pids, sharedPorts: sharedPorts(receipt, portName, pids), since: new Date().toISOString(),
  };
  receipt.faults = [...faults, fault];
  // Record before signalling, so stop and --clear can always find a process this command froze.
  await writeReceipt(receipt);
  const paused = pids.filter((member) => signalProcess(member, "SIGSTOP") === "signalled");
  if (paused.length !== pids.length) {
    receipt.faults = paused.length ? [...faults, { ...fault, pids: paused }] : faults;
    await writeReceipt(receipt);
    if (!paused.length) throw new Error(`The listener on ${portName} exited before it could be paused`);
  }
  return { ...fault, pids: paused };
}

async function setProxyFault(receipt: SessionReceipt, request: Exclude<FaultRequest, { mode: "pause" | "kill" }>): Promise<FaultView> {
  await ensureFaultable(receipt, request.port);
  if (!receipt.proxyPorts?.[request.port]) {
    throw new Error(`Port ${request.port} is not proxied in session ${receipt.id}, so fail, slow and hold are unavailable on it; ` +
      "pause and kill work on any port. Adapters opt ports in with proxyPorts (docs/adapter.md).");
  }
  const reply = await controlProxy(receipt, { op: "set", ...request });
  if (!reply.ok) throw reply.port ? busy(receipt, proxyView(reply.port)!) : new Error(reply.error);
  return proxyView(reply.ports[0])!;
}

export type KillResult = { port: string; mode: "kill"; service: string; sharedPorts: string[]; oldPid: number; pid: number };

/**
 * Kill the service listening on a port at once (SIGKILL, like a crash), then start it again from its recorded spec
 * and wait until it is ready. State in its data directory survives; in-memory state does not. The state lock is held
 * only to record each step, never through the kill or the readiness wait, so stop can always interrupt a restart.
 */
async function killService(id: string, portName: string): Promise<KillResult> {
  const birth = birthOf(process.pid);
  if (!birth) throw new Error("Could not verify the fault command's own process identity");
  const prepared = await withStateLock(async () => {
    const receipt = await readSession(id);
    await ensureFaultable(receipt, portName);
    if (!receipt.services) {
      throw new Error(`Session ${id} was started by an older localdev without restart data; run localdev startup --replace ${id}, then retry`);
    }
    const port = bindPort(receipt, portName);
    const record = receipt.processes.find((item) => item.role !== "proxy" && ownedListenerProcesses(item, port).length);
    if (!record) throw new Error(`No listener owned by session ${id} on ${portName} (port ${port}); nothing was killed`);
    const faults = receipt.faults ?? [];
    const paused = faults.find((item) => item.mode === "pause" && ownedListenerProcesses(record, bindPort(receipt, item.port)).length);
    if (paused) throw new Error(`Service ${record.name} is paused by the ${paused.port} fault; clear it before kill`);
    const restarting = faults.find((item) => item.mode === "kill" && item.service === record.name);
    if (restarting) throw new Error(`Service ${record.name} is already restarting`);
    const spec = receipt.services.find((item) => item.name === record.name);
    if (!spec) throw new Error(`Session ${id} has no restart spec for ${record.name}`);
    const fault: KillFault = { port: portName, mode: "kill", service: record.name, owner: { pid: process.pid, birth }, since: new Date().toISOString() };
    receipt.faults = [...faults, fault];
    await writeReceipt(receipt);
    return { record, spec, fault };
  });
  const { record, spec, fault } = prepared;
  const isThisKill = (item: FaultRecord) => item.mode === "kill" && item.since === fault.since && item.owner.pid === fault.owner.pid;
  const dropKill = (owned?: OwnedProcess) => withStateLock(async () => {
    let receipt: SessionReceipt;
    try { receipt = await readReceipt(id); } catch { return; } // Stopped meanwhile: nothing left to record.
    receipt.faults = (receipt.faults ?? []).filter((item) => !isThisKill(item));
    const current = owned && receipt.processes.find((item) => item.pid === owned.pid && item.birth === owned.birth);
    if (current) current.escapedGroups = owned.escapedGroups;
    await writeReceipt(receipt);
  });
  if (!(await stopService(record, { hard: true }))) {
    await dropKill();
    throw new Error(`Could not verify ownership of the ${record.name} process group; nothing was restarted`);
  }
  const launched = await withStateLock(async () => {
    let receipt: SessionReceipt;
    try { receipt = await readReceipt(id); }
    catch { throw new Error(`Session ${id} was stopped during the kill; ${record.name} was not restarted`); }
    if (receipt.state !== "ready" || !(receipt.faults ?? []).some(isThisKill)) {
      throw new Error(`Session ${id} was stopped during the kill; ${record.name} was not restarted`);
    }
    const started = await launchService(spec, { root: receipt.projectRoot, sessionDir: receipt.sessionDir, ports: receipt.bindPorts ?? receipt.ports });
    const index = receipt.processes.findIndex((item) => item.pid === record.pid && item.birth === record.birth);
    if (index < 0) receipt.processes.push(started.owned);
    else receipt.processes[index] = started.owned;
    // Recorded before the readiness wait, so a stop meanwhile stops the new process too.
    await writeReceipt(receipt);
    return started;
  });
  try {
    await launched.ready(async () => {
      const receipt = await readReceipt(id).catch(() => null);
      if (receipt?.state !== "ready" || !(receipt.faults ?? []).some(isThisKill)) {
        throw new Error(`Session ${id} was stopped while ${record.name} restarted`);
      }
    });
  } catch (error) {
    await dropKill();
    throw new Error(`${record.name} did not come back after the kill: ${error instanceof Error ? error.message : String(error)}; log: ${launched.owned.log}`);
  }
  await dropKill(launched.owned);
  return {
    port: portName, mode: "kill", service: record.name,
    sharedPorts: (record.readyChecks ?? []).map((check) => check.name).filter((name) => name !== portName),
    oldPid: record.pid, pid: launched.owned.pid,
  };
}

/** Start one fault. Every mode goes through here; `localdev fault` only parses its flags. */
export async function applyFault(id: string, request: FaultRequest): Promise<FaultView | KillResult> {
  if (request.mode === "kill") return killService(id, request.port);
  // Read, check and change under the lock, so a concurrent fault or stop cannot drop this fault's record.
  if (request.mode === "pause") {
    const { port } = request;
    return withStateLock(async () => viewOf(await pauseService(await readSession(id), port)));
  }
  const proxied = request;
  return withStateLock(async () => setProxyFault(await readSession(id), proxied));
}

/** Let held requests on a port through, oldest first: `count` of them, or all. */
export async function releaseHeld(id: string, portName: string, count?: number): Promise<{ port: string; released: number; held: number }> {
  return withStateLock(async () => {
    const receipt = await readSession(id);
    portNumber(receipt, portName);
    if (!receipt.proxyPorts?.[portName]) throw new Error(`Port ${portName} has no hold fault in session ${id}; it is not proxied`);
    const reply = await controlProxy(receipt, { op: "release", port: portName, count });
    if (!reply.ok) throw new Error(reply.error);
    const [state] = reply.ports;
    if (!reply.released && state.mode !== "hold") throw new Error(`Port ${portName} has no hold fault in session ${id}`);
    return { port: portName, released: reply.released ?? 0, held: state.held };
  });
}

/**
 * Continue the recorded processes. A PID confirmed exited or reused needs nothing more; one that could not be
 * signalled may still be paused, so it stays unresolved and keeps its fault record for a later --clear or stop.
 */
function resume(fault: PauseFault): { resumed: number[]; unresolved: ProcessIdentity[] } {
  const resumed: number[] = [];
  const unresolved: ProcessIdentity[] = [];
  for (const member of fault.pids) {
    const outcome = signalProcess(member, "SIGCONT");
    if (outcome === "signalled") resumed.push(member.pid);
    else if (outcome === "failed") unresolved.push(member);
  }
  return { resumed, unresolved };
}

/** Faults reduced to their unresolved members; a fault with none left is dropped. */
function remainingFaults(faults: FaultRecord[], results: Map<FaultRecord, ProcessIdentity[]>): FaultRecord[] {
  return faults.flatMap((fault) => {
    const unresolved = results.get(fault);
    if (!unresolved || fault.mode !== "pause") return [fault];
    return unresolved.length ? [{ ...fault, pids: unresolved }] : [];
  });
}

/**
 * Clear one port's faults, or every fault when no port is named. Paused processes resume before their record goes;
 * one that could not be resumed keeps its record, and the command fails after saving that, naming the PIDs. Proxy
 * faults end at once and their held requests go on in arrival order. A kill still restarting is left alone.
 */
export async function clearFaults(id: string, portName?: string): Promise<ClearedFault[]> {
  return withStateLock(async () => {
    const receipt = await readSession(id);
    if (portName) portNumber(receipt, portName);
    const faults = receipt.faults ?? [];
    const targets = portName ? faults.filter((item) => item.port === portName) : faults;
    const live = targets.find((item): item is KillFault => item.mode === "kill" && ownerAlive(item));
    if (live) throw new Error(`Service ${live.service} is restarting after a kill on ${live.port}; wait for it to finish`);
    let proxied: ProxyPortState[] = [];
    let unreachable: Error | undefined;
    if (!portName || receipt.proxyPorts?.[portName]) {
      try { proxied = (await proxyStates(receipt)).filter((item) => (!portName || item.port === portName) && proxyView(item)); }
      catch (error) { unreachable = error as Error; }
    }
    if (!targets.length && !proxied.length) {
      if (unreachable) throw unreachable;
      throw new Error(portName ? `No active fault on ${portName} in session ${id}` : `No active faults in session ${id}`);
    }
    const results = new Map<FaultRecord, ProcessIdentity[]>();
    const cleared: ClearedFault[] = targets.map((fault) => {
      if (fault.mode === "kill") { results.set(fault, []); return { port: fault.port, mode: "kill", service: fault.service }; }
      const { resumed, unresolved } = resume(fault);
      results.set(fault, unresolved);
      return { ...fault, resumed };
    });
    receipt.faults = faults.filter((fault) => !(fault.mode === "kill" && results.has(fault)));
    receipt.faults = remainingFaults(receipt.faults, results);
    await writeReceipt(receipt);
    for (const state of proxied) {
      const reply = await controlProxy(receipt, { op: "clear", port: state.port });
      if (!reply.ok) throw new Error(reply.error);
      const view = proxyView(state)!;
      cleared.push({ port: state.port, mode: view.mode as ProxyMode, unit: state.unit, released: reply.released ?? 0 });
    }
    const stuck = [...results.values()].flat().map((member) => member.pid);
    if (stuck.length) {
      throw new Error(`Could not resume ${stuck.join(", ")} in session ${id}; the fault is kept, so retry localdev fault ${id} --clear or stop`);
    }
    return cleared;
  });
}

/**
 * Stop calls this first: a paused process keeps SIGTERM pending until it is continued. Unresolved members stay
 * recorded, so a stop that cannot verify termination keeps them for inspection. The caller writes the receipt.
 * Proxy faults need nothing here: stopping the proxy ends them and drops what it held.
 */
export function resumeAllFaults(receipt: SessionReceipt): void {
  const faults = receipt.faults ?? [];
  receipt.faults = remainingFaults(faults, new Map(faults.flatMap((fault) =>
    fault.mode === "pause" ? [[fault, resume(fault).unresolved] as const] : [])));
}

