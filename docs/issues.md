# Report a localdev issue

Run the globally installed command from the affected project's checkout. It
adds that checkout's path and commit, the CLI version, and the runtime to the
report. If the installed CLI's Git commit is known, pass it with `--cli-ref`.

For a person at a terminal, `localdev issue bug` or `localdev issue request`
asks for the details, shows the formatted draft, then asks whether to publish.
For an unattended agent, put the details in a JSON file:

```json
{
  "title": "stop leaves a server listening",
  "summary": "Stopping a session reports success, but its app URL still answers.",
  "expected": "Stopping the session closes its owned app listener.",
  "steps": ["Run localdev startup", "Run localdev stop <session-id>", "Request the app URL"],
  "impact": "The next agent can accidentally test a stale app.",
  "evidence": "Sanitized status or log excerpt, if available",
  "cleanup": "Describe any remaining process or generated file",
  "causeTrace": "What was checked and what remains unknown",
  "verify": "Repeat the steps and confirm the app URL no longer answers"
}
```

```sh
localdev issue bug --input report.json --session <session-id> --cli-ref <installed-commit>
localdev issue bug --input report.json --session <session-id> --cli-ref <installed-commit> --submit
```

The first command prints a draft. `--submit` creates an issue in the private
`alim888aa/localdev-cli` repo, applies the `bug` label, and checks the saved
title and label. The session option adds only the ID, fixture, state, and
checkout commit; it never attaches credential files or full receipts. Omit
`--session` when no session was created.

For a request, use `localdev issue request` with an input file containing
`title`, `task`, `desired`, `whyShared`, and `acceptance`. Optional `impact` and
`evidence` fields add context. It applies the `enhancement` label. For both
kinds, the input file must already be free of secrets and personal data; the
command does not inspect or redact arbitrary text. `gh` must be installed and
authenticated with access to the private CLI repo to submit.

Search existing issues before submitting. Problems confined to a project's
adapter, fixture, or app belong in that project's repo. The optional
`$localdev-issue-maker` Codex skill helps agents investigate and route a
finding; every project agent can use this CLI command without installing the
skill.
