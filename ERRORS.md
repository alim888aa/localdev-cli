# Errors

How localdev responds when something fails. Two layers:

- **Patterns** are the few ways the CLI responds to a failure. They're listed
  below. Only the human adds or changes a pattern.
- **Error types** are the specific failures, such as a seed that exits 1 or a
  session that was stopped during startup. They live where **Project** says,
  and each one says which pattern it follows. Agents add types freely as long
  as each uses an existing pattern.

Never decide error handling from scratch. Sort the failure into a type, and
the type's pattern decides what happens. The `error-handling` skill has the
procedure; the regressions lens and the checks hold code to this file.

## Rules

- Wrap every call into an outside program or service (Git, `gh`, `lsof`, the
  adapter, child processes) where it enters the code, and turn its failures
  into error types. Code inside the CLI handles only types.
- At every entry point (each CLI command, the supervisor, the proxy process,
  the adapter's `createSession` and seed) every expected error type is
  handled. Each entry point also catches anything unexpected and sends it to
  the alert channel as an unknown error; every unknown error is a candidate
  for a new type.
- A failure stops only the smallest piece it breaks. One bad item skips that
  item, not its batch, its run or the page.
- The human hears about anything skipped or stopped, through the alert
  channel, with the type, pattern, item and details, never private data. A
  silent skip is a hidden error.
- Auto-fix only when there's exactly one right answer and it's easy to undo.
  Otherwise skip and alert.
- Never turn an error into success or an empty result. Every fallback, retry
  or compatibility path states its reason.
- No plain `throw` and no generic `new Error` in enforced folders; the checks
  enforce this and ratchet it elsewhere.

## Patterns

| Pattern | When | What happens |
| --- | --- | --- |
| `fail-request` | the user's own action can't complete (bad input, no permission, not found) | the request fails with a message the user can act on; nothing is retried or alerted |
| `retry-then-alert` | a transient failure from an outside service | retry per the type's limit (default 3 tries, backing off), then alert and fail the piece |
| `skip-and-alert` | one item in a batch is bad | skip that item, keep the batch going, alert with the item |
| `stop-and-alert` | the failure breaks every item (missing key, changed schema, quota gone) | stop the whole run, alert, leave what finished in place |

A failure that fits none of these gets handled with `skip-and-alert` for now,
and a pattern proposal opened as the `error-handling` skill says.

## Project

- **Error style:** `new Error(message)` almost everywhere, thrown up to one
  entry wrapper: the `main().catch` in `cli`. It prints only `error.message`
  to stderr and sets exit code 1. There is no other exit code, no stack and no
  JSON error. Small error classes are used to branch in code: `SessionGoneError` (`state`), `DuplicateSessionError` and
  `StartupStoppedError` (`session`), `NotPublishedError` (`issue`), and `StartupPortCollisionError` (`launch`,
  `retry-then-alert` for startup).
  `run-sync` attaches `code`, `status` and `stderr` to the Error it throws.
- **Errors module:** none. A typed error lives beside the owner that throws it
  (guess). Messages say what to do next where the CLI knows (for example
  "Use --replace [ID] or --parallel").
- **Alert channel:** nothing is notified for you; whoever ran the command
  hears. Foreground: the stderr message and exit 1. A session that fails or
  degrades keeps the story on disk: receipt `state` (`failed`, `degraded`),
  its `error` field, each process's `commandExit`, and the logs in
  `~/.local/state/local-cli/sessions/<id>/` (paths are under `logs` in
  `status`). `status` also shows `proxy: "unreachable"` and `outboundRefused`.
  For a bug in the shared CLI, agents file `localdev issue bug --submit`
  (docs/issues.md); a bug in a project's adapter goes to that project.
- **Extra patterns:** none.
- **Retry limits:** startup retries a failed app/web readiness wait only when
  that port has an unrelated listener, with at most three complete startup
  attempts and no backoff. Before reallocating it verifies all owned processes
  stopped and removes the abandoned session and adapter cleanup paths. It
  regenerates the adapter plan on the new allocation; replacement stops the
  selected old session only once. Adapter, seed and other service failures do
  not retry. Other waits have time limits,
  then the piece fails: state lock 60 s, service readiness 60 s
  (`readyTimeoutMs`), seed 5 min (`seed.timeoutMs`), stop 4 s of SIGTERM then
  2 s after SIGKILL, proxy control 2 s (1 s for `status`).
- **Enforced in:** none for now. `throw new Error(` in `src/` is ratcheted by
  `pnpm check` (rule `errors/generic-throw`, count in
  `scripts/checks/baseline.json`); it may only go down.

### Entry points

- Each command (`startup`, `status`, `stop`, `fault`, `issue`, `help`):
  `main().catch` in `cli`. `args` rejects unknown flags before any session is
  read or changed.
- `startup` after the session is reserved: its own catch stops what it
  launched, removes the adapter's `cleanupPaths`, marks the session `failed`
  with the error, and throws `Session <id> failed: <reason>. Logs: <dir>`.
- Supervisor: no catch. A command that can't start or exits is written to its
  exit file, which the CLI reads. A supervisor that dies leaves the CLI to
  report it exited before its port was ready.
- Proxy process: control requests answer `{ ok: false, error }`. Connection
  errors on proxied traffic are the fault itself (a reset) or ignored on
  purpose. A startup error is not caught, so the process dies and the CLI
  reports it like any service that exited before ready.
- Adapter: `import()` is not wrapped, so a syntax error or missing file shows
  Node's own message; a wrong shape is `Invalid adapter: <path>`. Whatever
  `createSession`, `cleanupPaths` or the seed throws or exits with fails the
  startup as above.

### How outside things are wrapped

- **Git:** `checkout` turns any failure into a `null` commit, shown as
  `unknown`. Reason: not every checkout is a Git repo.
- **`gh`:** `issue` is the model wrapper. A definite refusal (no `gh`, not
  logged in, HTTP 4xx) prints the draft and a link, then fails. An unclear
  result looks for the created issue; if it can't tell, it says "outcome
  unknown, check before retrying" and never posts twice.
- **Processes and signals:** `process-table` and `listener` return `null`,
  `false` or `[]` when `ps`, `/proc` or `lsof` fail, and `supervised`
  treats "can't verify" as not owned, so stop fails closed and keeps the
  receipt. A signal that fails with ESRCH means gone; any other failure means
  "may still be running".
- **Ports and the lock:** a port that can't be bound is skipped; after 1000
  tries startup fails with `Unable to reserve a port for <name>`. A taken lock
  port waits, then names `LOCAL_CLI_LOCK_PORT` in the error.
- **Receipts:** a missing receipt is "gone" (`SessionGoneError` or `null`);
  any other read error throws.

### The patterns here

| Pattern | Cases in this CLI |
| --- | --- |
| `fail-request` | bad or unknown flag, missing value, missing or invalid session ID, bad `--ms` / `--count`, duplicate session without `--replace` or `--parallel`, replacing a session that isn't healthy and ready, a fault on a session that isn't ready or a port that is unknown or busy, a wrong adapter shape, a missing issue field. Message on stderr, exit 1, nothing changed. |
| `stop-and-alert` | startup failing after reservation (seed fails or times out, a service exits or never listens, the adapter throws, ownership can't be verified); a stop that can't verify a process (receipt kept as `failed`); a `fault --mode kill` service that doesn't come back. Everything started is stopped, finished state stays for inspection, exit 1. |
| `retry-then-alert` | an app/web startup port taken by an unrelated listener (`StartupPortCollisionError` in `launch`): retry the whole allocation up to three attempts, then fail startup with the reason and logs. Also the time-limited waits above, which end in a failure naming the log (guess: a deadline wait counts as this pattern). |
| `skip-and-alert` | none today. The nearest cases are silent, see the open questions. |

### Known gaps

Each breaks a rule above. Fix it when you touch that code; nobody adds a new one.

- a wrong fixture name. The adapter throws it from
  `createSession`, after the session is reserved, so the user's typo ends as a
  `failed` session kept until `stop` (`stop-and-alert`) instead of a clean
  `fail-request`.
- unexpected errors look like expected ones. Every failure is
  one stderr line and exit 1, so an agent can't tell "you used it wrong" from
  "localdev broke, file a bug".
- an unknown session ID. `status` and `stop` report it as
  success (`gone`, `alreadyGone`, exit 0), `fault` fails with a clear message,
  and `issue --session` surfaces a raw `ENOENT` error.
- silent skips. `status` drops a receipt it can't read, and
  outbound refusal lines it can't parse are ignored, with no alert for either.
- `lsof` failing (missing binary) returns no listeners, which
  looks the same as "nothing listens".
- `stop` gives up on the first process it can't verify and does
  not try the session's other processes (`stop-and-alert`), where
  `skip-and-alert` would stop the rest and report the one left behind.
- bad input is reported three ways: the whole usage line
  (`usageError`), `Unknown <command> option` with a help hint, and a specific
  sentence.
