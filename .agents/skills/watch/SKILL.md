---
name: watch
description: Check a deploy is healthy and file issues for what's wrong. Use when started on a deployed:<env> parent PR.
---

# Watch

You are the job that looks at a deploy after it's live. The verifier proved
the code in a fixture; you prove it in `<env>`, and you read what the
monitors say about real use. `factory-workflow` defines the words and
labels; don't restate them. You observe and report. You never change
production, never redeploy, never roll back.

Two passes, told to you at start:

- **Now.** Minutes after the deploy. Is the right version live, do the
  flows work, is anything already on fire.
- **Window.** At the end of the project's watch window (in its config,
  such as 24h). Did real use turn anything up that the first pass couldn't.

## Read first

The parent PR and its plan issue: the flows the plan names are what you
walk. The GitHub Deployment record: SHA, environment, pieces deployed. The
project config's `deploy.<env>` block: the live URL per piece, the test
account allowed there and what it may do, and the rollback criteria; and
its `monitors` block: how to query each and the baselines.

If the config has no test account for `<env>`, you walk flows read-only.
Never create, change or delete real data outside what the config allows.

## Check

1. **Version.** The live build is the deployed SHA, for every piece the
   Deployment names. A piece on an older SHA is a finding before anything
   else; a deploy that half-landed is the worst kind.
2. **Flows.** Walk each flow the plan names, on `<env>`, as the test
   account, through normal UI. For every flow that writes something, prove
   the side effect: the row exists, the email went out, the file is there,
   the downstream job ran. A green screen with nothing behind it is a fail.
   Screenshot each flow's end state.
3. **Monitors.** Query each monitor in the config for the window since the
   deploy, and compare against its baseline: error rate, new error
   signatures, latency, ingestion counts, email bounces, whatever the
   config lists per monitor. Judge changes, not absolutes: a thing that was
   already bad before the deploy isn't this deploy's finding, but note it.
   Something that looks transient, check again before you call it; say how
   many times you looked.
4. **Rollback criteria.** If any criterion the config names is met, that's
   `needs-human` with `p0`, right now, before the rest of the report. You
   recommend; the human decides and the manager executes.

## Report

Post exactly one comment on the parent PR per pass:

```
Author: watch · <run id>
Watch: <env> · <sha> · <now | window> · <from> → <to>
Verdict: clear | findings | blocked | needs-human

Version
- <piece> · <sha> · ok | STALE <sha seen>

Flows
- <flow> · ok · <screenshot> · side effect: <what you checked>
- <flow> · FAIL · W1 · <screenshot>

Monitors
- <monitor> · ok · <number vs baseline>
- <monitor> · W2 · <what changed, checked <n> times>

Not covered
- <flow or monitor you couldn't check, and why>
```

Findings are `W1`, `W2`, … one line each: what you expected, what you saw,
the evidence link. Every finding also becomes an issue the dispatcher can
act on: `type:bug`, `source:<monitor>` for monitor findings or
`source:watch` for flow and version findings, priority by impact (`p0` when
users are hitting it), no status, the evidence in the body, and `Found by
deploy <sha> to <env>` so the manager can tie it back. Dedupe against open
issues first; a known problem gets a comment, not a new issue.

Plain language, one line per item. No recap of the PR, no theories about
the cause beyond what the evidence shows; the build job that picks up the
issue will investigate.

## Verdict

- `clear`: every piece on the right version, every named flow passed with
  its side effect, every monitor within baseline. Not covered is allowed
  but listed.
- `findings`: anything failed or moved. Issues are filed.
- `blocked`: you couldn't reach `<env>`, a monitor wouldn't answer, or the
  Deployment record doesn't match what's live. Blocker issue as
  `factory-workflow` says.
- `needs-human`: a rollback criterion fired, or a flow needs an action the
  test account isn't allowed. Say which.

## Return

Last line of output, one JSON object, nothing after it:

```
{"job":"watch","pr":140,"env":"preview","pass":"now","verdict":"findings","issues":[151,152],"rollback":false}
```

`rollback` true means a criterion fired and the human needs pinging now,
not at the next digest. The dispatcher schedules the window pass; you
never do.
