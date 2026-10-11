# Coding standards

Read [CONTEXT.md](CONTEXT.md) for the vocabulary. Name things with its terms.
localdev is a Node/TypeScript CLI with no UI, so the React and styling rules
of the factory base don't apply here. The **Project** section at the end wins
over the general rules above it. Some existing code still needs cleanup to
meet these rules; reviewers judge the lines a change adds or edits, not the
whole repo.

## Where code belongs

- `src/` holds one file per owner (the list under **Shape**). `src/cli.ts` is
  the only entry a user runs. `supervisor`, `guard`, `proxy-process` and
  `outbound-preload` are started by path as their own processes; nothing
  imports them.
- Imports flow down: `cli`, then `session` / `fault` / `issue`, then `launch`,
  `proxy` and `adapter`, then `supervised` and `state`, then `listener`,
  `process-table`, `temp-dir`, `run-sync` and `checkout`. A lower owner never imports a
  higher one.
- `test/` holds the tests and their fixtures; a suite with its own fixtures gets
  a subfolder. `dist/` is generated.

## Shape

Aim for deep modules: a small interface that hides a lot of behavior. Before
adding or keeping a module, apply the deletion test: if deleting it would push
its complexity into several callers, it earns its place; if it would only move
a few lines, inline it.

Give each concept one owner. The current owners are:

- `cli`: parse arguments, call the owner, print JSON. No session logic.
- `args`: the one argument parser. Unknown flags are rejected before any
  session is read or changed.
- `help`: every usage and help text.
- `session`: the session lifecycle (start, stop, describe), duplicate matching
  and session health.
- `state`: the state directory, receipts and their locked read-modify-write,
  session IDs, port reservation.
- `adapter`: loading an adapter and checking its plan (docs/adapter.md).
- `checkout`: a checkout's canonical path and Git commit.
- `launch`: the one two-phase launcher for services, the proxy and restarts.
- `supervised`: owned process groups: spawn, readiness waits, stop, health,
  and signalling a recorded process.
- `process-table`: process facts and births, the one parent-chain walk, and
  the one PID-exists check.
- `listener`: who listens on a port, and which listeners are owned.
- `fault`: every fault mode, its validation, records and views.
- `proxy` / `proxy-process`: the fault proxy's launch shape and control
  client, and the proxy process itself.
- `outbound` / `outbound-preload`: the outbound policy.
- `run-sync`: the only synchronous command runner (see its comment for why).
- `issue`: drafting and filing localdev issues.
- `temp-dir`: session temp dirs in `/tmp`: their names, identity markers, and
  the proof every removal of one needs (stop's and the orphan sweep's).

Rules:

- Keep the adapter contract project-neutral. Firebase, seeds and app checks
  belong in each project's adapter, not here.
- Read and change a receipt only through `state`. Never write a receipt you
  read outside the state lock.
- Compare process births only through `process-table`.
- Run synchronous commands only through `run-sync`.
- Expose the smallest API that completes a caller's job; keep retries, lock
  phases and platform backends inside the owner.

## Front doors

Each owner's exports are its front door. Other modules call those exports and
never reach into the owner's internals or its files on disk.

- Callers ask for a complete action (`startSession`, `stopSession`,
  `applyFault`). The owner handles validation, duplicates, locking, cleanup
  and recoverable failures. `cli` only parses and prints.
- Keep distinct actions explicit (`--release` and `--clear`, `start` and
  `stop`) so a retry can't toggle state.
- Don't add wrappers that only pass a call along, or an abstraction with one
  implementation. Avoid modules that import each other; move the shared piece
  to the owner.
- Keep the rules for each behavior in one module. Before adding a function,
  check whether one already does the job and extend it when that makes sense.
- Test through the owner's exports, not its private helpers.

## Keep complexity down

Start with the simplest change that does what we need. When cleaning up, look
for things to remove or combine before adding another layer.

- Keep each decision in one place. Callers reuse the result instead of
  repeating the same validation or retry rule.
- Keep call chains short. If one operation means opening several files that
  only hand work to the next, collapse those steps.
- Before passing another yes/no option through several functions, find the
  owner of the decision and let it decide.
- Keep state close to its owner. Derive values from existing state instead of
  storing a copy that must be kept in sync.
- Add options and flags only when real code needs them.
- Handle the failures the issue names, the ones your change breaks and the
  ones a real user can hit through normal use. Don't add code, tests or
  fixtures for combinations beyond those.
- Use early returns to reduce nesting. Write steps out when squeezing them
  into one expression makes them hard to follow.
- No unused code. Delete files, exports, functions, types, scripts and
  dependencies that nothing uses, including code your change leaves unused.
  Git history keeps it. Before deleting, check every caller, including tests,
  scripts and the files started by path.

