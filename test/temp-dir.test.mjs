import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { checkCleanupPaths } from "../dist/adapter.js";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");
const adapter = path.join(root, "test", "socket.adapter.mjs");

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

test("a session's temp dir keeps a Unix socket path short, is private to it, and goes on stop", async () => {
  const { base, state } = await longStateDir();
  const run = cliRunner(state);
  const ids = [];
  try {
    const first = await startup(run);
    ids.push(first.id);
    const second = await startup(run, "--parallel");
    ids.push(second.id);
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
    for (const id of ids) await run("stop", id).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test("startup and stop remove this state dir's orphaned temp dirs and nothing else", async () => {
  const { base, state } = await longStateDir();
  const run = cliRunner(state);
  const ids = [];
  const made = [];
  const makeDir = async (dir) => { made.push(dir); await mkdir(dir, { mode: 0o700 }); return dir; };
  try {
    const live = await startup(run);
    ids.push(live.id);
    const prefix = path.basename(live.tempDir).slice(0, -live.id.length);
    const otherPrefix = `lc-${prefix.slice(3, 11) === "00000000" ? "11111111" : "00000000"}-`;
    // An older localdev stopping a session removes its session dir but not its temp dir.
    const orphan = await makeDir(path.join("/tmp", prefix + randomUUID()));
    const otherStateDirs = await makeDir(path.join("/tmp", otherPrefix + randomUUID()));
    const notASession = await makeDir(path.join("/tmp", `${prefix}not-a-session`));

    const next = await startup(run, "--parallel");
    ids.push(next.id);
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
    for (const id of ids) await run("stop", id).catch(() => undefined);
    for (const dir of made) await rm(dir, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test("stop refuses a receipt temp dir that isn't the session's own, and the cleanupPaths guard is unchanged", async () => {
  const { base, state } = await longStateDir();
  const run = cliRunner(state);
  const ids = [];
  let restore;
  try {
    const session = await startup(run);
    ids.push(session.id);
    const other = await startup(run, "--parallel");
    ids.push(other.id);
    const receiptFile = path.join(state, "sessions", session.id, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    restore = () => writeFile(receiptFile, JSON.stringify(receipt));
    for (const forged of [other.tempDir, "/tmp/anything", `${session.tempDir}/..`]) {
      await writeFile(receiptFile, JSON.stringify({ ...receipt, tempDir: forged }));
      await assert.rejects(run("stop", session.id), /refusing to remove/);
    }
    assert.equal(await gone(other.tempDir), false, "another session's temp dir stays");

    await restore();
    await run("stop", session.id);
    assert.ok(await gone(session.tempDir));
  } finally {
    await restore?.().catch(() => undefined);
    for (const id of ids) await run("stop", id).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
  const id = randomUUID();
  assert.throws(() => checkCleanupPaths(["/tmp/anything"], id, root), /ID-scoped in project root/);
  assert.throws(() => checkCleanupPaths([path.join("/tmp", `lc-00000000-${id}`)], id, root), /ID-scoped in project root/);
  assert.doesNotThrow(() => checkCleanupPaths([path.join(root, `.local-cli-${id}.build`)], id, root));
});
