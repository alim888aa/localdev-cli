import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { importFindings } from "./imports.mjs";
import { testStorageFindings } from "./test-storage.mjs";

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const included = (file) => !/(^|\/)(dist|node_modules|\.scratch|\.git)(\/|$)/.test(file)
  && !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(file);

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Checker base unavailable: git ${args[0]} failed. Fetch the required base or pass --base <available commit/ref>.`);
  return result.stdout;
}

/** Read the working tree and required merge-base; never substitute an empty base. */
export function readComparison(root, baseRef = "origin/main") {
  const selected = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const base = git(root, ["merge-base", selected, head]).trim();
  const before = new Map();
  for (const entry of git(root, ["ls-tree", "-rz", base]).split("\0").filter(Boolean)) {
    const [metadata, file] = entry.split("\t");
    if (!metadata.startsWith("100") || !included(file)) continue;
    before.set(file, CODE.test(file) ? git(root, ["show", `${base}:${file}`]) : "");
  }
  const after = new Map();
  for (const file of new Set(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean))) {
    if (!included(file)) continue;
    let stat;
    try { stat = lstatSync(path.join(root, file)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isFile()) after.set(file, CODE.test(file) ? readFileSync(path.join(root, file), "utf8") : "");
  }
  return { before, after, base, head, baseRef };
}

function findings(files) {
  const handwritten = new Map([...files].filter(([file]) => included(file)));
  return [...importFindings(handwritten), ...[...handwritten].flatMap(([file, text]) =>
    file.startsWith("test/") && CODE.test(file) ? testStorageFindings(file, text) : [])];
}

function folders(files) {
  const counts = new Map();
  for (const file of files.keys()) {
    if (!included(file)) continue;
    const folder = path.posix.dirname(file);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

/** Compare finding identities, including their file and scope, rather than aggregate debt counts. */
export function compareSnapshots(before, after) {
  const key = (finding) => JSON.stringify([finding.rule, finding.file, finding.identity]);
  const existing = new Map();
  for (const finding of findings(before)) existing.set(key(finding), (existing.get(key(finding)) ?? 0) + 1);
  const added = findings(after).filter((finding) => {
    const remaining = existing.get(key(finding)) ?? 0;
    if (!remaining) return true;
    existing.set(key(finding), remaining - 1);
    return false;
  });
  const oldFolders = folders(before);
  for (const [file, count] of folders(after)) {
    const old = oldFolders.get(file) ?? 0;
    if (count > Math.max(10, old)) added.push({ rule: "size/folder-files", file, line: null,
      message: `${count} direct handwritten files (base ${old}, limit 10)` });
  }
  return added;
}
