import assert from "node:assert/strict";
import test from "node:test";
import { runSync } from "../dist/run-sync.js";

// Why runSync exists: new Codex Cloud executors report EPERM from every synchronous child_process call
// (execFileSync, spawnSync, even `node -e 0`) although the child runs and exits 0 with valid output. execFileSync
// throws on that, which broke startup. Keep every synchronous command in src going through runSync; don't
// "simplify" a call site back to execFileSync. That case can't be reproduced here; the cloud acceptance run covers it.

test("runSync returns stdout on exit 0 and throws with code, status and stderr otherwise", () => {
  assert.equal(runSync(process.execPath, ["-e", "process.stdout.write('ok')"]), "ok");
  assert.throws(() => runSync(process.execPath, ["-e", "console.error('nope'); process.exit(3)"]),
    (error) => error.status === 3 && /nope/.test(error.stderr) && /exit code 3/.test(error.message));
  assert.throws(() => runSync("localdev-no-such-command", []), (error) => error.code === "ENOENT" && error.status === null);
});
