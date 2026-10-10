#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Hold kill's first ownership read until stop observed the original group. Stop's birth read then waits for
// kill to finish that group, reproducing disappearance between the live-group and identity observations.
const args = process.argv.slice(2);
const { RACE_PID: pid, RACE_RECEIPT: receipt, RACE_HIT: hit, RACE_ROLE: role } = process.env;
const birthRead = args.join(" ") === `-o lstart= -p ${pid}`;
const restarting = () => {
  try { return JSON.parse(readFileSync(receipt)).faults?.some((f) => f.mode === "kill"); }
  catch { return false; }
};
const alive = () => execFileSync("/bin/ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" })
  .split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return group === pid && state && !state.startsWith("Z");
  });

function waitFor(check) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out at ownership barrier");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

if (birthRead && restarting()) {
  if (role === "fault") waitFor(() => existsSync(hit));
  if (role === "stop") { writeFileSync(hit, "ownership read"); waitFor(() => !alive()); }
}
try { process.stdout.write(execFileSync("/bin/ps", args)); }
catch (error) { process.exit(error.status ?? 1); }
