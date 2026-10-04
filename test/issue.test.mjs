import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");

test("issue draft formats project context without publishing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "localdev-issue-draft-"));
  try {
    const input = path.join(dir, "bug.json");
    await writeFile(input, JSON.stringify({
      title: "stop leaves a listener", summary: "The old app still answers.",
      expected: "Its listener closes.", steps: ["Start a session", "Stop it", "Request its URL"],
      impact: "Another agent may test the wrong app.",
    }));
    const { stdout } = await exec(process.execPath, [cli, "issue", "bug", "--input", input, "--cli-ref", "abc1234"], { cwd: root });
    assert.match(stdout, /# bug: stop leaves a listener/);
    assert.match(stdout, /1\. Start a session\n2\. Stop it/);
    assert.match(stdout, /localdev Git ref: `abc1234`/);
    assert.match(stdout, /Label: bug/);
    assert.match(stdout, /Draft only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue submit publishes through the gh REST API and prints the draft when it cannot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "localdev-issue-submit-"));
  const store = path.join(dir, "saved.json");
  const fakeGh = path.join(dir, "gh");
  try {
    await writeFile(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const field = (flag, name) => { const index = args.findIndex((value, i) => args[i - 1] === flag && value.startsWith(name + "=")); return args[index].slice(name.length + 1); };
if (process.env.FAKE_GH_FAIL) { console.error("HTTP 403: GraphQL and REST blocked"); process.exit(1); }
if (args[0] === "api" && args.includes("POST")) {
  fs.writeFileSync(process.env.FAKE_GH_STORE, JSON.stringify({
    title: field("-f", "title"), label: field("-f", "labels[]"), body: fs.readFileSync(field("-F", "body").slice(1), "utf8")
  }));
  console.log(JSON.stringify({ number: 123, html_url: "https://github.com/alim888aa/localdev-cli/issues/123" }));
} else if (args[0] === "api" && args[1] === "repos/alim888aa/localdev-cli/issues/123") {
  const saved = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STORE, "utf8"));
  console.log(JSON.stringify({ title: saved.title, html_url: "https://github.com/alim888aa/localdev-cli/issues/123", labels: [{ name: saved.label }], state: "open" }));
} else process.exit(2);
`);
    await chmod(fakeGh, 0o755);
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_GH_STORE: store };
    const cases = [
      ["bug", { title: "wrong port", summary: "The app answers on another session's port.", expected: "A new free port.", steps: ["Start two projects", "Inspect ports"], impact: "Cross-project collision." }, "bug", "## Reproduce it"],
      ["request", { title: "export session context", task: "Agents copy URLs by hand.", desired: "Print a reusable env file.", whyShared: "All projects need the same receipt format.", acceptance: "Two projects get distinct env files." }, "enhancement", "## Acceptance check"],
    ];
    for (const [kind, fields, label, heading] of cases) {
      const input = path.join(dir, `${kind}.json`);
      await writeFile(input, JSON.stringify(fields));
      const { stdout } = await exec(process.execPath, [cli, "issue", kind, "--input", input, "--submit"], { cwd: root, env });
      assert.match(stdout, new RegExp(`Created .* \\[${label}\\]`));
      const saved = JSON.parse(await readFile(store, "utf8"));
      assert.equal(saved.label, label);
      assert.match(saved.body, new RegExp(heading));
      assert.match(saved.body, /Project commit: `[0-9a-f]{40}`/);
      assert.doesNotMatch(stdout, /## Agent task|## What went wrong/);
    }
    const input = path.join(dir, "bug.json");
    const failed = await exec(process.execPath, [cli, "issue", "bug", "--input", input, "--submit"], { cwd: root, env: { ...env, FAKE_GH_FAIL: "1" } })
      .then(() => assert.fail("publishing should fail"), (error) => error);
    assert.match(failed.stdout, /## What went wrong/, "the draft is printed when publishing fails");
    assert.match(failed.stderr, /Could not publish .* nothing was created/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installed CLI does not mistake the host project's commit for its own", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "localdev-issue-install-"));
  try {
    const project = path.join(dir, "project");
    const installed = path.join(project, "node_modules", "@local-tools", "cli");
    await mkdir(installed, { recursive: true });
    await cp(path.join(root, "dist"), path.join(installed, "dist"), { recursive: true });
    await cp(path.join(root, "package.json"), path.join(installed, "package.json"));
    await exec("git", ["init", "-q", project]);
    await exec("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial"]);
    const input = path.join(dir, "bug.json");
    await writeFile(input, JSON.stringify({
      title: "bad port", summary: "The listener is wrong.", expected: "The owned listener answers.",
      steps: ["Start the app", "Inspect its port"], impact: "Verification is blocked.",
    }));
    const { stdout } = await exec(process.execPath, [path.join(installed, "dist", "cli.js"), "issue", "bug", "--input", input], { cwd: project });
    assert.match(stdout, /Project commit: `[0-9a-f]{40}`/);
    assert.match(stdout, /localdev Git ref: `unknown`/);
    await assert.rejects(
      exec(process.execPath, [path.join(installed, "dist", "cli.js"), "issue", "bug", "--input", input, "--submit"], { cwd: project }),
      /Cannot submit without the installed localdev Git commit/,
    );
    const cliRef = "a".repeat(40);
    const pnpmInstall = path.join(project, "node_modules", ".pnpm", `@local-tools+cli@git+https+++github.com+alim888aa+localdev-cli.git+${cliRef}`, "node_modules", "@local-tools", "cli");
    await mkdir(pnpmInstall, { recursive: true });
    await cp(path.join(root, "dist"), path.join(pnpmInstall, "dist"), { recursive: true });
    await cp(path.join(root, "package.json"), path.join(pnpmInstall, "package.json"));
    const stamped = await exec(process.execPath, [path.join(pnpmInstall, "dist", "cli.js"), "issue", "bug", "--input", input], { cwd: project });
    assert.ok(stamped.stdout.includes(`localdev Git ref: \`${cliRef}\``));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
