# localdev agent instructions

This repo uses pnpm (pnpm-lock.yaml) and commits `dist/`. Rebuild it with `pnpm build` (or `npx tsc -p tsconfig.json`)
and commit it with the source change.

Read [CONTEXT.md](CONTEXT.md) and [CODING_STANDARDS.md](CODING_STANDARDS.md) before editing. Adapter-facing contracts are
in [docs/adapter.md](docs/adapter.md), decisions in [docs/adr](docs/adr). The repo is public: keep secrets, local paths
and private links out of code, tests, issues and PRs.

Run tests one at a time on a shared machine: build first, then `node --test --test-concurrency=1 test/*.test.mjs`. Wait
on observable state in tests (status, a response, a process), never on a fixed sleep.

Clean up after yourself: when your PR merges or closes, remove its worktrees (yours and its QA artifact) and the merged
local branch, and stop any processes you started. Never remove a teammate's worktree or one with uncommitted work.
