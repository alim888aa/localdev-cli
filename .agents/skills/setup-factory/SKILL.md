---
name: setup-factory
description: Get a project ready for the factory. Use when the human says "set up the factory on <project>" or "set up a dark factory on <project>", or you're an owner told to set one up.
---

# Setup factory

You run in chat with the human, once per project. You look at what's
there, ask only what the code can't tell you, and write the rest. Ask at
most three questions at a time. Everything you write goes on one branch,
`chore/factory-setup`, as one PR the human merges; you never merge.
`factory-workflow` defines the words and labels; don't restate them.

Never invent product facts. A draft from the code is fine as long as it
says which lines are guesses and the human reads those lines.

## Dark projects

When the human says "set up a dark factory on <project>", you don't run
this skill in that chat. Look for the project's `Factory · owner` with
`t3_thread_list` first: if there is one, send it `Follow setup-factory
for a dark project on <owner>/<repo>.` and stop; a second owner would
make its own calls and schedules next to the first. Otherwise launch
`Factory · owner` with `t3_thread_launch` on the project root, the owner's model (default `claude-opus-5-5`,
high), `runtimeMode: full-access`, message `Follow setup-factory for a
dark project on <owner>/<repo>.`, tell the human it's started, and stop.

The owner then runs every step below with these changes:

- **Nobody to ask.** Every question takes its suggested answer and goes
  under **Assumptions** in the PR. Product facts the code can't give come
  from the clients: the human's ask, the `source:feedback` issues, and
  the skills and scripts of other projects that call the tool.
- **`CONTEXT.md`** gets three more sections. **Clients**: who asks for
  things and how, and which agents call the tool, through which
  commands, from which skills. **Must never break**: the commands and
  flows those clients depend on, each with where it's called from.
  **Direction**: at most ten lines on what the tool is becoming, the
  current bets, and what it won't do. The owner drafts it from the
  clients' asks and owns it from then on.
- **The feedback command**, if the tool has one, must file issues here
  with `source:feedback`. If it doesn't, file an issue for it.
- **A tool with no UI** (a CLI or a library) needs no app to boot: its
  `base` fixture is a scratch folder set up the way its clients use it.
- **`factory.json`** also gets the dark keys in step 6.
- **The owner merges the setup PR** itself once `pnpm check` is green.
- **Step 9** launches the dispatch and manager threads as usual; the
  owner thread already exists. Both get the extra schedules at the end
  of step 9, and only the missing ones.
- **Done** is the owner's return line. Nothing goes to the human.

## How you talk

Plain language, the way you'd explain it to a colleague. Say what you
found and what it means for them. Every question carries your suggested
answer, so a one-word reply is enough. The project's own agent
instructions set the rest of the tone. 

## 1. Look

Read `package.json` scripts, the CI folder, existing lint and typecheck
config, the repo's labels, `.gitignore`, `local.adapter.mjs` if it
exists, any of the four docs below that already exist, and every agent
instructions file the jobs will see (`AGENTS.md`, `CLAUDE.md` and nested
ones, `.cursor/rules`, `.github/copilot-instructions.md`, files those
import, and any in parent folders). Tell the
human in one short message what's there and what's missing.

## Ask once, then fan out

Before any writing, one short round: the defaults you plan to use
(models per job, file limit, strict-check folders, the coding standards
base) with "fine to go with these?", plus the two or three things the
code can't tell you, usually protected features and what a base fixture
world needs. Three questions at a time. Then start three subagents at
once on the same branch, each owning its files and nothing else:

- **docs**: step 2, the four docs.
- **fixture**: step 3, the adapter and `localdev startup base`.
- **checks**: step 4, `pnpm check`, the ratchet baseline, the Action.

You do steps 5 to 7 yourself meanwhile. Each subagent returns what it
wrote, what it guessed, and what it couldn't do. Anything it couldn't do
comes back to the human as a question, never as a silent skip.

## 2. The four docs

The lenses hold every PR to these. Each one exists, is short, and has
the sections a lens cites. Existing ones get checked for those sections,
not rewritten. Each doc has its own way of getting written:

- `CODING_STANDARDS.md` starts from the base in agent-org
  (`standards/CODING_STANDARDS.base.md`): where code belongs, React and
  styling rules, the `useEffect` allowlist, tests, checks. Copy it in,
  add a short project section underneath for what the base can't know
  (what the layers are called here, where the errors module lives), and
  ask the human once whether the base is fine. Usually it is.
- `ERRORS.md` and `DESIGN.md` come from the code. Find the most common
  way the app already does it: which error style and patterns most of
  the entry points use, which tokens, components and spacing most pages
  share. Write that down as the rule, with the exceptions listed, and
  confirm with the human. The errors base in agent-org
  (`standards/ERRORS.base.md`) supplies the rules and the starter
  patterns; the project supplies its alert channel, errors module and
  any extra patterns.
- `CONTEXT.md` also comes from the code: what the product does, who
  uses it, and the words the code uses for its things. Confirm what you
  found and ask only about what you couldn't pin down, like two words
  that might mean the same thing.

