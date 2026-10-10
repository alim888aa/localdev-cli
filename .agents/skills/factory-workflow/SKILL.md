---
name: factory-workflow
description: "The contract every factory skill shares: words, labels, how work moves, who decides. Read before opening or moving an issue or PR, or running a factory job."
---

# Factory workflow

Issues go in, PRs come out. The dispatcher watches the labels and starts
whatever each issue or PR needs next. No agent decides who goes next. The
human sees finished work, not the work in progress.

## Words

Every skill uses these words with these meanings. Don't introduce others.

- **Job.** One agent run with a single task. It starts with pointers (repo,
  number, commit, skill), posts its result on GitHub, returns one line to
  the dispatcher, and ends. Jobs start fresh, except build and fix: one
  worker thread per issue does both, so the fix keeps the context the
  build had. The PR body is still the full handoff, so a fresh worker
  can pick up a PR whose thread is gone. Which model runs a job is a line
  in the project's `factory.json`, never a rule in a skill.
- **Dispatcher.** Whatever starts jobs from labels and never reads a
  report or makes a judgement call. That's two things: the dispatch
  thread (one per project, `dispatch` skill), where a script decides
  from labels and thread status and the agent only makes the T3 calls
  it prints, to launch, resume and clean up worker threads and start
  triage; and each worker thread, which runs its own PR's loop
  (lenses, verifier, hunt as subagents) by the same rules. When a skill says "the
  dispatcher sets X", in a PR's loop that's the worker thread.
- **Slot.** At most `maxParallel` worker threads run at once (default 2).
  Each owns one worktree, shared read-only by every subagent on its PR,
  and at most one `localdev` session at a time. Only the build and fix
  write app code there; every other job keeps its throwaway stuff in
  `.scratch/<job>/`. A worker stops every session and server before it
  ends a turn, for any reason, so a thread that isn't running holds
  nothing. When the PR merges or closes, the dispatch thread deletes the
  branch and the worktree and settles the thread. Same when an issue
  closes or goes back to `agent-ready` after a re-plan.
- **Lens.** One angle for reviewing a PR: boundaries, regressions or frontend.
  Each lens is its own job.
- **Verdict.** A job's one-line result: `clear`, `findings`, `blocked` or
  `needs-human`.
- **Check.** A yes/no the machine answers for free in CI: format, typecheck,
  lint, tests, import boundaries, dead code.
- **Plan issue.** One `type:plan` issue per feature, refactor or ADR. It names
  the feature branch and lists its child issues.
- **Feature branch.** The branch a plan issue's PRs merge into as they're
  approved.
- **Parent PR.** The feature branch into `main`. The only PR the human reviews.
- **Manager.** One agent per project for what a script can't judge, and
  the human's chat thread.
- **Owner.** In a dark project, the agent in the human's seat for the
  product. See **Dark projects**.
- **Client.** Whoever a dark project's tool is for: the human, and the
  agents that use the tool and file feedback through it.
- **Triage.** The job that makes new issues `agent-ready` and sweeps the
  backlog daily.
- **Fixture.** A named `localdev` setup of the app with known data, used for
  browser proof.
- **Protected feature.** A feature the project config lists as too important
  to auto-merge into.

## Three ways work starts

1. **A plan.** Human and agent plan with `think-with-me` and `feature-adr`,
   cut mid-size issues with `issue-maker`, each `Part of #<plan>`. Issues go
   through build, checks and review into the feature branch. The parent PR
   waits for the human, who usually tries it the next day and says merge.
2. **A small change.** A refactor that changes no behaviour (any size), or a
   bug fix under the project's file limit outside a protected feature. Same
   build, checks and review, then the dispatcher merges it to `main` when the
   auto-merge checks pass. Not deployed; it rides in the next deploy.
3. **The human with an agent.** No issue. The agent builds, the human tries
   it, and on "bundle it" the agent opens a PR and runs the lenses itself as
   subagents with `review-pr`. The human's go-ahead is the approval, so the
   agent merges when the human says so. Small UI and copy fixes the human
   asks for on a parent PR go straight onto it, no fresh review.

## Labels are the state

Every issue and PR carries one of each:

