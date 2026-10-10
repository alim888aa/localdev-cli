// localdev adapter for localdev itself. See docs: https://github.com/alim888aa/localdev-cli
// localdev has no UI of its own; its clients are other projects that keep a local.adapter.mjs and run
// `localdev startup`, `status`, `stop`, `fault` and `issue`. So a session here is a scratch world set up the way
// those clients use it: a client project, an isolated state directory, and the CLI build under test.
//
// Fixtures:
//   base   Creates <dataDir>/client-project, a tiny git repo (one commit) with its own local.adapter.mjs
//          (fixtures/base/client-project). That adapter has fixtures "base" (api behind the fault proxy,
//          web, a seed that exits 0, a credentials file, URLs) and "seed-fails" (the seed exits 1).
//          The session itself runs one small service on the "readme" port that serves a how-to.
//          <sessionDir>/cli.env exports:
//            LOCAL_CLI_STATE_DIR  <dataDir>/state, so nested sessions never touch this machine's real ones
//            LOCALDEV             <sessionDir>/localdev, a wrapper for `node <checkout>/dist/cli.js` (the build
//                                 under test, never a global install) that also pins LOCAL_CLI_STATE_DIR
//            CLIENT_PROJECT       <dataDir>/client-project
//          Use it in a subshell so the nested state dir does not leak into commands for this session:
//            (source <sessionDir>/cli.env && cd "$CLIENT_PROJECT" && "$LOCALDEV" startup)
//
// Safety: nothing is written into the checkout; everything lives in the session's dirs. Stop nested sessions
// before the outer one (`stop` only removes its own processes, so a nested session left running would leak).
//
// Needs a built CLI: run `pnpm build` first.
import {spawnSync} from "node:child_process";
import {access, cp, mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

const fixtures = ["base"];

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function git(cwd, args) {
  // Ignore the machine's git config so hooks and signing cannot break or leak into the scratch repo.
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Scratch Client",
      GIT_AUTHOR_EMAIL: "scratch@example.test",
      GIT_COMMITTER_NAME: "Scratch Client",
      GIT_COMMITTER_EMAIL: "scratch@example.test",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in the scratch client: ${result.stderr || result.error}`);
}

export default {
  ports: ["readme"],
  defaultFixture: "base",

  cleanupPaths() {
    return []; // Nothing is written into the checkout.
  },

  async createSession({fixture, projectRoot, sessionDir, dataDir, ports, bindPorts}) {
    if (!fixtures.includes(fixture)) {
      throw new Error(`Unknown localdev fixture: ${fixture}. Known fixtures: ${fixtures.join(", ")}`);
    }
    const cliPath = path.join(projectRoot, "dist", "cli.js");
    try {
      await access(cliPath);
    } catch {
      throw new Error(`No built CLI at ${cliPath}. Run \`pnpm build\` first.`);
    }
    const listen = bindPorts ?? ports;

    const stateDir = path.join(dataDir, "state");
    const clientProject = path.join(dataDir, "client-project");
    await mkdir(stateDir, {recursive: true, mode: 0o700});
    await cp(path.join(projectRoot, "fixtures", "base", "client-project"), clientProject, {recursive: true});
    git(clientProject, ["init", "--quiet"]);
    git(clientProject, ["add", "."]);
    git(clientProject, ["commit", "--quiet", "-m", "Scratch client project"]);

    const wrapper = path.join(sessionDir, "localdev");
    await writeFile(
      wrapper,
      `#!/bin/sh\nexport LOCAL_CLI_STATE_DIR=${shellQuote(stateDir)}\nexec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"\n`,
      {mode: 0o700},
    );
    const cliEnvironment = {
      LOCAL_CLI_STATE_DIR: stateDir,
      LOCALDEV: wrapper,
      CLIENT_PROJECT: clientProject,
    };
    await writeFile(
      path.join(sessionDir, "cli.env"),
      Object.entries(cliEnvironment).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n") + "\n",
      {mode: 0o600},
    );

    const readme = path.join(sessionDir, "README.txt");
    await writeFile(
      readme,
      [
        "localdev scratch world",
        "",
        "Run client commands in a subshell so the nested state dir stays out of your other commands:",
        `  (source ${path.join(sessionDir, "cli.env")} && cd "$CLIENT_PROJECT" && "$LOCALDEV" startup)`,
        `Client project: ${clientProject}`,
        `Nested state:   ${stateDir}`,
        `CLI under test: ${cliPath}`,
        "Client fixtures: base (api behind the fault proxy, web, seed, credentials), seed-fails (seed exits 1).",
        "Stop nested sessions ($LOCALDEV stop <id>) before stopping this one.",
        "",
      ].join("\n"),
    );

    return {
      services: [
        {
          name: "readme",
          command: process.execPath,
          args: [path.join(projectRoot, "fixtures", "base", "serve-readme.mjs"), String(listen.readme), readme],
          cwd: dataDir,
          readyPort: "readme",
          readyTimeoutMs: 15_000,
        },
      ],
      urls: {readme: `http://127.0.0.1:${ports.readme}/`},
    };
  },
};
