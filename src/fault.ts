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
  const paused = pids.filter((member) => signalProcess(member, "SIGSTOP"));
  if (paused.length !== pids.length) {
    receipt.faults = paused.length ? [...faults, { ...fault, pids: paused }] : faults;
    await writeReceipt(receipt);
    if (!paused.length) throw new Error(`The listener on ${portName} exited before it could be paused`);
  }
  return { ...fault, pids: paused };
}

/** Resume the recorded processes that are still the same process; a PID that exited or was reused is skipped. */
function resume(fault: FaultRecord): number[] {
  return fault.pids.filter((member) => signalProcess(member, "SIGCONT")).map((member) => member.pid);
}

/** Clear one port's fault, or every fault when no port is named. Processes resume before the record goes. */
export async function clearFaults(receipt: SessionReceipt, portName?: string): Promise<Array<FaultRecord & { resumed: number[] }>> {
  if (portName) portNumber(receipt, portName);
  const faults = receipt.faults ?? [];
  const targets = portName ? faults.filter((item) => item.port === portName) : faults;
  if (!targets.length) {
    throw new Error(portName ? `No active fault on ${portName} in session ${receipt.id}` : `No active faults in session ${receipt.id}`);
  }
  const cleared = targets.map((fault) => ({ ...fault, resumed: resume(fault) }));
  receipt.faults = faults.filter((item) => !targets.includes(item));
  await writeReceipt(receipt);
  return cleared;
}

/** Stop calls this first: a paused process keeps SIGTERM pending until it is continued. The caller writes the receipt. */
export function resumeAllFaults(receipt: SessionReceipt): void {
  for (const fault of receipt.faults ?? []) resume(fault);
  receipt.faults = [];
}
