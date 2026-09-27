---
name: localdev-issue-maker
description: Investigate, draft, or file a self-contained issue for the shared localdev CLI. Use when a project agent finds a localdev startup, port, session, status, stop, install, or adapter-contract problem, or requests a reusable CLI capability. Route project-only adapter and fixture work to that project's repo.
---

# Localdev Issue Maker

Give the next agent enough evidence to reproduce or evaluate one localdev problem without repeating your investigation. Use the [CLI repo's bug and request templates](https://github.com/alim888aa/localdev-cli/tree/main/.github/ISSUE_TEMPLATE) as the saved issue shape. Use the project repo for work confined to its adapter, seed, or app. If the boundary is uncertain, state why and link any related project issue.

## Check the finding

- Confirm the observed behavior or agreed request from the original source. Keep a bug distinct from a proposed improvement. Do not claim a root cause based only on a symptom.
- For a bug, record the project and checkout commit, installed CLI commit, adapter path, exact command/fixture, session ID, relevant port or URL, expected and actual result, and the smallest repeatable steps. Capture sanitized `localdev status`, logs, and whether `localdev stop <id>` cleaned the session. State what you checked when a detail is unavailable.
- Trace the failure as far as evidence allows: CLI core, adapter, seed, app, or external service. Name confirmed code/log paths and remaining unknowns. Include the practical impact, such as cross-session contamination, a wrong listener, an orphan process, or a blocked verification. Do not inflate urgency or invent counts.
- For a request, describe the agent's current task, manual workaround, desired result, and why the shared CLI should own it. State an observable acceptance check, including parallel projects or sessions when relevant. Leave implementation choices open unless already agreed.
- Never include passwords, tokens, credential-file contents, personal data, or raw private receipts. Redact logs and screenshots before attaching them.
- Keep issue investigation read-only unless fixing the product was separately requested.

## Search before filing

Search open and closed issues in `alim888aa/localdev-cli` using the exact error, command, subsystem, and symptom. Read likely matches. Add new evidence to the same issue when it is the same failure; reopen a solved issue only when the recurrence is demonstrated. Link related issues when the cause is still uncertain. Keep one distinct finding per issue.

## Write and save

Use `bug: <recognizable failure>` or `request: <agent outcome>` for the title. Fill the matching repo template with concrete facts. For bugs, include impact, evidence and cause trace, a replay, cleanup result, an observable verification step, and important unknowns. For requests, include the agent task, shared-CLI rationale, and acceptance checks. Do not leave template prompts or invented details in the final body.

For a new issue, write sanitized fields to a JSON file and run `localdev issue bug|request --input <file>` from the affected project's checkout. Add `--session <id>` when a receipt exists. The Git-installed CLI should supply its own commit; if the draft shows `unknown`, find the installed commit and pass `--cli-ref <sha>` before filing. Inspect the formatted draft. When the user or task authorizes filing, add `--submit`; the CLI applies the label and reads the saved issue back. Use `gh issue comment` or `gh issue edit` for new evidence on an existing issue. If filing is not authorized, provide the draft instead. Report the saved link or draft, plus any missing evidence that limits replay.
