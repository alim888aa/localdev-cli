import { listenerPids, ownedListenerProcesses, signalProcess } from "./process.js";
import { writeReceipt } from "./state.js";
import type { FaultRecord, ProcessIdentity, SessionReceipt } from "./types.js";

export type FaultMode = FaultRecord["mode"];

export function isFaultMode(mode: string): mode is FaultMode {
  return mode === "pause";
}

function portNumber(receipt: SessionReceipt, portName: string): number {
  const port = receipt.ports[portName];
  if (!port) throw new Error(`Unknown port ${portName} in session ${receipt.id}; its ports are ${Object.keys(receipt.ports).join(", ")}`);
  return port;
}

/** Listeners on the port owned by any of the session's process groups, once each. */
function sessionListeners(receipt: SessionReceipt, port: number): ProcessIdentity[] {
  const found = new Map<number, ProcessIdentity>();
  for (const record of receipt.processes) {
    for (const member of ownedListenerProcesses(record, port)) found.set(member.pid, member);
  }
  return [...found.values()];
}

/** One process can serve several ports (e.g. a Firebase emulator hub); pausing it freezes all of them. */
function sharedPorts(receipt: SessionReceipt, portName: string, pids: ProcessIdentity[]): string[] {
  return Object.entries(receipt.ports)
    .filter(([name, port]) => name !== portName && listenerPids(port).some((pid) => pids.some((member) => member.pid === pid)))
    .map(([name]) => name);
}

/**
 * Freeze the session's own listener processes on one port with SIGSTOP. Clients can still connect (the kernel
 * accepts into the backlog) but get no response, like a hung service, and the service keeps its state.
 * Other services keep running because only the listener processes are signalled, not the session group.
 */
export async function pauseService(receipt: SessionReceipt, portName: string): Promise<FaultRecord> {
  if (receipt.state !== "ready") throw new Error(`Session ${receipt.id} is ${receipt.state}; faults need a ready session`);
  const port = portNumber(receipt, portName);
  const faults = receipt.faults ?? [];
  if (faults.some((item) => item.port === portName)) {
    throw new Error(`Port ${portName} is already paused in session ${receipt.id}; run localdev fault ${receipt.id} ${portName} --clear first`);
  }
  const pids = sessionListeners(receipt, port);
  if (!pids.length) throw new Error(`No listener owned by session ${receipt.id} on ${portName} (port ${port}); nothing was paused`);
  // Clearing one fault must not resume a process another fault still expects to be paused.
  const overlap = faults.find((item) => item.pids.some((member) => pids.some((other) => other.pid === member.pid)));
  if (overlap) throw new Error(`The process listening on ${portName} is already paused by the ${overlap.port} fault`);
  const fault: FaultRecord = {
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

/**
 * Continue the recorded processes. A PID confirmed exited or reused needs nothing more; one that could not be
 * signalled may still be paused, so it stays unresolved and keeps its fault record for a later --clear or stop.
 */
function resume(fault: FaultRecord): { resumed: number[]; unresolved: ProcessIdentity[] } {
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
    if (!unresolved) return [fault];
    return unresolved.length ? [{ ...fault, pids: unresolved }] : [];
  });
}

/**
 * Clear one port's fault, or every fault when no port is named. Processes resume before the record goes; a process
 * that could not be resumed keeps its record, and the command fails after saving that, naming the PIDs.
 */
export async function clearFaults(receipt: SessionReceipt, portName?: string): Promise<Array<FaultRecord & { resumed: number[] }>> {
  if (portName) portNumber(receipt, portName);
  const faults = receipt.faults ?? [];
  const targets = portName ? faults.filter((item) => item.port === portName) : faults;
  if (!targets.length) {
    throw new Error(portName ? `No active fault on ${portName} in session ${receipt.id}` : `No active faults in session ${receipt.id}`);
  }
  const results = new Map<FaultRecord, ProcessIdentity[]>();
  const cleared = targets.map((fault) => {
    const { resumed, unresolved } = resume(fault);
    results.set(fault, unresolved);
    return { ...fault, resumed };
  });
  receipt.faults = remainingFaults(faults, results);
  await writeReceipt(receipt);
  const stuck = [...results.values()].flat().map((member) => member.pid);
  if (stuck.length) {
    throw new Error(`Could not resume ${stuck.join(", ")} in session ${receipt.id}; the fault is kept, so retry localdev fault ${receipt.id} --clear or stop`);
  }
  return cleared;
}

/**
 * Stop calls this first: a paused process keeps SIGTERM pending until it is continued. Unresolved members stay
 * recorded, so a stop that cannot verify termination keeps them for inspection. The caller writes the receipt.
 */
export function resumeAllFaults(receipt: SessionReceipt): void {
  const faults = receipt.faults ?? [];
  receipt.faults = remainingFaults(faults, new Map(faults.map((fault) => [fault, resume(fault).unresolved])));
}
