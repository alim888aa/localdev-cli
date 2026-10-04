import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");

test("help works from a project with no adapter or GitHub access", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "localdev-help-"));
  try {
    const cases = [
      [[], "localdev startup [fixture]"],
      [["help"], "localdev issue bug|request"],
      [["--help"], "localdev stop ID"],
      [["help", "startup"], "defaultFixture"],
      [["status", "--help"], "localdev status [ID]"],
      [["help", "stop"], "localdev stop ID"],
      [["help", "fault"], "localdev fault ID PORT --mode pause"],
      [["fault", "--help"], "localdev fault ID --clear"],
      [["issue", "--help"], "authenticated gh access"],
      [["issue", "bug", "--help"], "JSON input requires: title, summary, expected, steps, impact"],
      [["help", "issue", "request"], "JSON input requires: title, task, desired, whyShared, acceptance"],
    ];
    for (const [args, expected] of cases) {
      const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd: project, env: { ...process.env, LOCAL_CLI_STATE_DIR: path.join(project, "state") } });
      assert.ok(stdout.includes(expected), `missing ${expected} for ${args.join(" ")}`);
      assert.equal(stderr, "");
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
