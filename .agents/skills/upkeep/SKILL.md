---
name: upkeep
description: "Weekly cleanup of a dark project: delete leftovers, file bloat as issues. Use when the manager's weekly schedule started you."
---

# Upkeep

Nobody watches a dark project, so nobody notices it bloating. You do.
Every job already cleans its own mess; you catch what slipped through and
what builds up slowly. `factory-workflow` defines the words and labels,
and its **Dark projects** section has the hard lines.

## What you may delete

Delete freely anything git or a rerun can bring back. Something that
can't come back goes only when the factory made it and it's past
`upkeep.keepDays` in `factory.json` (default 14) or nothing open links to
it. Never client or user data, never `main`'s history, never keys or
secrets. Never anything a running thread is using: check `t3_thread_list`
first, and leave alone whatever sits under a busy thread's worktree.

When you're not sure whether something is the factory's, leave it and
say so in your report.

## Remove directly

No PR, no issue; just do it and count it:

- **GitHub:** branches whose PR merged or closed; branches with no PR
  and no commit for `keepDays`, once their commits are on another branch
  or their issue is closed. Never the default branch, a branch an open
  plan names as its `Feature branch:`, or one an open PR merges into.
  Also Actions caches and artifacts, draft and old pre-releases, and
  labels outside the `factory-workflow` set that no issue or PR, open or
  closed, has ever carried.
- **The laptop:** worktrees whose branch is gone or merged and that hold
  no uncommitted work; `node_modules`, build output and caches inside
  them; `.scratch/` folders of finished jobs; `localdev` sessions and
  stray processes started from a worktree no live thread owns.
- **T3:** settled `Factory ·` threads older than `keepDays`; scheduled
  tasks that point at a skill or thread that no longer exists.
- **The cloud:** recordings and shares, preview deploys, old Worker or
  function versions and storage objects the factory created and nothing
  open links to. Keep the version that's live and the one before it.

## File as issues

Anything that changes the repo goes through the factory: one issue each,
`source:upkeep`, no status, so triage takes it. Bundle what one job would
fix together.

- **Code:** dead code and unused exports and dependencies (run knip),
  duplicate helpers, files over the project's limit, comment bloat,
  tests that prove nothing, edge cases handled that can't happen.
  `type:refactor`.
- **Dependencies:** security fixes (`p1`), and majors that are behind
  with a clear upgrade path. `type:maintenance`.
- **Checks:** flaky tests (failed then passed on the same head in the
  last week), checks that take far longer than they did.
  `type:maintenance`.
- **Docs and rules:** docs that don't match the code anymore, agent
  instructions and standards that grew a rule nobody follows or two rules
  that say the same thing. `type:docs`.

## Propose to the owner

Removing a feature is a product call. A feature no client uses (no
caller in the code or in the clients' skills and scripts, no feedback
issue mentioning it in 90 days, nothing in the project's monitors) gets
one issue: `type:refactor`, `source:upkeep`, status `needs-human`, with
the evidence for "nobody uses it" and what deleting it removes. The owner
takes it to the council.

## Report

One comment on the project's `Triage log` issue:

```
Author: upkeep · <run id>
Removed: <n> branches, <n> worktrees (<size>), <n> threads, <n> cloud objects, ...
Filed: #<n>, #<n>
Proposed: #<n>
Left alone: <what you weren't sure about, one line each, or none>
```

## Return

Last line of output, one JSON object, nothing after it:

```
{"job":"upkeep","removed":31,"freedMb":2400,"issues":[70,71],"proposals":[72]}
```
