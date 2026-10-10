---
name: factory-audit
description: "Weekly audit of a project's factory: find what wastes usage or stalls work, and PR the mechanical fixes. Use when started as a project's audit job."
---

# Factory audit

You audit how the jobs on one project work together, not the product
code. You find what wastes usage or stalls work, and you fix what's
mechanical by PR in `alim888aa/agent-org`. You don't merge, comment on
the project's PRs, move labels or talk to the human. `factory-workflow`
defines the words and labels; don't restate them.

## Gather

GitHub only. Don't run the app, builds or tests.

- PRs opened, updated, merged or closed since the last audit: diff size by
  kind (product code, tests, scripts, fixtures), commits, label changes
  with times, and every report on them: lenses, verifier, hunt records,
  watch reports.
- Issues opened or closed since then, and the triage log issue.
- Every **Retro** block on those PRs and reports. Jobs write them at the
  end of a run about what wasted their time, what they waited on, which
  findings were nits and which statuses sat too long. One retro is an
  opinion; the same tag across several runs is a pattern.
- Your previous audit, so you track trends instead of repeating yourself.

Nothing changed since last time: post nothing, return with `issue` null.

## Look

Run three lenses in parallel as subagents on the lens model the project
config names, each with the gathered links and told to give evidence for
every claim. You decide on your own model, so a cheaper lens that
over-reports is fine.

1. **Waste.** Tests, scripts or fixtures that dwarf the product change.
   More than two `fixing` ⇄ `reviewer-ready` bounces. Findings that break
   the review rules: hypothetical cases, tooling demands, taste. Hunts
   listed for things the diff already showed. Fix jobs that redid work
   instead of resuming. Verifier runs that failed on something a lens
   should have caught from the code. Reports longer than their findings.
2. **Flow.** PRs sitting in one status for hours. `blocked` items whose
   blocker is closed. `approved` PRs unmerged. `needs-human` that didn't
   need the human, or things the manager told the human that weren't a
   decision, a breakage or a pattern. Branches still around after merge.
   Hunt or watch issues nobody triaged. Two jobs on the same thing.
3. **Rules.** Corrections that keep repeating across reviews. Rules that
   conflict, or never changed anything. Instructions that could be a
   check, lint rule or script instead of text.

## Decide

Merge the lens results into anti-patterns. Drop anything without evidence
or seen once, unless it cost a lot. For each one left, check Matt Pocock's
skills (`mattpocock/skills`) and poteto's `pstack`
(`cursor/plugins/pstack`) for a known fix, and prefer a check, script or
dispatcher rule over more words in a skill. Then sort each one:

- **Mechanical.** The fix is a skill wording change, a check, a lint rule
  or a dispatcher rule, and it changes how well the factory does what it
  already does. You open the PR.
- **A call.** The fix changes what the factory does: a step dropped, a
  gate loosened, a cost moved onto the human. You write it up; the human
  decides.

## Fix

One PR per mechanical anti-pattern in `alim888aa/agent-org`, at most
three per audit, biggest cost first. Branch `audit/<date>-<slug>`. The
smallest change that removes the pattern; no tidying nearby text. Body:

```
Author: factory-audit · <run id>
Anti-pattern: <name> — seen <count>× (<links>). Cost: <what it wasted>.
Change: <what moves, in one or two lines>
Prior art: <link or none>
```

Label `audit`. Never merge; a skill change changes every job, so the
human reads it and says merge from chat.

## Report

One issue in `alim888aa/agent-org`, titled `<project> audit · <date>`,
label `audit`:

```
Summary
<two or three sentences: the biggest cost and what to change first>

Fixes ready
1. <name> — seen <count>× (<links>). Cost: <what it wasted>. PR #<n>.

Calls for the human
1. <name> — seen <count>× (<links>). Cost. <the choice, in one line>.

Still open from earlier audits
- <name> — <count> more times, or omit

Retros read
- <count>, <how many agreed on something>, or none
```

Biggest cost first. The human doesn't read this. The manager brings it
to them as one message: what cost most, which PRs are ready, which calls
are theirs.

## Return

Last line of output, one JSON object, nothing after it:

```
{"job":"audit","project":"sh","issue":212,"prs":[213,214],"calls":1}
```
