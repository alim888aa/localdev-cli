import { promises as fs } from "node:fs";
import path from "node:path";
import { runSync } from "./run-sync.js";

// The identity of a project checkout: its canonical path and its Git commit.

/**
 * A checkout's canonical path, so a symlinked checkout and its target are one project wherever paths are compared
 * (startup's receipt, duplicate matching, issue --session). A path that cannot be resolved, such as a removed
 * checkout, stays absolute as given unless mustExist, which rethrows (startup needs the checkout).
 */
export async function projectRoot(dir: string, { mustExist = false } = {}): Promise<string> {
  const absolute = path.resolve(dir);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if (mustExist) throw error;
    return absolute;
  }
}

/** The checkout's HEAD commit, or null outside Git. */
export function gitCommit(root: string): string | null {
  try {
    return runSync("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  } catch { return null; }
}
