import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { procListenerPids } from "../dist/listener.js";
import { descendsFromGroup, processTable } from "../dist/process-table.js";

// The /proc backend plus the one "owned listener" rule: a listener PID that descends from the owned group.
const ownedBy = (port, group, proc) => (procListenerPids(port, proc) ?? []).some((pid) => descendsFromGroup(pid, group, processTable(proc)));

test("Linux listener ownership follows socket inodes and rejects a port takeover", async () => {
  const proc = await mkdtemp(path.join(os.tmpdir(), "localdev-proc-"));
  try {
    await mkdir(path.join(proc, "net"));
    await writeFile(path.join(proc, "net", "tcp"), [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:9C40 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 123456 1",
    ].join("\n"));
    for (const [pid, parent, group] of [[4312, 1, 4312], [4313, 4312, 4312], [5313, 1, 5313]]) {
      await mkdir(path.join(proc, String(pid), "fd"), { recursive: true });
      await writeFile(path.join(proc, String(pid), "stat"), `${pid} (node worker) S ${parent} ${group} 0 0\n`);
    }
    const ownedFd = path.join(proc, "4313", "fd", "3");
    const otherFd = path.join(proc, "5313", "fd", "3");
    await symlink("socket:[123456]", ownedFd);
    assert.equal(ownedBy(40000, 4312, proc), true);
    assert.deepEqual(procListenerPids(40000, proc), [4313]);
    assert.deepEqual(procListenerPids(40001, proc), []);

    await unlink(ownedFd);
    await symlink("socket:[123456]", otherFd);
    assert.equal(ownedBy(40000, 4312, proc), false);
    assert.deepEqual(procListenerPids(40000, proc), [5313], "listener PIDs are reported whoever owns them");
    assert.equal(ownedBy(40001, 4312, proc), false);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});