When there's nothing to find, because the app has no consistent error
handling or no consistent look, don't invent a rule from one file.
Propose the common good practice (the errors base as-is, a small token
set from the most-used page) and ask the human to say yes or change it.

## 3. Fixtures

The factory proves behaviour in a browser, so the project needs
`localdev` with a `local.adapter.mjs` and at least a `base` fixture: the
services to boot, a seed with known accounts and data, and URLs. If the
adapter exists, run `localdev startup base` and check it comes up. If it
doesn't exist, write it from the human's answers and the seeds that
already live in the repo. Run it until it boots, but never change app
code to make it boot; an app that needs a change to run locally gets an
issue, not a setup edit. A project that can't boot a fixture can't be in
the factory yet; say so.

## 4. Checks

One command, `pnpm check`, that the worker runs before `reviewer-ready`
and after every fix: format, typecheck, lint, tests, import boundaries,
dead code, and the `ERRORS.md` rules. Wrap what exists. Until agent-org
ships a shared checks package, add the missing pieces per project with
plain ESLint rules, knip for dead code, and a small ratchet script that
compares counts to the committed baseline.

Strict rules run on the folders the human picks. Everywhere else a
ratchet: a committed counts file, one number per rule, that a PR may
only lower. At zero the rule is just on. Write the baseline from the
current code and show the human the numbers before committing them.

Leave one thin GitHub Action that runs `pnpm check` on `main` only.
Remove Actions that run the same thing on PRs; the laptop does that.

## 5. Labels

Create the label set from `factory-workflow`: statuses (including
`needs-manager`), `human-comment`, `type:*`,
`source:*` with the project's monitors, `p0`–`p2`, and a `feature:*`
per area the human names. Map the old ones (`cloud-ready` becomes
`agent-ready`, `local-verification` becomes `verifier-ready`,
`urgent-candidate` becomes `p0`) on every open issue and PR, then delete
the old labels. Issues still `building` from before the factory lose
that label, so triage looks at them fresh; otherwise the dispatch thread
would treat each one as a crashed worker and relaunch it.

## 6. factory.json

At the repo root:

```json
{
  "jobs": {
    "build":    { "provider": "codex",       "model": "gpt-6.1-sol",     "effort": "high" },
    "review-*": { "provider": "claudeAgent", "model": "claude-opus-5-5", "effort": "high" },
    "verifier": { "provider": "codex",       "model": "gpt-6.1-sol",     "effort": "medium" },
    "hunt":     { "provider": "codex",       "model": "gpt-6.1-sol",     "effort": "medium" },
    "dispatch": { "provider": "codex",       "model": "gpt-6-luna",      "effort": "high" },
    "triage":   { "provider": "codex",       "model": "gpt-6-luna",      "effort": "high" }
  },
  "smallChangeMaxFiles": 10,
  "protected": ["feature:payments"],
  "paths": { "schema": ["src/**/schema/**"], "ui": ["src/**/components/**", "src/app/**"] },
  "maxParallel": 2,
  "deploy": {
    "preview": {
      "run": "pnpm deploy:preview",
      "url": "https://...",
      "testAccount": "<name of the fixture account allowed there, or null>",
      "watchWindow": "24h",
      "rollback": ["error rate over 2% for 10 min", "checkout flow fails"]
    }
  },
  "monitors": { "posthog": { "project": "...", "baseline": "7d" } }
}
```

A dark project adds:

```json
{
  "owner": "agent",
  "budgetUsd": 50,
  "jobs": {
    "owner":    { "provider": "claudeAgent", "model": "claude-opus-5-5",   "effort": "high" },
    "verifier": { "provider": "codex",       "model": "gpt-6.1-sol",       "effort": "high" },
    "watch":    { "provider": "codex",       "model": "gpt-6.1-sol",       "effort": "high" },
    "research": { "provider": "claudeAgent", "model": "claude-opus-5-5",   "effort": "high" },
    "scout":    { "provider": "codex",       "model": "gpt-6.1-sol",       "effort": "high" }
  },
  "council": {
    "client":     { "provider": "codex",       "model": "gpt-6.1-sol",       "effort": "high" },
    "maintainer": { "provider": "claudeAgent", "model": "claude-sonnet-5-5", "effort": "high" }
  },
  "upkeep": { "keepDays": 14 }
}
```

`verifier` and `watch` run every browser job, the owner's included.
Extra council angles carry a one-line `brief`.

Providers and models are the ids T3 lists in `orchestrator_capabilities`.
Ask the human for the models, the protected features and the file
limit; propose the paths from the folder layout. Jobs not listed under
`jobs` (watch, audit and its lenses, manager) use the `review-*` entry. `deploy` and `monitors`
only when the project deploys through the factory; leave them out
otherwise, and the watch job never runs without them.

## 7. Housekeeping

