---
name: issue-maker
description: Turn one agreed piece of work or one investigated bug into an issue a build job can start cold. Use when cutting issues from a plan or writing up a bug.
---

# Issue maker

One agreed piece of work, one issue, written so a fresh build job with no
memory of this conversation can start it. `factory-workflow` defines the
words and labels; don't restate them. You write issues; you don't change
code, start work or set status.

## 1. Confirm the work

Go on only when you can say, outside this conversation:

- what happens today and what should happen instead
- who or what it affects
- where the evidence or the approved decision lives
- what this one issue delivers

Planned work: read the approved spec or ADR and link the exact sections.
A draft or an agent's suggestion isn't a decision. A bug: check the
original evidence; a vague alert or a guess isn't enough.

A human decision goes in as `> Human decision, verbatim: "..."` with its
source, and your reading of it underneath, separately. Never quote a
paraphrase. If it conflicts with the spec, say so before anyone builds on
it.

Don't add features, fields, refactors or future-proofing nobody agreed to.
A technical concern doesn't authorise a product change.

## 2. Trace what's there

Read the code, schema, tests, docs and recent PRs. Record the branch and
commit you looked at; work on an unmerged branch isn't on the base.

Planned work: what exists, what changes, what another issue supplies.
Link the helpers and conventions the build job should reuse.

A bug: follow the evidence to the closest confirmed failure or one
concrete area. Say what you checked, what you ruled out, and where the
trace stops. "Root cause unknown" with nothing behind it isn't a trace.
When replay matters, gather the smallest pack: starting state, trigger,
saved external responses, actual vs expected, steps. Safe fixtures only,
never credentials or private user data; name what's missing.

Keep code reading, tests you ran, and another agent's claims apart.

## 3. Size it

One slice a verifier can check in a browser. A foundation issue can prove
auth and one private read without the whole feature. Mid-size is fine;
don't split by layer and don't glue unrelated things together to save on
issues.

Contracts are concrete: the shared types, functions, endpoints, inputs,
outputs and errors other issues consume, linked by file and export name.
If they aren't written yet, one issue owns writing them; dependents wait
on it and never invent their own. Two issues touching the same helper,
schema or component get an order or one owner.

## 4. Dedupe

Search open and closed issues and PRs by outcome, error signature, files
and plan links. Read strong matches; a similar title proves nothing. Work
that already has an open issue gets that issue updated and a one-line
comment on what changed; don't reset a `building` issue. A solved bug
that's back gets reopened only if the evidence says it's the same one.

## 5. Write it

Title: `<Feature> · <Type> · <outcome or problem in product words>`,
with the real error code when there is one (`React error 419`, never
`#419`, never one you made up). The labels say the same thing; the title
is for places labels don't show.
Labels: `feature:*`, `type:*`, `source:plan` or `source:human`, and `p2`
unless a priority was agreed. No status; triage sets it.

Body, optional sections left out when they add nothing:

````markdown
<!-- issue-maker:v3 -->
Author: <agent> · <run or thread>
Part of #<plan>
Depends on #<n>
Base: <branch> @ <commit you inspected>

## In plain words
Two or three sentences for the human, as `factory-workflow` says.

## What
What happens today, what should happen, who it's for.

## Decisions
> Human decision, verbatim: "..."  (source)
Your reading of it, underneath.

## Evidence
Source: <posthog | gcp-logs | email | human report | ...>
Links: <error group, session replay, log query, alert, PR discussion>
Window: <first seen → last seen> · Count: <n or Unknown> · Ongoing: <yes | no | Unknown>
What was inspected or run, by whom. Separate from the links.

## Scope
In. Out, explicitly.

## Acceptance
- [ ] <behaviour, checkable in the browser or by a test>
- [ ] <failure or permission case>

## Modules
- exampleOperation(arg1, arg2?)
  One plain paragraph: what it does, where it's used.
  - path/to/file.ts

## Contracts and current code
Types, functions and endpoints to use or publish, linked. Helpers to
reuse. For a bug: the trace, what was ruled out, where it stops.

## Shared changes
Files or contracts another issue also touches, with the owner or order.

## Reproduction
Starting state, trigger, saved responses, actual, expected, steps. What's
missing.

## How to verify
Fixture: <localdev fixture name, and whether it has the data this needs>
Browser: route, account, actions, what you should see.
Checks: tests, commands, emulator checks.

## Unknowns
What's still uncertain and whether it blocks starting.
````

The Acceptance list is the build job's whole scope and the regressions
lens's checklist; write each line so both can tell pass from fail.
Evidence links are for monitor-found bugs; planned features don't get
made-up counts or windows. The Fixture line is honest about data: if no
fixture holds the state that triggers the bug, say so, because the build
job treats a missing fixture as a blocker and won't build one mid-job. The
Modules section keeps the next agent from inventing a parallel structure:
few, complete operations over many tiny helpers, one file per shared
concern.
