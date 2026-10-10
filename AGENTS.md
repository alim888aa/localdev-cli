# localdev agent instructions

This repo uses pnpm (pnpm-lock.yaml) and commits `dist/`. Rebuild it with `pnpm build` (or `npx tsc -p tsconfig.json`)
and commit it with the source change.

Read [CONTEXT.md](CONTEXT.md), [CODING_STANDARDS.md](CODING_STANDARDS.md), [ERRORS.md](ERRORS.md) and
[DESIGN.md](DESIGN.md) before editing. Adapter-facing contracts are
in [docs/adapter.md](docs/adapter.md), decisions in [docs/adr](docs/adr). The repo is public: keep secrets, local paths
and private links out of code, tests, issues and PRs.

Run tests one at a time on a shared machine: build first, then `node --test --test-concurrency=1 'test/**/*.test.mjs'`. Wait
on observable state in tests (status, a response, a process), never on a fixed sleep.

Clean up after yourself: stop every session and process you started before you end a turn. The dispatch thread removes
a PR's branch and worktree when it merges or closes. Never remove another agent's worktree or one with uncommitted work.

## Factory

This is a dark factory project (agent-org, `factory.json` has `"owner": "agent"`): the `Factory · owner` T3 thread sits
in the human's seat for product calls, and `CONTEXT.md` lists the clients, what must never break, and the direction.
Labels hold the state; `factory-workflow` defines them. Each job follows one skill from `.claude/skills` (installed from
agent-org): the build and fix follow `worker`; each review lens follows `code-review` with `review-boundaries`,
`review-regressions` or `review-frontend`; proof follows `verifier`; hunts follow `edge-case-hunter`; the dispatch
thread follows `dispatch`; triage follows `triage`; the manager follows `manager` (and `upkeep` on Wednesdays,
`factory-audit` on Mondays); the owner follows `owner`, `council` and `researcher`.

The one check is `pnpm check` (typecheck, dist in sync, serial tests, source rules, dead code, ratchet). A worker
blocked on a failing check still pushes and says so in the PR.

localdev has no UI, so "browser proof" here means driving the built CLI against a scratch client project. Fixtures
(`localdev startup <name>`, adapter in `local.adapter.mjs`): `base` is the default. Build first with `pnpm build`, then
`node dist/cli.js startup base`. It makes a scratch client project with its own adapter (fixtures `base` and
`seed-fails`, a proxied `api` port for faults) and an isolated state directory, and writes `<sessionDir>/cli.env`.
In a subshell, `source` that file, `cd "$CLIENT_PROJECT"` and run `"$LOCALDEV" startup|status|fault|stop`: that runs
this checkout's build and never sees the machine's real sessions. Stop the nested sessions before the outer one.

A change clients need doesn't reach them on merge. Say in the PR which clients need a re-pin (see **How a fix reaches
clients** in `CONTEXT.md`); the owner arranges it.
