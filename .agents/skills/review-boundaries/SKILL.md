---
name: review-boundaries
description: Review a change against the module-structure rules. Use when you're the boundaries lens on a PR.
---

# Boundaries lens

Follow `code-review` for scope, what counts as a finding, the report shape
and the return line. Your lens is module structure: whether the change keeps
modules deep, with a small public API, so they stay easy to use, change and
fix on their own. Whether the code works belongs to other lenses. Your
finding IDs are `B1`, `B2`, …

Read the project's `CODING_STANDARDS.md` sections on where code belongs,
front doors, deep modules, complexity, and file and folder limits.

A good module behaves like a well-made library: one clear job, a small
public surface, and the details hidden behind it.

## Rules

Review only the modules this change adds or touches. Each rule is pass or
fail, and a fail is a required finding.

Some rules are also CI checks. When the check exists and ran, don't repeat
its work: cite its result and move on. When it doesn't exist yet, apply the
rule by hand and say so, so the audit can see what still needs a check.

1. **No new front-door violations.** _CI check: import boundaries._ Run the
   project's import checker on the changed files. The count must not go up,
   and shared code never imports a feature.
2. **Every new export has a real caller.** Each export the change adds or
   widens is used outside the module, in this change or already on the base
   branch. Exports that leak internals (database rows, transactions, storage
   paths, provider clients) fail.
3. **One complete action per call.** Callers ask for an outcome and get it.
   Fails if callers must run steps in a set order, repeat a business rule,
   or reach into the module's internals.
4. **No pass-through layers.** Imagine deleting each new module, wrapper or
   layer. If nothing gets harder, it fails. It passes only if its logic
   would otherwise be copied across callers.
5. **One rule, one place.** A business rule copied into a second place fails.
6. **No layer with one implementation.** A new interface, injected
   dependency or plug-in point with a single real implementation fails. The
   real one plus a test double counts as two.
7. **Tests go through the public API.** _CI check: import boundaries, test
   folders._ New tests that import private files or assert on internal
   state fail. Tests for removed code must go.
8. **No new cycles.** _CI check: import boundaries._ Two modules that now
   import each other fail. The fix is moving the shared piece to the side
   that owns it, or merging them if they're one module.
9. **No leftover code.** _CI check: dead code._ The change adds nothing
   unused (files, exports, functions, types, dependencies) and deletes what
   it leaves unused, with that code's tests.
10. **Size limits.** _CI check: lint, max lines._ A new file or folder over
    the project's limits fails, and so does an edit that leaves an already
    over-limit one bigger than before.
11. **Comments say why, not what.** A comment that restates the code, or a
    block of commentary where a name would do, fails. This one can't be
    linted, so it stays yours.

## Refactor ideas

When the change touches several shallow modules that would be simpler as
one deeper module, and the merge stays inside files the PR already changed,
it's a required finding naming the files, what would merge and what gets
easier. The fix does it now.

When the merge would pull in code the PR didn't touch, it's bigger than this
PR: open a follow-up issue (`type:refactor`, `source:review`, no status)
with the same detail and link it under your lens section **Refactor issues
opened**. The manager triages it. It never holds the current change.

## How to write

Ordinary developer language, like this file. No textbook words such as
"seam", "adapter", "port", "locality" or "leverage". Say what's wrong and
what would fix it.

## Not your lens

Runtime bugs, edge cases, data, UI and copy belong to other lenses. One line
under **Noticed, not mine**.