- **Agent instructions.** Every job reads the project's agent
  instructions, and they usually win over a skill. So find each line
  that contradicts the factory and propose the edit: "don't commit when
  checks fail" (a blocked worker must push), "ask before opening a PR",
  another branch naming or review process, old org roles and `TEAM.md`
  references, a rule a lens enforces differently. The edits go in the
  setup PR; the ones that change how the human works go to them in the
  second interview. A conflict in a file outside the repo, like a
  parent folder or the human's global instructions, goes to the human
  as a quote; never edit it yourself. Keep what doesn't conflict, such as the project's
  tone and commands.

- `.scratch/` in `.gitignore`.
- One pinned issue titled `Triage log`, label `type:maintenance`, for
  the triage job to write to.
- Skills installed from agent-org with `npx skills@latest add
  alim888aa/agent-org`, and a line in the project's agent instructions
  saying which skill each job follows.
- `TEAM.md` and the old org skills removed, if the project had them.
- `templates/factory-wake.yml` from agent-org copied to
  `.github/workflows/factory-wake.yml`. It only forwards a few label
  events to the threads in step 9; it never runs checks.

## 8. Second interview

The helpers come back with guesses and things they couldn't settle.
That's the real interview: now you have specifics instead of hunches.

Keep it short. Wherever you have a sensible default and being wrong is
cheap to fix later, take the default, list it in the PR under
**Assumptions**, and move on. Ask only where the default could be wrong
in a way that costs real work to undo, three at a time, each with your
suggested answer. The first real issue through the factory will show
what the setup got wrong, and fixing a doc line then is cheaper than
twenty questions now. What's usually worth asking:

- The code does one thing two ways (half the actions throw plain errors,
  half use the error classes). Which is the rule? A doc can't say both.
- Product words you guessed. Walk them through the ones you're least
  sure of; don't just say "check the glossary".
- Existing `useEffect`s. The ban is in the base, but the app has
  hundreds. Show the few patterns you found and ask which go on the
  allowlist.
- Failures that fit no error pattern. Only the human adds a pattern, so
  show the failure and propose one.
- Pages that don't match the look. Do they become cleanup issues, or do
  some get grandfathered?
- What the base fixture is missing for the common flows: an admin, a
  sold listing, a second user who can message the first.
- Outside services (payments, AI, email): fake them, test keys, or skip?
  This decides what the verifier can ever test.
- Checks that would hurt: a rule the code breaks hundreds of times that
  might be better relaxed than ratcheted, slow or flaky tests to skip,
  Actions doing two jobs.
- The `feature:*` list. You proposed it from folders; their map of the
  product may differ.
- Agent-instruction lines you want to change that encode how the human
  likes to work, not just the old process. Quote each one with your edit.
- One small real issue to send through first, picked together, so the
  first run is a test and not a toy.

Write the answers into the docs and config before opening the PR.

## 9. Wire it up

This thread must be in full-access mode: the threads you launch can't
have more than you, and anything less stalls on prompts nobody answers.

1. Check T3 remote access is on (a webhook schedule comes back with a
   `webhookUrl`; without one, tell the human to turn on T3 Connect and
   stop here). If setup ran before, find the existing `Factory ·
   dispatch` and `Factory · manager` threads with `t3_thread_list`, ask
   each to list its schedules, and only add what's missing. Two
   dispatch threads would both hand out slots.
2. Launch `Factory · dispatch` with `t3_thread_launch`: the project
   root, the `dispatch` model from `factory.json`, `runtimeMode:
   full-access`. Its first message asks it to create three schedules
   bound to itself and reply with the webhook URL, and to do nothing
   else:
   - webhook: `Follow the dispatch skill. Woken by {{body.action}}
     {{body.label}} #{{body.number}}.`
   - every hour: `Follow the dispatch skill with --tick.`
   - daily at 09:00: `Start a triage subagent with delegate_task, async,
     title "Factory · triage", the triage model from factory.json,
     full-access, task "Follow the triage skill, Daily pass."`
3. Launch `Factory · manager` the same way, on the `manager` model
   (the `review-*` one if there's no `manager` entry),
   asking for two schedules bound to itself:
   - webhook: `Follow the manager skill. Woken by {{body.action}}
     {{body.label}} #{{body.number}}.`
   - Mondays at 08:00: `Follow the manager skill's Audit section.`
4. Store the two URLs as repo secrets with `gh secret set
   FACTORY_DISPATCH_URL` and `FACTORY_MANAGER_URL`. Never paste them in
   chat or a file; the URL is the only thing guarding the webhook.

In a dark project, two more schedules, each bound to its own thread:

- manager, Wednesdays at 08:00: `Follow the manager skill's Dark
  projects: upkeep.`
- owner, Fridays at 08:00: `Follow the owner skill's Research.`

Nothing wakes until the setup PR merges, since GitHub only runs the
wake Action from `main`. Tell the human the manager thread is where
they'll talk to the factory from now on; in a dark project, the owner
thread.

## Done

One message to the human: what you wrote, what you checked and left
alone, what you couldn't do and why, and the PR. Then stop; the first
real issue through the factory is the test, not a dry run here.
