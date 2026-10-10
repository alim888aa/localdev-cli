// Source rules the check counts. Each rule returns findings as "file:line text".
// Strict rules fail on any finding. Ratchet rules compare to baseline.json.
// The rules come from CODING_STANDARDS.md "Rules".
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";

export const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const CODE = /\.(ts|mts|mjs|js)$/;

function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(REPO_ROOT, dir), {withFileTypes: true});
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...filesUnder(path));
    } else if (CODE.test(entry.name)) out.push(path);
  }
  return out;
}

// Lines matching `pattern`, skipping comment-only lines (// ..., /** ... */ bodies).
function grep(files, pattern) {
  const findings = [];
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*(\/\/|\/?\*)/.test(line)) return;
      if (pattern.test(line)) findings.push(`${file}:${index + 1} ${line.trim()}`);
    });
  }
  return findings;
}

const except = (files, ...owners) => files.filter((file) => !owners.includes(file));

export function measureRules() {
  const src = filesUnder("src");

  return {
    strict: {
      // "Run synchronous commands only through run-sync."
      "process/sync-commands-only-in-run-sync": grep(
        except(src, "src/run-sync.ts"),
        /\b(execSync|spawnSync|execFileSync)\b/,
      ),
      // "Read and change a receipt only through state."
      "state/receipt-file-only-in-state": grep(except(src, "src/state.ts"), /receipt\.json/),
    },
    ratchet: {
      // "Compare process births only through process-table." A birth compared with ===/!== outside
      // process-table (a null check is not a comparison). Today: fault.ts matches receipt records by
      // pid and birth, so this is a ratchet, not strict.
      "process/birth-compared-outside-process-table": grep(
        except(src, "src/process-table.ts"),
        /birth\w*\s*[!=]==(?!\s*null\b)|[!=]==\s*[\w.]*birth(?!\w)/i,
      ),
      // Factory errors standard: no generic `new Error` in enforced folders, ratcheted elsewhere.
      // There are no enforced folders yet, so the whole of src/ is ratcheted.
      "errors/generic-throw": grep(src, /\bthrow new Error\(/),
    },
  };
}
