import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parseArgs } from "../dist/args.js";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");
const startup = {
  command: "startup", values: ["--project", "--adapter"], optionalValues: ["--replace"], booleans: ["--parallel", "--no-outbound"],
  missingValue: () => new Error("usage"),
};

test("the argument parser rejects an unknown flag, naming it and the command's help", () => {
  assert.throws(() => parseArgs(["base", "--no-outboud"], startup),
    { message: 'Unknown startup option: --no-outboud. Run "localdev help startup" for its options.' });
  assert.throws(() => parseArgs(["--project"], startup), { message: "usage" });
  assert.deepEqual(parseArgs(["base", "--replace", "--project", "dir", "--no-outbound"], startup),
    { flags: { "--replace": true, "--project": "dir", "--no-outbound": true }, positionals: ["base"] });
  assert.deepEqual(parseArgs(["--replace", "abc"], startup).flags, { "--replace": "abc" });
});

test("every command rejects an unknown flag before touching any session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "localdev-args-"));
  try {
    const env = { ...process.env, LOCAL_CLI_STATE_DIR: path.join(dir, "state") };
    for (const [args, flag] of [
      [["startup", "--no-outboud"], "--no-outboud"],
      [["status", "--all"], "--all"],
      [["stop", "--force"], "--force"],
      [["fault", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "api", "--mode", "fail", "--times", "2"], "--times"],
      [["issue", "bug", "--draft"], "--draft"],
    ]) {
      const command = args[0];
      await assert.rejects(exec(process.execPath, [cli, ...args], { cwd: dir, env }), (error) =>
        error.stderr.trim() === `Unknown ${command} option: ${flag}. Run "localdev help ${command}" for its options.`);
    }
    await assert.rejects(rm(path.join(dir, "state")), { code: "ENOENT" }, "no state was created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
