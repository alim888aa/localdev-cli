import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { birthOf, isSameProcess, listProcesses, processEntry, readProcTable } from "../dist/process-table.js";

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
  if (process.platform === "linux") assert.match(birth, /^proc:\d+$/);
  assert.equal(isSameProcess(process.pid, birth), true);
  assert.equal(isSameProcess(process.pid, "proc:1"), false, "a different proc birth does not match");
  assert.equal(isSameProcess(process.pid, "Thu Jan  1 00:00:00 1970"), false, "a different ps-format birth does not match");
  assert.equal(isSameProcess(process.pid, null), false);
  assert.equal(processEntry(process.pid).group, processEntry(process.pid).group);
  assert.equal(processEntry(process.pid).zombie, false);
  assert.ok(listProcesses().some((entry) => entry.pid === process.pid && entry.parent === process.ppid));
});
