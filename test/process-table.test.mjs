import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  birthOf, compareBirth, isSameProcess, listProcesses, ownIdentity, processEntry, readBootId, readProcTable,
} from "../dist/process-table.js";

test("the procfs reader parses parent, group and zombie state, even with spaces and parentheses in names", async () => {
  const proc = await mkdtemp(path.join(os.tmpdir(), "localdev-proctable-"));
  try {
    const rows = [
      [10, "10 (node) S 1 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0"],
      [11, "11 (odd ) name (x)) Z 10 10 10 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5001 0 0"],
    ];
    for (const [pid, stat] of rows) {
      await mkdir(path.join(proc, String(pid)));
      await writeFile(path.join(proc, String(pid), "stat"), stat + "\n");
    }
    await mkdir(path.join(proc, "self"));
    const table = readProcTable(proc).sort((a, b) => a.pid - b.pid);
    assert.deepEqual(table, [
      { pid: 10, parent: 1, group: 10, zombie: false },
      { pid: 11, parent: 10, group: 10, zombie: true },
    ]);
    assert.equal(readProcTable(path.join(proc, "missing")), null);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test("births are compared in the format they were recorded in, and never match another process", () => {
  const birth = birthOf(process.pid);
  assert.ok(birth, "this process has a birth");
  if (process.platform === "linux") assert.match(birth, /^proc:[^:]+:\d+$/, "a /proc birth names the boot and the start tick");
  assert.equal(isSameProcess(process.pid, birth), true);
  assert.equal(isSameProcess(process.pid, "proc:1"), false, "a different proc birth does not match");
  assert.equal(isSameProcess(process.pid, "Thu Jan  1 00:00:00 1970"), false, "a different ps-format birth does not match");
  assert.equal(isSameProcess(process.pid, null), false);
  assert.equal(compareBirth(process.pid, birth), "same");
  const exited = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert.equal(compareBirth(exited, birth), "unknown", "a PID that is gone has no readable birth: unknown, not different");
  assert.equal(processEntry(process.pid).group, processEntry(process.pid).group);
  assert.equal(processEntry(process.pid).zombie, false);
  assert.ok(listProcesses().some((entry) => entry.pid === process.pid && entry.parent === process.ppid));
});

test("a /proc birth needs a valid boot identity, never a shared placeholder", async () => {
  const proc = await mkdtemp(path.join(os.tmpdir(), "localdev-bootid-"));
  try {
    await mkdir(path.join(proc, "sys", "kernel", "random"), { recursive: true });
    const bootFile = path.join(proc, "sys", "kernel", "random", "boot_id");
    await writeFile(bootFile, "3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6\n");
    assert.equal(readBootId(proc), "3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6");
    await writeFile(bootFile, "\n");
    await writeFile(path.join(proc, "stat"), "cpu 1 2 3\nbtime 1759640000\n");
    assert.equal(readBootId(proc), "btime1759640000", "an empty boot_id falls back to the boot time");
    await writeFile(path.join(proc, "stat"), "cpu 1 2 3\nbtime 0\n");
    assert.equal(readBootId(proc), null, "no valid identity: no birth, rather than one every boot shares");
    assert.equal(readBootId(path.join(proc, "missing")), null);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test("own identity is refused when /proc belongs to another PID namespace, so no unrelated process is ever recorded", async () => {
  const proc = await mkdtemp(path.join(os.tmpdir(), "localdev-pidns-"));
  try {
    await mkdir(path.join(proc, "sys", "kernel", "random"), { recursive: true });
    await writeFile(path.join(proc, "sys", "kernel", "random", "boot_id"), "3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6\n");
    const stat = (pid) => `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0 0\n`;
    // The managed runtime from #23: Node's PID is 2, /proc/self is 3704, and /proc/2 is some other process.
    for (const dir of ["self", "3704", "2"]) await mkdir(path.join(proc, dir));
    await writeFile(path.join(proc, "self", "stat"), stat(3704));
    await writeFile(path.join(proc, "3704", "stat"), stat(3704));
    await writeFile(path.join(proc, "2", "stat"), stat(2));
    const foreign = ownIdentity(proc, 2);
    assert.equal(foreign.birth, undefined, "no birth is read through a foreign /proc");
    assert.match(foreign.problem, /another PID namespace/);
    assert.match(foreign.problem, /3704/);
    assert.deepEqual(ownIdentity(proc, 3704), { birth: "proc:3f1c2a9e-1b2c-4d5e-8f90-a1b2c3d4e5f6:5000" });
    await rm(path.join(proc, "sys"), { recursive: true });
    assert.match(ownIdentity(proc, 3704).problem, /boot identity/, "no boot identity: refused, never a placeholder birth");
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test("this process's own identity is readable here", () => {
  assert.deepEqual(ownIdentity(), { birth: birthOf(process.pid) });
});
