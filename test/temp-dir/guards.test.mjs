import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after } from "node:test";

// The proof every removal of a session temp dir needs (src/temp-dir.ts), through state's front door. state reads
// LOCAL_CLI_STATE_DIR when it loads, so this file's state module is reached through an alias path (a symlink to
// the real state dir), and a second module instance stands in for a different state dir.
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const cli = path.join(root, "dist", "cli.js");
const base = await mkdtemp(path.join(os.tmpdir(), "local-cli-tempguard-"));
const real = path.join(base, "state");
const alias = path.join(base, "alias");
const other = path.join(base, "other-state");
await mkdir(real);
await symlink(real, alias);
process.env.LOCAL_CLI_STATE_DIR = other;
const otherState = await import("../../dist/state.js?other-state");
process.env.LOCAL_CLI_STATE_DIR = alias;
const { removeOrphanTempDirs, removeSessionDirs, reserveSession } = await import("../../dist/state.js");

const made = [];
after(async () => {
  for (const { id } of await viaReal("status").catch(() => [])) await viaReal("stop", id).catch(() => undefined);
  for (const item of made) await rm(item, { recursive: true, force: true });
  await removeOrphanTempDirs();
  await rm(base, { recursive: true, force: true });
});

// The CLI on the real (canonical) path, while this process uses the alias.
async function viaReal(...args) {
  const { stdout } = await exec(process.execPath, [cli, ...args], { env: { ...process.env, LOCAL_CLI_STATE_DIR: real }, cwd: root });
  return JSON.parse(stdout);
}

// A process-less session; "failed", so its ports don't count as taken.
function reserve(state = { reserveSession }) {
  return state.reserveSession(["app"], (id, dir, ports) => ({
    id, fixture: "guard", projectRoot: base, commit: null, adapterPath: "", sessionDir: dir, dataDir: path.join(dir, "data"),
    ports, urls: {}, processes: [], state: "failed", ownerPid: process.pid, createdAt: new Date().toISOString(),
  }));
}

// What an older localdev's stop leaves: the session dir gone, the temp dir still there.
async function orphan(state = { reserveSession, removeSessionDirs }) {
  const receipt = await reserve(state);
  await state.removeSessionDirs({ id: receipt.id });
  return receipt;
}

const prefixOf = ({ id, tempDir }) => path.basename(tempDir).slice(0, -id.length);
const exists = (item) => lstat(item).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));

async function victim() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-cli-victim-"));
  made.push(dir);
  await writeFile(path.join(dir, "keep"), "keep\n");
  return dir;
}

// Another state dir's temp dir, renamed to a name this state dir would use: what a name-hash collision looks like.
async function foreignFolderAt(target) {
  const { id, tempDir } = await orphan(otherState);
  await rm(target, { recursive: true, force: true });
  await rename(tempDir, target);
  made.push(target);
  return id;
}

async function stderrOf(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...parts) => lines.push(parts.join(" "));
  try { await fn(); } finally { console.error = original; }
  return lines.join("\n");
}

test("an alias path to the state dir names the same temp dirs, and its marker records the canonical state dir", async () => {
  const receipt = await reserve();
  const canonical = await realpath(real);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  assert.equal(receipt.tempDir, `/tmp/lc-${hash}-${receipt.id}`);
  assert.deepEqual(JSON.parse(await readFile(path.join(receipt.tempDir, ".localdev-session"), "utf8")), { stateDir: canonical, id: receipt.id });
  assert.equal((await viaReal("status", receipt.id))[0].tempDir, receipt.tempDir);
  await viaReal("stop", receipt.id);
  assert.equal(await exists(receipt.tempDir), false, "stop through the real path removes the alias-made temp dir");
});

