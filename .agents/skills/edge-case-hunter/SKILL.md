---
name: edge-case-hunter
description: Try to break the edge cases reviewers suspected but couldn't prove, after a PR is approved. Use when started on a PR with "Edge cases to hunt".
---

# Edge-case hunter

A reviewer wrote "I think this might break when X" and couldn't show it
from the code. Your whole job is to find out. `factory-workflow` defines
the words and labels; don't restate them. You hunt, you don't review the
PR, fix anything or move labels.

You run once per PR, after it's `approved`, and you have the emulator to
yourself. The PR doesn't wait for you; it may already be merged, in which
case you make a throwaway worktree at the merge commit on the branch it
merged into, say which commit in every record, and your records still go
on the PR.

## Read first

Every **Edge cases to hunt** list in the lens reports on the PR, and the
hunt records already there. Skip any case already checked on code that
hasn't changed since; say so in one line. Then take the rest one at a
time, in the order the lenses listed them.

## Hunt

1. **Say what "broken" would look like** before you start: the wrong
   value, the duplicate row, the stuck spinner. If you can't say it, the
   case isn't checkable; post that and stop.
2. **Try to make it happen.** Anything goes here that a reviewer couldn't
   do: a throwaway script, a fault injected in the fixture, a clock moved,
   a slow network, a hundred fake rows. Use existing fixtures and
   accounts; a hook or script you write lives in `.scratch/hunt/` in the
   PR's worktree and never gets committed. Never change the app's code to
   make the test easier.
3. **Three honest tries.** If it won't break after three real attempts at
   it, it's clean for now. Don't keep going; the point is a cheap answer,
   not proof.
4. **If it breaks, pin it.** The exact steps, the input, the commit, and a
   screenshot or the output. Once is enough if you can repeat it.

## Record

One comment per case on the PR, short:

```
Author: edge-case-hunter · <run id>
Hunt: <case, in the reviewer's words> · <commit>
Result: clean | broken | can't check
Tried: <one line per attempt>
Broken: <steps and evidence, only if broken>
```

A **broken** result also opens an issue: `type:bug`, `source:review`,
priority by impact, no status, the evidence in the body, and
`Found by hunt on #<PR>`. Triage takes it from there. The PR is never
held or reopened for this; if it's bad enough, set the issue `p0` and
triage will get it in front of someone.

**Can't check** means the case needs something that doesn't exist (a
fixture, an account, a service you can't fake). Say what, in one line.
Don't open a fixture issue; that's the regressions lens's job if it
matters for the Test plan.

## Return

Last line of output, one JSON object, nothing after it:

```
{"job":"hunt","pr":118,"sha":"abc123","hunted":4,"broken":1,"issues":[131]}
```

`issues` is empty when nothing broke.
