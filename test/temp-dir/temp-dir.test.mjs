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

test("the cleanupPaths guard still refuses paths outside the project root, session temp dirs included", () => {
  const id = randomUUID();
  assert.throws(() => checkCleanupPaths(["/tmp/anything"], id, root), /ID-scoped in project root/);
  assert.throws(() => checkCleanupPaths([path.join("/tmp", `lc-00000000-${id}`)], id, root), /ID-scoped in project root/);
  assert.doesNotThrow(() => checkCleanupPaths([path.join(root, `.local-cli-${id}.build`)], id, root));
});