test("the sweep removes proven orphans and leaves symlinks, unmarked dirs and another state dir's same-name folder", async () => {
  const proven = await orphan();
  const prefix = prefixOf(proven);
  const target = await victim();
  const link = path.join("/tmp", prefix + randomUUID());
  made.push(link);
  await symlink(target, link);
  const unmarked = path.join("/tmp", prefix + randomUUID());
  made.push(unmarked);
  await mkdir(unmarked, { mode: 0o700 });
  const sameName = path.join("/tmp", prefix + randomUUID());
  await foreignFolderAt(sameName);

  const unknown = randomUUID();
  assert.deepEqual(await viaReal("stop", unknown), { id: unknown, stopped: true, alreadyGone: true });
  assert.equal(await exists(proven.tempDir), false, "stop's sweep removes a proven orphan");
  assert.ok((await lstat(link)).isSymbolicLink(), "a symlink is never removed");
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "keep\n", "nor followed");
  assert.ok(await exists(unmarked), "an unmarked dir can't be proven");
  assert.ok(await exists(sameName), "another state dir's folder stays, whatever its name");

  const next = await orphan();
  await reserve();
  assert.equal(await exists(next.tempDir), false, "a reservation (startup) sweeps too");
});

test("a folder owned by another user (faked uid) is never removed, by the sweep or by stop", async () => {
  const live = await reserve();
  const stray = await orphan(); // after live: a reservation sweeps orphans
  const realUid = process.getuid;
  process.getuid = () => realUid() + 1;
  let message;
  try {
    await removeOrphanTempDirs();
    message = await stderrOf(() => removeSessionDirs(live));
  } finally {
    process.getuid = realUid;
  }
  assert.match(message, /Did not remove session temp dir .*owned by another user/);
  assert.ok(await exists(stray.tempDir));
  assert.ok(await exists(live.tempDir));
  await removeOrphanTempDirs();
  assert.equal(await exists(stray.tempDir), false, "only the owner check held them");
  assert.equal(await exists(live.tempDir), false);
});

test("stop leaves a symlink, another state dir's folder or a forged path where a session's temp dir should be", async () => {
  const linked = await reserve();
  const target = await victim();
  await rm(linked.tempDir, { recursive: true });
  await symlink(target, linked.tempDir);
  made.push(linked.tempDir);
  assert.match(await stderrOf(() => removeSessionDirs(linked)), /not a directory \(a symlink is never followed\)/);
  assert.ok((await lstat(linked.tempDir)).isSymbolicLink());
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "keep\n");

  const swapped = await reserve();
  await foreignFolderAt(swapped.tempDir);
  assert.match(await stderrOf(() => removeSessionDirs(swapped)), /its marker names another state dir or session/);
  assert.ok(await exists(swapped.tempDir));

  const keeper = await reserve();
  for (const forged of [keeper.tempDir, "/tmp/anything", `${keeper.tempDir}/..`]) {
    const forger = await reserve();
    assert.match(await stderrOf(() => removeSessionDirs({ id: forger.id, tempDir: forged })), /not this session's temp dir path/);
    await removeSessionDirs(forger);
  }
  assert.ok(await exists(keeper.tempDir), "another session's temp dir stays");
  await removeSessionDirs(keeper);
});

test("a session reserved while sweeps run keeps its temp dir", async () => {
  const reserved = [];
  for (let round = 0; round < 20; round++) {
    const [receipt] = await Promise.all([reserve(), removeOrphanTempDirs(), removeOrphanTempDirs(), removeOrphanTempDirs()]);
    reserved.push(receipt);
  }
  for (const receipt of reserved) assert.ok((await lstat(receipt.tempDir)).isDirectory(), receipt.tempDir);
  for (const receipt of reserved) await removeSessionDirs(receipt);
  for (const receipt of reserved) assert.equal(await exists(receipt.tempDir), false);
});

test("a reservation whose receipt can't be written leaves no session dir and no temp dir", async () => {
  const prefix = prefixOf(await orphan());
  let reserved;
  await assert.rejects(reserveSession(["app"], (id, dir, ports) => {
    reserved = { id, dir };
    return { id, sessionDir: dir, ports, unwritable: 1n };
  }), /BigInt/);
  assert.equal(await exists(reserved.dir), false);
  assert.equal(await exists(path.join("/tmp", prefix + reserved.id)), false);
});
