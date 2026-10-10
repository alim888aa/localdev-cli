---
name: review-regressions
description: Review a change for broken behaviour and data, and write the Test plan the verifier runs. Use when you're the regressions lens on a PR.
---

# Regressions lens

Follow `code-review` for scope, what counts as a finding, the report shape
and the return line. Your lens is whether what worked before still works,
whether stored data stays clean, and whether the change does what its issue
says. Your finding IDs are `R1`, `R2`, …

You read and think through the code, run the automated tests, and when the
change touches the backend you trace it against the emulator. You don't
drive a browser. Anything that has to be proven in the real app goes into
the Test plan.

Read the project's `CODING_STANDARDS.md` sections on errors and checks,
`ERRORS.md`, and the data model in the plan or ADR the issue cites.

## Check

1. **Acceptance criteria.** Walk each one in the issue against the code and
   the PR's **Tested** list. Missing or partial is a finding citing the
   criterion.
2. **The one fact.** Most changes that look risky are safe because of one
   fact, such as "this only touches rows already marked deleted". Find it,
   state it in your report under **Safe because**, and say how sure you
   are: you pointed at the line, you walked the failure path and it can't
   reach, or you ran code that proves it. If you can't find such a fact,
   say so; that's a signal, not a finding.
3. **Callers.** For every changed export, shared module or entry point, list
   the callers and check each still gets the behaviour it relies on.
4. **Navigation and state.** When navigation, forms or shared UI change,
   check every way a user reaches and leaves the screen. Never a stale or
   stuck state.
5. **Data.** Writes keep stored data consistent with the approved model. A
   new, renamed or removed field or collection, a changed type or meaning,
   or data written in a new shape that the plan or ADR didn't approve is a
   required finding, as are records left behind by failures, and it's
   `needs-human` territory if the plan didn't
   approve it. Seeds and fixtures must match the model too.
6. **Failure paths.** Permissions, missing or deleted data, retries and
   duplicate requests, only where the issue names them or the change
   creates them. Every error follows a pattern from `ERRORS.md`; a plain
   throw or a swallowed error in changed code is a finding.
7. **Tests.** Run the suites the change touches. Require tests only for
   behaviour the issue asks for or the change alters, through the public
   API, and no helpers or fixtures beyond what those tests need. A test the
   change edited to make it pass is a finding.
8. **Trace it.** When the change touches server actions, functions, data
   writes, rules, indexes or queries: start the fixture the issue names with
   `localdev`, run the project's emulator suite, and call the changed entry
   point directly with a throwaway script in `.scratch/regressions/`. Prove the
   one fact and inspect what got stored. Existing fixtures and accounts
   only; no fault injection, no new hooks, no new fixtures. Say what you
   ran under Checked, stop the fixture, and delete the script. A UI-only
   change skips this step.

## Test plan

Your lens section is **Test plan**: the browser steps the verifier runs.
Start from the PR's Tested list, then add what your reading turned up:
neighbouring flows, failure paths, and data to inspect afterwards. Keep it to
what this change could break.

Each step names the fixture, the account, what to do, the width (390, 1440
or both), and what should happen:

```
Test plan
1. messages fixture · collector A · send a message at 390 → toast "Sent", message appears in the thread
2. same · refresh mid-send → no duplicate message, no stuck spinner
3. after 1 · inspect messages collection → one document, fields per ADR 7
```

Every step must run in the real app through normal UI. A step that would
need fault injection, a test-only hook or a new script goes under **Edge
cases to hunt** instead.

A step that needs a fixture, account or data that doesn't exist yet is
different: write the step anyway, mark it `needs fixture`, and open a
fixture issue (`type:maintenance`, `source:review`, no status) saying
exactly what's missing and why the plan needs it. Put
`Blocked by #<fixture issue>` on the PR; the dispatcher sets it `blocked`
and brings it back once the fixture lands. Your review goes on as normal.
Never build the fixture yourself.

On a human-led PR, the plan is the approved flow, and only when the change
touches UI or a user flow.

In later rounds, repost the Test plan only if it changed; an unchanged
plan from an earlier round stands, and the verifier reads the latest one
on the PR.

## Not your lens

Module shape, naming, styling and SEO belong to other lenses. One line under
**Noticed, not mine**. Don't chase failures the changed code can't reach.