- `feature:*`, the area it touches
- `type:*`: `bug`, `feature`, `refactor`, `maintenance`, `plan`, `docs`,
  `idea` (a researcher's proposal, decided by the owner)
- `source:*`, who filed it. Fixed: `plan`, `human`, `review`, `worker`,
  and in dark projects `feedback` (a client agent's feedback command),
  `research` and `upkeep`. The rest are the
  project's monitors from its config, such as `posthog`, `gcp-logs`, `seo`,
  `email`, `ingestion`, `db`, `watch`.
- priority `p0` (on fire), `p1` (next), `p2` (default). A PR inherits its
  issue's. Within a priority, whatever others depend on goes first, then
  oldest.
  Above `budgetUsd`, only `p0` starts.
- exactly one status. Replace the old one when handing over. The only
  issues without one are brand new (triage gives them one on its next
  pass) and the two operational ones, the pinned `Triage log` and
  `audit` issues, which never enter the queue.

`human-comment` sits beside the status, never instead of it: the human
commented from the control center. It wakes the manager, which replies
on the item and removes it.

`possible-plan` also sits beside the status, never instead of it: triage
found a pile of issues on the same feature that might deserve a plan.
The reason and grouping go in the `Triage log`. The human decides (the
owner in a dark project); the manager removes it after the decision.
Every issue still carries exactly one status.

**Links** are machine-readable lines in the body, one per line:
`Depends on #<n>`, `Part of #<plan>`, `Blocked by #<n>`, `Closes #<n>`. The dispatcher reads
them to order work, pick base branches, and unblock. If only part of an
issue is blocked, split it.

**In plain words.** Every issue and PR body has a `## In plain words`
section right after its links: two or three sentences for the human,
written for someone who uses the app and has never seen the code. What
changes for them and why it matters. No file, function or module names,
no bare `#<n>`: name another item by what it does, number in brackets
("Seller photo upload (#140)"). The control center shows it on the item's
card, so it's often the only part the human reads.

**Issue status**

| Label | Meaning | What happens next |
| --- | --- | --- |
| `needs-human` | waits on a decision, named in a comment | the manager brings it to the human |
| `needs-manager` | waits on a call the manager can make alone, named in a comment | the manager rules |
| `blocked` | waits on `Blocked by #<n>` | `#<n>` closed as done flips it to `agent-ready` and its worker thread resumes; closed as not planned, to `needs-manager` |
| `backlog` | deferred | nothing, until the human reprioritises |
| `agent-ready` | scope agreed, base named, dependencies done | the dispatcher starts a build job |
| `building` | a build job owns it, through its PR | the PR's flow |

**PR status**

| Label | Meaning | What happens next |
| --- | --- | --- |
| `reviewer-ready` | head is ready for review | checks first, then every lens on that commit, highest priority first |
| `fixing` | a lens or the verifier posted findings, or a check is red | the worker fixes them and sets `reviewer-ready` on the new head |
| `verifier-ready` | every lens clear on the head, checks green | the dispatcher starts the verifier job, highest priority first |
| `blocked` | waits on `Blocked by #<n>`, whatever that is | `#<n>` closed as done puts it back where the facts say: `verifier-ready` if lenses are clear and checks green, else `reviewer-ready` |
| `approved` | verifier passed on the head | the worker merges into the feature branch, or auto-merges into `main` |
| `human-ready` | parent PR passed its end-to-end run; waits for the human | the human tries it and says merge |
| `needs-manager` | bouncing, a lens said re-plan, or into `main` but an auto-merge check failed | the manager rules |
| `needs-human` | a product call | the manager brings it to the human |
| `deployed:<env>` | live, with a GitHub Deployment record | a watch job tries the live flows and reads the monitors |

Any commit after `verifier-ready` needs the lenses again, except the human's
own small fixes on a parent PR.

## How a PR moves

```
issue (agent-ready) ─▶ build job ─▶ PR (reviewer-ready) ─▶ checks + lenses
  ─▶ fixing ⇄ reviewer-ready ─▶ verifier-ready ─▶ approved ─▶ merge into feature branch
  ─▶ parent PR ─▶ end-to-end verifier ─▶ human-ready ─▶ human says merge ─▶ main
  ─▶ deploy on request ─▶ watch job
```

- Lenses run in parallel, one job each, one report each (`code-review`).
  Later rounds post only what changed.
- More than two `fixing` ⇄ `reviewer-ready` bounces: `needs-manager`, with a
  paragraph on what each side kept saying.
- Edge cases a lens lists are checked by one hunt job per PR
  (`edge-case-hunter`), started by the worker once the PR is `approved`.
  The worker keeps its slot until the hunt ends. The hunt walks the cases
  one by one and never holds the PR; a broken
  case becomes its own issue, linked to the PR. If the PR merged first, the
  hunt makes its own throwaway worktree at the merge commit on whatever
  branch the PR merged into, records that commit, and still posts to the
  PR.
- Build jobs try their change in a browser and list what they did under
  **Tested** in the PR. Nobody grades that list; the regressions lens reads
  it for gaps and writes the **Test plan** from it plus its own code reading.
- Build jobs that touch UI also put a screenshot of every changed screen at
  390 and 1440 wide under **Screenshots** in the PR. That is the frontend
  lens's evidence; the lens reads images, it never drives a browser. A
  screen the lens can't find a shot of goes under its **Visual checks** as
  `not shown`, and the verifier captures it.
- The verifier job runs the Test plan on the exact head once the PR is
  `verifier-ready`, after lenses and checks, so the expensive browser run
  lands on code that won't change again. It runs on whichever model has browser use
  there, through the agent's own browser use, never Playwright. It takes a
  screenshot after every step and of every `not shown` screen at both
  widths, and posts them with its report. Failed steps are findings (`V1`,
  `V2`) and set `fixing`; after the fix and the lenses' delta round it
  reruns only those steps.
- The dispatch thread creates the feature branch from `main` when it
  starts the plan's first build. Whoever merges a child PR into the
  feature branch also closes the child's issue as done (GitHub only
  auto-closes on `main`), which unblocks anything that depended on it.
  Once every child is closed, the dispatch thread tells the manager,
  which launches a parent run (`worker` skill): it opens the parent PR into `main`, body linking the
  plan, and runs one end-to-end verifier on its head for the plan's
  flows. Clear is `human-ready`. Each failed step becomes a `type:bug`
  child issue (`Part of #<plan>`) and the parent goes `blocked` with a
  `Blocked by` line per issue; when they close, the run happens again.
  A plan with a single child skips the run: the parent goes straight to
  `human-ready`.
- Auto-merge is five yes/no checks computed from the diff, labels and
  config: small change (`type:refactor`, or `type:bug` under the file
  limit, outside a protected feature); no existing test file changed; no
  file under the config's `paths.schema` or any feature `index.ts`
  changed; Assumptions section empty (the word `none` counts as empty);
  lenses clear and checks green on the head. A PR into `main` that fails
  any of them gets `needs-manager`, with a comment naming which.
- "Checks green" means a commit status named `factory/check` is green on
  the exact head. The job that runs `pnpm check` posts that status with
  `gh api`, so it's visible on the PR the same way CI would be.
- Only failures the diff causes count. A check that fails the same way
  on the base branch's head is the base's problem: it gets one blocker
  issue (found or opened, never twice), the PR lists it under **Base
  failures**, and the status stays green with those issue numbers in its
  description. One broken test on `main` never freezes the factory.
- Every PR body has **Tested**, **Screenshots** (UI changes only) and
  **Assumptions** sections. Assumptions holds small guesses the build
  job made. Non-empty blocks auto-merge and is shown to the human on the
  parent PR. A guess that would change planned behaviour is `needs-human`
  instead.

## What wakes what

Two long-lived T3 threads per project, each woken by a webhook:

- **Dispatch thread**, on a new issue, any issue or PR closing, and the
  label `agent-ready`. Also an hourly tick, since a webhook can get
  lost. Worker threads tell it `finished #<n>` when they free a slot;
  the manager tells it `ruled #<n>`. A daily schedule in the same
  thread runs the triage job's daily pass.
- **Manager thread**, the human's chat, on the labels `needs-manager`,
  `needs-human`, `human-ready` and `human-comment`, and when the dispatch thread tells
  it something. A weekly schedule in the same thread runs the audit.

A small GitHub Action (`factory-wake`) does the filtering, so every other
label change wakes nobody. The status labels a worker moves through mid-loop
never wake anything; the worker thread is already running.

## Blockers are work

A job that can't proceed because of the environment opens a blocker issue
(`type:maintenance`, `source:worker`, no status; that pair of labels is
what marks it as a blocker, and a build job on one runs in investigate
mode) with the exact error, sets
its own issue `blocked` with `Blocked by #<blocker>`, and ends. The triage
job handles blockers with other new issues: dedupes, bundles related small
ones, closes what isn't worth doing, sets priority, and either starts an
investigation job (`agent-ready`) or sets `needs-human` when no job could
fix it. The `worker` skill has the investigation procedure.

## Who decides what

- **The human** makes product and architecture calls, tries parent PRs,
  answers `needs-human`, and asks for deploys. They don't open GitHub:
  everything reaches them through the manager in chat, or through Dot.
- **The triage job** turns new issues into `agent-ready` work: dedupes,
  bundles, closes, labels, prioritises, links. Runs when issues have no
  status, and once a day over everything open for stale or drifted work.
  Never talks to the human; what it can't settle gets `needs-human`. The
  `triage` skill has the procedure.
- **The manager** rules on `needs-manager` items (borderline auto-merges,
  bouncing PRs, re-plans, dropped blockers), brings `needs-human` items
  to the human, and merges parent PRs and deploys on the human's word.
  It doesn't relay routine work, review code, build features or triage.
  The `manager` skill has the procedure.
- **The dispatcher** (the dispatch thread plus each worker thread for its
  own PR) does everything else: starting jobs, moving labels,
  auto-merging, unblocking, and cleaning up branches, worktrees and
  threads on merge or close. The `dispatch` skill has the procedure.

## Budget

`budgetUsd` in `factory.json` caps what a project's agents spend per day,
counted at API list prices from the local Claude and Codex logs by
`usage.mjs` next to the `dispatch` skill. Once today's spend reaches it,
or can't be counted, the dispatcher starts only `p0` work. Running work
finishes, triage keeps running so a new `p0` still gets seen, and
research waits for tomorrow. No `budgetUsd`, no cap.

## Dark projects

A project with `"owner": "agent"` in `factory.json` runs with nobody in
the loop. Everything above holds, with these changes:

- **The owner fills the human's seat.** Wherever a skill says the human
  decides, tries, approves, is asked or is told, read the owner (`owner`
  skill), in its own thread, `Factory · owner`. The manager stays and is
  reported to first, as in any project: it settles everything that isn't
  a product call, merges far more on its own, and brings the owner only
  product calls and parent PRs (`manager`'s **Dark projects**).
- **Its calls are quoted** as `> Owner decision: "..."`. They count
  wherever a skill accepts a `Human decision, verbatim`. A real human
  decision still overrules one.
- **Clients ask, the owner decides.** The human asks in the owner's
  chat; agents file `source:feedback` issues. A feature request without
  a decision that settles the request is a product call (`needs-human`).
  `p0` includes a client that's blocked:
  another project's job can't run because of this tool.
- **Big calls** go through the `council` before the owner decides.
- **More jobs.** `upkeep` weekly from the manager's thread; `researcher`
  weekly from the owner's thread, whenever the owner is stuck, and
  whenever the dispatcher finds nothing to do.
- **Browser work**, including the owner trying a parent PR, runs on the
  `verifier` model.
- **The human hears from the factory** only in reply to them (with a
  few product questions when they ask for a feature), or when the owner
  hits something no agent can do.
- **Hard line.** Any job may delete what git or a rerun can bring back.
  Nothing in a dark project deletes client or user data, rewrites
  `main`'s history, or revokes or deletes keys and secrets. That's the
  only thing the owner's word can't allow.

## Writing on GitHub

- Begin every issue, PR body, review and comment with
  `Author: <job name> · <run link or id>`, so a follow-up can find the run.
- Quote the human word for word before any technical reading of what they
  said: `> Human decision, verbatim: "..."`. A paraphrase isn't a decision.
- The human hears from the manager only for a decision, a breakage, a
  pattern more than one agent hit, or an audit summary. Nothing else,
  unless they ask. Never paste a report, a diff or a SHA list.
- Any job may end what it posts with a **Retro** block, at most three
  lines, only when it has something to say: `time-sink:` (what ate the
  run and shouldn't have), `blocked:` (what it waited on), `reviewer:`
  (a finding that was really a nit, or a rule misread), `labels:` (a
  status that sat too long or made no sense), `conflict:` (a line in the
  project's agent instructions that contradicts a skill, quoted). Nothing
  to say, no block.
  The audit job reads these; nobody else acts on them.
- Throwaway scripts live in `.scratch/<job>/` inside the PR's worktree,
  and `.scratch/` is in the project's `.gitignore`; the dispatcher refuses
  to start if it isn't.

## Permissions

Building, reviewing, commenting, labelling, pushing branches and opening PRs
are allowed within an assigned job. Merging is the dispatcher's (auto-merge)
or the manager's (on the human's word). Deploys, production writes and
anything outside the assigned job need the human, which in a dark project
is the owner.
