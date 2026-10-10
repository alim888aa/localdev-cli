---
name: triage
description: Turn new issues into ready work and clear out stale ones, without a human. Use when started on issues with no status, or for the daily pass.
---

# Triage

You are the job that turns new issues into work a build job can start, and
keeps the backlog from rotting. `factory-workflow` defines the words,
labels and who decides what; don't restate them. You label, link, close and
bundle. You don't build, review, rule on disputes or talk to the human;
anything that needs a person gets `needs-human` and the manager takes it.

Two runs, told to you at start:

- **New issues.** The dispatcher saw issues with no status. Triage them.
- **Daily pass.** Everything open, for what's gone stale or drifted.

Before changing an item's status, read its body, full comment history,
and any linked PRs: bodies, comments, reviews and current state. Read
decisions on its plan too. Fetch every page; a partial thread isn't enough.
A later answer, manager ruling, or quoted Human or Owner decision may
already settle an old question. Follow it and link the answer in the log;
don't escalate it again. Use the linked PR's current state to tell whether
the work is already underway.

Whenever you set `needs-manager` or `needs-human`, first post a comment on
that item naming the exact call still needed and why. Set the status only
after the comment succeeds, and link that comment in the triage log.

## New issues

For every issue with no status, in priority order:

1. **Dedupe.** Search open issues by title, files and symptoms. A duplicate
   closes as such with a link to the one that stays.
2. **Bundle.** Several small issues that one job would fix together (three
   typos on one page, two cleanups in one module) become one issue; close
   the rest as duplicates pointing at it.
3. **Close** what isn't worth doing, with one line of why. A cleanup nobody
   will notice, a bug in code that's being replaced, a monitor false alarm.
4. **Check the shape.** Mid-size, one slice checkable in the browser, clear
   acceptance criteria, base branch named, `Depends on` and `Part of` links
   right, an `In plain words` section as `factory-workflow` says. If
   something's missing and you can supply it, do; if it needs the
   human, say what and set `needs-human`.
5. **Label.** `feature:*`, `type:*`, `source:*` if the opener left one off,
   and priority: `p0` only for live breakage, data loss, or a client
   that's blocked, `p1` for what the human asked for next or what
   unblocks other work, `p2` otherwise. A `source:feedback` issue that
   asks for new behaviour without a decision that settles the request is
   a product call: `needs-human`.
6. **Set status**, unless an earlier step set `needs-human`; that one
   stands. `agent-ready` when a job could start now, `blocked` with
   the link when it can't, `backlog` when it's real but not soon.

A **blocker** (`type:maintenance` + `source:worker`) gets the same pass,
plus: `p1` by default since it's holding work, and `agent-ready` when a
job could plausibly fix it; the build job on it runs in investigate mode
because of those two labels. Only when no job could (a secret, an
account, a purchase) does it go to the human.

## Daily pass

Only what needs judgement; branch, worktree and session cleanup is the
dispatcher's and happens on the event, not here.

- Close issues the human said no to on a `needs-human` thread and nobody
  closed.
- `backlog` anything open with no activity for 30 days (or the config's
  `staleDays`), unless it's `p0` or `p1`.
- Add the `In plain words` section to any open issue or PR missing it,
  touching nothing else in the body.
- Re-triage anything whose labels no longer match its body: a `bug` that
  turned into a `refactor` in the comments, a `Depends on` that merged, a
  `blocked` whose blocker closed but didn't flip.
- Flag a pattern: three or more open issues from different sources on the
  same feature in the window, skipping issues with a PR in flight or
  `Part of` an existing plan before counting. Read all earlier
  **Worth a plan?** sections and decisions in the pinned `Triage log`;
  skip a feature already listed unless the pile includes new issues not
  linked in any earlier suggestion for it, even after a no. Before adding
  `possible-plan`, ensure the repo has it (including projects set up before
  this label existed): run
  `gh label create possible-plan --repo <owner>/<repo> --color D4C5F9 --description "These issues may need a plan." --force`.
  Only after that succeeds, add it to each issue in the pile, keeping its
  status. Still add a **Worth a plan?** section to the normal daily log comment: one
  line per feature, its plain name, why it might deserve a plan, and the
  issue links. The manager removes the label after the human or owner
  decides; don't put it back unless new issues join the pile. This step
  never opens an issue or changes any status, including `needs-human`.

One line per action, in a single comment on the project's triage log
issue. Nothing to the human.

## Return

Last line of output, one JSON object, nothing after it:

```
{"job":"triage","pass":"new","ready":3,"blocked":1,"closed":2,"for_human":1}
```

The dispatcher starts build jobs from `agent-ready` and pings the manager
when `for_human` is non-zero.