## Files and folders

- Keep each new handwritten file under 300 lines, tests and scripts included.
  An existing file over the limit may not grow; when you edit one, say so and
  clean up the part you're changing.
- Keep at most ten handwritten files directly inside a folder.
- Split by what the code does. Don't dodge the limits with pass-through
  helpers, numbered chunks or folders with no clear purpose.
- Name files after their purpose, never a milestone number.

## Behavior

- Fail closed on process ownership: never signal or stop a process whose
  identity can't be verified.
- Never hold the state lock through a readiness wait or a slow shutdown,
  except where the lock is already held by design (replacing a session).
- Status output never includes service env, specs or credentials.
- Never delete outside a session's own paths (`cleanupPaths` must be
  ID-scoped in the project root). The one exception is a proven session temp
  dir (CONTEXT.md), removed only through `temp-dir`.
- Keep adapter and receipt changes additive: an older adapter or receipt must
  keep working (docs/adapter.md).

## Comments and names

Name things after what they do, in the project's words. Good names carry most
of the meaning, so comments stay few and short.

- An exported operation or type gets a short JSDoc (`/** ... */`) saying what
  the caller gets, what it expects and what it guarantees. Internal helpers
  usually need none.
- Use `//` only for a reason the code can't show: a limit, a workaround or a
  surprising choice.
- Never restate the code, narrate history ("changed from X") or leave
  commented-out code.
- When you change code, update or delete every comment it makes wrong. A stale
  comment is a bug, and reviewers treat it as one.

## Errors

Follow [ERRORS.md](ERRORS.md): every failure sorts into one of its patterns,
and the pattern decides what happens. Don't convert untouched code just to
switch styles.

Handle a failure where the code can do something useful about it. Keep enough
detail to debug it without exposing private data (no env, credentials or home
paths in a message that can be filed publicly). Never turn an error into
success or an empty result. Every fallback, retry or compatibility path needs
a stated reason. Check untrusted input where it enters (arguments, adapter
output, receipts from older versions), then stop re-checking cases that can no
longer happen; keep checks that protect process ownership, stored data or the
state lock.

## Checks

The one command is `pnpm check`. It runs the typecheck, confirms `dist/`
matches the source, runs the tests one at a time, applies the strict source
rules from the Rules lists above, runs knip for dead code, and compares the
ratchet counts to `scripts/checks/baseline.json`. A strict rule fails on any
finding; a ratchet count may only go down. Never weaken a check, add a
suppression or raise the baseline to pass.

The check also rejects new private-storage test assertions, upward owner
imports, process-entry imports, import cycles and folder growth against an
explicit Git merge-base. See [Checker comparisons](docs/checks.md) for base
selection, finding identities and the static analysis limits.

- Build first, then run `node --test --test-concurrency=1 'test/**/*.test.mjs'`
  (`pnpm check` does both).
- Tests wait on observable state (status fields, proxy state, a settled
  promise), never a fixed wall-clock sleep.
- Unit-test pure modules from `dist/` without starting sessions; keep session
  tests in `cli`/`faults`.
- dist is tracked: rebuild it in the same commit as the source.
- Pick checks that would catch what this change could break, including
  failures. When you change a shared owner, check the commands that use it.
- Before finishing, reread your diff for unnecessary complexity: comments that
  repeat code, redundant checks, catches that hide errors, casts that hide type
  errors, extra nesting, and wrappers or options without a job.
- Say what you checked, what failed and what you couldn't check. Before
  calling a failure pre-existing, reproduce it on the original version.

## Docs

- `README.md` is for people and agents using the tool; `docs/adapter.md` is
  the adapter contract; `docs/issues.md` covers filing issues.
- Record a decision in `docs/adr/` when it would otherwise get reargued.
- Whoever changes a concept updates `CONTEXT.md` in the same PR.
- The CLI's output conventions are in [DESIGN.md](DESIGN.md).

## Project

- **Layers:** the owner modules under **Shape**, in the import order under
  **Where code belongs**. There are no `app`, feature or shared folders.
- **Approved effects:** none. There is no React here, so
  `useEffect` / `useMemo` / `useCallback` never come up.
- **Exempt folders:** `dist/` is generated (tracked, rebuilt with the source).
  `node_modules/` is installed.
- **Entry files started by path:** `supervisor`, `guard`, `proxy-process` and
  `outbound-preload`. knip treats them as entries (`knip.json`).
- **File limits today:** `src/` holds 22 files, over the ten-file folder
  limit, and `session`, `fault` and `issue` are over 300 lines. They may not
  grow; a new file in `src/` needs a new owner.
