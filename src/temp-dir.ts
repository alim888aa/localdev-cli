import { createHash } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

// Session temp dirs: the short private dir each session gets for TMPDIR (SessionContext.tempDir). They sit in /tmp
// because a Unix socket path is capped at 104 bytes on macOS (108 on Linux), which paths under the state dir or
// os.tmpdir() can pass; /private/tmp/lc-<8>-<uuid>/ leaves 41 bytes for a socket's name. A temp dir is outside every
// session path, so one is removed only once proven to be this state dir's dir for that session (unproven): the name
// for the canonical state dir and ID, a real directory (lstat, never a symlink) owned by this user, and a marker
// written at creation naming the same canonical state dir and ID. The name's 32-bit hash alone proves nothing.

const tempRoot = "/tmp";
const markerName = ".localdev-session";
const tempName = /^lc-[0-9a-f]{8}-[0-9a-f-]{36}$/;
const gone = "gone";

/** The state dir as identity: realpath, so an alias path (a symlink, /tmp for /private/tmp) names the same dirs. */
async function canonical(stateRoot: string): Promise<string> {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  return fs.realpath(stateRoot);
}

function tempDirOf(stateDir: string, id: string): string {
  return path.join(tempRoot, `lc-${createHash("sha256").update(stateDir).digest("hex").slice(0, 8)}-${id}`);
}

/** The temp dir path for a session of this state dir; record it before makeTempDir creates it. */
export async function tempDirFor(stateRoot: string, id: string): Promise<string> {
  return tempDirOf(await canonical(stateRoot), id);
}

const markerText = (stateDir: string, id: string) => JSON.stringify({ stateDir, id });

/** Set-up failed after this call's mkdir; the message names the dir, and why it was left if rollback couldn't remove it. */
class TempDirSetupError extends Error {
  constructor(dir: string, cause: unknown, left: string | null) {
    super(`Could not set up session temp dir ${dir}: ${(cause as Error).message}` + (left ? `; left it in place: ${left}` : ""));
  }
}

/**
 * Create a session's temp dir (0700) and its identity marker. An existing path fails instead of being reused. If the
 * chmod or marker write fails, the dir this call just made is rolled back (rollBack) and TempDirSetupError thrown.
 */
export async function makeTempDir(stateRoot: string, id: string): Promise<void> {
  const stateDir = await canonical(stateRoot);
  const dir = tempDirOf(stateDir, id);
  await fs.mkdir(dir, { mode: 0o700 });
  const made = await fs.lstat(dir);
  let markerOurs = false;
  try {
    await fs.chmod(dir, 0o700); // mkdir's mode is masked by the umask
    markerOurs = true;
    await fs.writeFile(path.join(dir, markerName), markerText(stateDir, id), { mode: 0o600, flag: "wx" })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") markerOurs = false;
        throw error;
      });
  } catch (error) {
    throw new TempDirSetupError(dir, error, await rollBack(dir, made, markerOurs));
  }
}

/**
 * Undo this call's own fresh mkdir, which needs no marker to prove: the dir must still be the one mkdir made (lstat:
 * same dev, inode and owner, not a symlink), holding at most the regular marker file this call wrote. Unlinks that,
 * then rmdir; never recursive. Returns why the dir was left in place, or null once removed.
 */
async function rollBack(dir: string, made: Stats, markerOurs: boolean): Promise<string | null> {
  try {
    const now = await fs.lstat(dir);
    if (!now.isDirectory() || now.dev !== made.dev || now.ino !== made.ino || now.uid !== made.uid) {
      return "it was replaced after this startup created it";
    }
    const entries = await fs.readdir(dir);
    if (entries.some((name) => name !== markerName) || (entries.length && !markerOurs)) {
      return "it holds files this startup didn't write";
    }
    if (entries.length) {
      const marker = await fs.lstat(path.join(dir, markerName));
      if (!marker.isFile() || marker.uid !== made.uid) return "its marker isn't the regular file this startup wrote";
      await fs.unlink(path.join(dir, markerName));
    }
    await fs.rmdir(dir);
    return null;
  } catch (error) {
    return `rollback failed: ${(error as Error).message}`;
  }
}

/** Why dir can't be proven this state dir's temp dir for session id (or `gone`), or null when it is. */
async function unproven(stateDir: string, id: string, dir: string): Promise<string | null> {
  if (dir !== tempDirOf(stateDir, id)) return "not this session's temp dir path";
  const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return gone;
  if (!stat.isDirectory()) return "not a directory (a symlink is never followed)";
  if (stat.uid !== process.getuid?.()) return "owned by another user";
  const markerPath = path.join(dir, markerName);
  const marker = await fs.lstat(markerPath).catch(() => null);
  if (!marker?.isFile() || marker.uid !== stat.uid) return "no identity marker";
  // Compared as written, never parsed, so a malformed marker is a failed proof rather than an error.
  const text = await fs.readFile(markerPath, "utf8").catch(() => null);
  if (text === null) return "its identity marker is unreadable";
  return text === markerText(stateDir, id) ? null : "its marker doesn't name this state dir and session";
}

/**
 * stop's removal of a session's temp dir: only once proven (see unproven). Anything else is left in place and named on
 * stderr (skip-and-alert), so a stop always finishes and never deletes what isn't the session's.
 */
export async function removeTempDir(stateRoot: string, id: string, dir: string): Promise<void> {
  const reason = await unproven(await canonical(stateRoot), id, dir);
  if (reason === gone) return;
  if (reason) {
    console.error(`Did not remove session temp dir ${dir}: ${reason}`);
    return;
  }
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Remove this state dir's proven temp dirs whose session has no session dir (say, an older localdev stopped it). A
 * temp dir is made after its session dir and removed before it, so a live session's is never taken, lock or not. A dir
 * that can't be proven isn't this state dir's and is left alone quietly. Never throws: a failure is named on stderr.
 */
export async function sweepOrphanTempDirs(stateRoot: string, hasSessionDir: (id: string) => Promise<boolean>): Promise<void> {
  const stateDir = await canonical(stateRoot);
  const prefix = path.basename(tempDirOf(stateDir, ""));
  const names = await fs.readdir(tempRoot).catch((error: Error) => {
    console.error(`Could not look for orphaned session temp dirs in ${tempRoot}: ${error.message}`);
    return [];
  });
  for (const name of names) {
    if (!name.startsWith(prefix) || !tempName.test(name)) continue;
    const id = name.slice(prefix.length);
    const dir = path.join(tempRoot, name);
    try {
      if (await hasSessionDir(id) || await unproven(stateDir, id, dir)) continue;
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`Could not remove orphaned session temp dir ${dir}: ${(error as Error).message}`);
    }
  }
}
