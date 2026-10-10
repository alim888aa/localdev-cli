---
name: error-handling
description: Handle each failure the way ERRORS.md says for its type. Use when writing or reviewing code that can fail, or setting up a project's ERRORS.md.
---

# Error handling

Errors are handled in two layers:

- **Patterns** are the few ways this project responds to a failure, such as
  "retry then alert" or "skip the item and alert". They live in `ERRORS.md` at
  the repo root. Only the human adds or changes a pattern.
- **Error types** are the specific failures, such as an AI timeout, an AI rate
  limit or an unexpected stored item. They live in the code, in the errors
  module `ERRORS.md` names, and each one says which pattern it follows. Agents
  add types freely as long as each uses an existing pattern.

Never decide error handling from scratch. Sort the failure into a type, and the
type's pattern decides what happens.

## Handle a failure

1. **Name the type.** Reuse an existing type when one fits. Otherwise add one to
   the errors module with a clear name, the pattern it follows and the details
   an agent needs to debug it.
2. **Follow its pattern.** Do exactly what `ERRORS.md` says for that pattern.
   Don't add your own retry, wait, longer timeout or fallback; those belong to a
   pattern.
3. **Stop only the smallest broken piece.** One bad item skips that item, not
   its batch, its group or the whole run. Stop a whole run only when the pattern
   says the failure breaks every item, such as a missing key or a changed
   schema.
4. **Tell the human when the pattern says so.** Every pattern except
   `fail-request` alerts: send the failure through the alert channel in
   `ERRORS.md` with its type, pattern, the item it hit and the details,
   without private data. A skip nobody hears about is a hidden error. A
   user's own bad input or missing permission is not an alert.
5. **Auto-fix only with one right answer.** Fix a failure automatically only
   when there is exactly one correct result and it is easy to undo. Otherwise
   skip and alert.

## At the edges

- Wrap every call into an outside library or service (AI providers, databases,
  scrapers, payment and email services) where it enters the code, and turn its
  failures into error types. Code inside the project then handles only types.
- At every entry point, such as a route handler, server action, scheduled job
  or queue task, every expected error type must be handled. How depends on the
  error style in `ERRORS.md`:
  - **Effect tagged errors:** the error channel is empty (`never`) before the
    effect runs, so TypeScript proves every type was handled.
  - **Error classes and an entry wrapper:** each error class carries its
    pattern, and every entry point runs through the project's one shared
    wrapper, which applies the pattern. Throw only the project's error classes.
- Each entry point also catches anything unexpected and sends it to the alert
  channel as an unknown error. Each unknown error is a candidate for a new type.

## When no pattern fits

Handle it with the safest pattern that exists, usually `skip-and-alert`, so
the work isn't blocked. Then open one issue, status `needs-human`, titled
`Errors · pattern proposal · <failure>`, with:

- the failure and where it happens
- why no existing pattern fits
- the pattern you propose and why
- what the code does meanwhile
- the PR it came from

Link the proposal under the PR's **Assumptions**, which keeps it off
auto-merge. Review and verification carry on; the manager brings the
proposal to the human. When they approve, add the pattern to `ERRORS.md` and
move the type onto it in the same PR. When they pick something else, change
the code to match.

## Checks

`ERRORS.md` lists the folders the error checks enforce. Inside them, plain
`throw` and generic `new Error` aren't allowed, every error type must name a
pattern from `ERRORS.md`, and entry points must handle every expected type.
Outside them, the number of plain throws in a folder may only go down. Until a
check tool exists, reviewers check this by reading the diff.

## Review

For each failure a change adds or changes, check:

- it uses a fitting type, and the type follows the right pattern
- when it fires, only the smallest broken piece stops; ask what else stops with
  it
- it reaches the alert channel with enough detail to debug
- an auto-fix has exactly one right answer and can be undone
- no retry, wait or fallback was added outside a pattern

A wrong pattern or a failure that stops more than its own piece is a blocking
finding, except the documented stopgap: `skip-and-alert` with an open
pattern proposal linked under the PR's Assumptions is correct until the
human rules.

## Set up ERRORS.md

`setup-factory` does this. The rules and the four starter patterns come from
`standards/ERRORS.base.md` in agent-org. What the project already does wins:
read its throws, catches, retries, alerts and logs, and the outside services
it calls, and write the most common way as the rule with the exceptions
listed. Rename or add patterns only when the code has one the four don't
cover. When the code has no consistent handling, the base stands as-is and
the human says yes or changes it. Use Effect as the error style when the
project already uses it; otherwise error classes and one entry wrapper.
Patterns stay the same if a project later moves to Effect.
