import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { checkCleanupPaths } from "../../dist/adapter.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const cli = path.join(root, "dist", "cli.js");
const adapter = fileURLToPath(new URL("socket.adapter.mjs", import.meta.url));

// A state dir as deep as a T3 worktree's: a socket under its dataDir passes even Linux's 108-byte limit.
async function longStateDir() {
  const base = await mkdtemp(path.join(os.tmpdir(), "local-cli-tempdir-"));
  const state = path.join(base, "worktrees", "a-project-with-a-long-name", "bug-26-a-branch-slug-that-goes-on-and-on");
  await mkdir(state, { recursive: true });
  return { base, state };
}

function cliRunner(state) {
  return async (...args) => {
    const { stdout } = await exec(process.execPath, [cli, ...args], { env: { ...process.env, LOCAL_CLI_STATE_DIR: state }, cwd: root });
    return JSON.parse(stdout);
  };
}

const startup = (run, ...flags) => run("startup", "--project", root, "--adapter", adapter, ...flags);
const gone = (dir) => lstat(dir).then(() => false, (error) => error.code === "ENOENT");

// Every session in the state dir, failed startups included: each keeps its temp dir in /tmp until stopped.
async function stopAll(run) {
  for (const { id } of await run("status").catch(() => [])) await run("stop", id).catch(() => undefined);
}

test("a session's temp dir keeps a Unix socket path short, is private to it, and goes on stop", async () => {
  const { base, state } = await longStateDir();
  const run = cliRunner(state);
  try {
    const first = await startup(run);
    const second = await startup(run, "--parallel");
    const underDataDir = path.join(first.dataDir, "tmp", "fire_emu_0123456789abcdef.sock");
    assert.ok(Buffer.byteLength(underDataDir) > 108, `the state dir is long enough to break a socket: ${underDataDir}`);

    for (const session of [first, second]) {
      assert.equal(session.state, "ready");
      assert.match(session.tempDir, new RegExp(`^/tmp/lc-[0-9a-f]{8}-${session.id}$`));
      const stat = await lstat(session.tempDir);
      assert.ok(stat.isDirectory());
      assert.equal(stat.mode & 0o777, 0o700);
      assert.equal(stat.uid, process.getuid());
      const { socketPath } = await (await fetch(session.urls.app)).json();
      assert.equal(path.dirname(socketPath), session.tempDir);
      const resolved = path.join(await realpath(session.tempDir), path.basename(socketPath));
      assert.ok(Buffer.byteLength(resolved) < 104, `socket path fits macOS's limit: ${resolved}`);
    }
    assert.notEqual(first.tempDir, second.tempDir);
    assert.equal((await run("status", first.id))[0].tempDir, first.tempDir);

    await run("stop", first.id);
    assert.ok(await gone(first.tempDir));
    assert.equal(await gone(second.tempDir), false, "stopping one session leaves another's temp dir");
    await run("stop", second.id);
    assert.ok(await gone(second.tempDir));
  } finally {
    await stopAll(run);
    await rm(base, { recursive: true, force: true });
  }
});

test("startup and stop remove this state dir's orphaned temp dirs and nothing else", async () => {
  const { base, state } = await longStateDir();
  const run = cliRunner(state);
  const made = [];
  const makeDir = async (dir) => { made.push(dir); await mkdir(dir, { mode: 0o700 }); return dir; };
  try {
    const live = await startup(run);
    const prefix = path.basename(live.tempDir).slice(0, -live.id.length);
    const otherPrefix = `lc-${prefix.slice(3, 11) === "00000000" ? "11111111" : "00000000"}-`;
    // An older localdev stopping a session removes its session dir but not its temp dir.
    const orphan = await makeDir(path.join("/tmp", prefix + randomUUID()));
    const otherStateDirs = await makeDir(path.join("/tmp", otherPrefix + randomUUID()));
    const notASession = await makeDir(path.join("/tmp", `${prefix}not-a-session`));

    const next = await startup(run, "--parallel");
    assert.ok(await gone(orphan), "startup removes an orphaned temp dir");
    assert.equal(await gone(live.tempDir), false, "a live session's temp dir stays");
    assert.equal(await gone(otherStateDirs), false, "another state dir's temp dir stays");
    assert.equal(await gone(notASession), false, "a dir that isn't named for a session stays");

    const secondOrphan = await makeDir(path.join("/tmp", prefix + randomUUID()));
    const unknown = randomUUID();
    assert.deepEqual(await run("stop", unknown), { id: unknown, stopped: true, alreadyGone: true });
    assert.ok(await gone(secondOrphan), "stop removes an orphaned temp dir, even for an unknown ID");
    assert.equal(await gone(next.tempDir), false);
  } finally {
    await stopAll(run);
    for (const dir of made) await rm(dir, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test("only a receipt's own temp dir is removed, a failed reservation leaves none, and the cleanupPaths guard holds", async () => {
  const { base, state } = await longStateDir();
  const run = cliRunner(state);
  try {
    const session = await startup(run);
    const other = await startup(run, "--parallel");
    // removeSessionDirs is what stop runs; state reads LOCAL_CLI_STATE_DIR when it loads.
    process.env.LOCAL_CLI_STATE_DIR = state;
    const { removeSessionDirs, reserveSession } = await import("../../dist/state.js");
    for (const forged of [other.tempDir, "/tmp/anything", `${session.tempDir}/..`]) {
      await assert.rejects(removeSessionDirs({ id: session.id, tempDir: forged }), /Refusing to remove .*not this session's temp dir/);
    }
    assert.equal(await gone(other.tempDir), false, "another session's temp dir stays");
    assert.equal((await run("status", session.id))[0].state, "ready", "a refused removal leaves the session alone");

    // A receipt that can't be written undoes the reservation: no receiptless session dir, no temp dir.
    const prefix = path.basename(session.tempDir).slice(0, -session.id.length);
    let reserved;
    await assert.rejects(reserveSession(["app"], (id, dir, ports) => {
      reserved = { id, dir };
      return { id, sessionDir: dir, ports, unwritable: 1n };
    }), /BigInt/);
    assert.ok(await gone(reserved.dir), "the receiptless session dir is removed");
    assert.ok(await gone(path.join("/tmp", prefix + reserved.id)), "no temp dir is left");

    await run("stop", session.id);
    assert.ok(await gone(session.tempDir));
  } finally {
    await stopAll(run);
    await rm(base, { recursive: true, force: true });
  }
  const id = randomUUID();
  assert.throws(() => checkCleanupPaths(["/tmp/anything"], id, root), /ID-scoped in project root/);
  assert.throws(() => checkCleanupPaths([path.join("/tmp", `lc-00000000-${id}`)], id, root), /ID-scoped in project root/);
  assert.doesNotThrow(() => checkCleanupPaths([path.join(root, `.local-cli-${id}.build`)], id, root));
});
