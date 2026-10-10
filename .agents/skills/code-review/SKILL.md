---
name: code-review
description: "The shared steps of one review lens: scope, judge, report, verdict. Use together with review-boundaries, review-regressions or review-frontend."
---

# Code review

You are one fresh job with one lens. Your lens skill says what to check. This
file says how to scope it, what counts as a finding, the exact shape of your
report, and what you hand back. `factory-workflow` defines the words and
labels; don't restate them.

You review. You don't fix, merge, change labels or widen scope.

## 1. Scope

You were given the repo, PR number, head commit, your lens, and for round two
onwards a link to your previous report. Read:

- the PR body, its issue, and the plan or ADR the issue cites
- human decisions quoted on them
- the parts of `CODING_STANDARDS.md` your lens names

Review the lines this commit adds or edits, plus callers whose behaviour it
changes. Existing code outside that is out of scope. If the PR has a
**Behaviour the human approved** section, you may require structural changes
but the feature must still do and look the same.

On a human-led PR there's no issue; the **Behaviour the human approved**
section is the scope and the acceptance criteria. If you can't review
(wrong base, no issue and no approved-behaviour section, the diff doesn't
match the commit, the head moved), return `needs-human` with one line on
why. `blocked` is only for waiting on another issue. Don't guess.

## 2. What counts as a finding

A finding names a rule it breaks, the changed line, the concrete impact and
the required outcome. The rule is one of: a rule in your lens skill, a section
of `CODING_STANDARDS.md`, an acceptance criterion in the issue, an ADR, or a
quoted human decision.

If you can't name the rule or the changed line, it isn't a finding. Put it in
one line under **Noticed, not mine** and move on.

Two levels:

- **required**: breaks a rule. Every required finding must be fixed or
  answered before you can clear.
- **optional**: within the rules, but you'd do it differently. At most five per
  report. Never blocks. The fix job may ignore them.

A failure path counts as a finding only when the issue or plan names it, it
worked on the base commit and breaks here, or a real user hits it through
normal use (double click, back, refresh mid-save, slow connection, deleted
data, wrong permissions). Behaviour the issue already accepts is never a
finding. Anything you suspect but can't show from the code goes under
**Edge cases to hunt**, one line each; a hunt job checks it without holding
the PR, and the owner never has to build tooling for it. Only list a hunt
when you genuinely can't tell from the code; if the diff shows it, it's a
finding, not a hunt. Read the hunt records already on the PR first and
don't ask again for a case checked on code that hasn't changed.

## 3. Report

Post exactly one comment on the PR. Round one:

```
Author: review-<lens> · <run id>
Review: <lens> · <commit> · round 1
Verdict: clear | findings | blocked | needs-human
Checked: <what you ran, one line>

Findings
<ID> [required|optional] <path:line> — <rule>. <impact>. <required outcome>.

Edge cases to hunt
- <one line each, or omit the section>

Noticed, not mine
- <one line each, or omit the section>

<your lens section, see below>

Retro
<up to three tagged lines, or omit the section>
```

Round two and later post only the delta:

```
Author: review-<lens> · <run id>
Review: <lens> · <commit> · round <n>
Verdict: clear | findings | blocked | needs-human
Fixed: <IDs, or none>
Open: <ID> — <one line on what's still wrong>
New: <ID> [required|optional] <path:line> — <rule>. <impact>. <required outcome>.

<your lens section, only if it changed>

Retro
<up to three tagged lines, or omit the section>
```

Rules for the shape:

- One line per finding. No recap of the PR, no restating the rule's text, no
  praise, no summary paragraph.
- IDs are `B1`, `R1`, `F1` by lens and never change or get reused. Round two
  reads the previous report and keeps its numbering.
- Verdict is `findings` when any required finding is open, `clear` when none
  is, `blocked` when you couldn't review, `needs-human` when it can't be
  fixed in place.
- Plain developer language. Say what's wrong and what would fix it.

Lens sections, one per lens, always under the same heading:

- regressions: **Test plan**, the browser steps the verifier runs
- boundaries: **Refactor issues opened**, links to follow-up issues
- frontend: **Visual checks**, one line per screen from the PR's screenshots, and `not shown` for any it couldn't find

## 4. Later rounds

Re-review against the new commit. Check only the open findings and the lines
the fix touched. Don't reopen settled points without new evidence, and don't
add new findings unless the fix itself created them.

The fix job may push back on a finding, citing a rule. Each round you decide:
fixed, still open with the reason, or withdrawn. Withdraw by listing the ID
under Fixed with "withdrawn" after it. When the bounce cap trips, the manager
rules on whatever is still disputed; that's not your call.

## Can't be fixed in place

When the change takes the wrong approach or doesn't do what the issue asked,
don't list twenty findings against it. Post one required finding citing the
acceptance criterion or plan section it misses, with the required outcome
`re-plan`, and return the verdict `needs-human`. The worker hands it to
the manager instead of fixing it.

## 5. Return

Your last line of output is one JSON object for the dispatcher, nothing after
it:

```
{"lens":"regressions","sha":"abc123","verdict":"findings","hunt":true}
```

`hunt` is true when your report lists edge cases to hunt; the hunt job reads
them from the report. Everything else the dispatcher needs it already has.

A round isn't always a new commit. When the fix job answered a finding
without changing code, the head is the same and the round number is one
higher; read the answer under the finding's ID and rule on it.

The dispatcher sets `verifier-ready` when every lens returns `clear` on the
same commit and checks are green. You never move labels yourself.
