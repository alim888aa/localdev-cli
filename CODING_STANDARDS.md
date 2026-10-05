# Coding standards

Read [CONTEXT.md](CONTEXT.md) for the vocabulary. Name things with its terms.

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

Rules:

- Keep the adapter contract project-neutral. Firebase, seeds and app checks
  belong in each project's adapter, not here.
- Read and change a receipt only through `state`. Never write a receipt you
  read outside the state lock.
- Compare process births only through `process-table`.
- Run synchronous commands only through `run-sync`.
- Expose the smallest API that completes a caller's job; keep retries, lock
  phases and platform backends inside the owner.

## Behavior

- Fail closed on process ownership: never signal or stop a process whose
  identity can't be verified.
- Never hold the state lock through a readiness wait or a slow shutdown,
  except where the lock is already held by design (replacing a session).
- Status output never includes service env, specs or credentials.

## Checks

- Build first, then run `node --test --test-concurrency=1 test/*.test.mjs`.
- Tests wait on observable state (status fields, proxy state, a settled
  promise), never a fixed wall-clock sleep.
- Unit-test pure modules from `dist/` without starting sessions; keep session
  tests in `cli`/`faults`.
- dist is tracked: rebuild it in the same commit as the source.

## Docs

- `README.md` is for people and agents using the tool; `docs/adapter.md` is
  the adapter contract; `docs/issues.md` covers filing issues.
- Record a decision in `docs/adr/` when it would otherwise get reargued.
- Whoever changes a concept updates `CONTEXT.md` in the same PR.
