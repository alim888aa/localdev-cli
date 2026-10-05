# Report a localdev issue

Run the globally installed command from the affected project's checkout. It
adds that checkout's path and commit, the CLI version, and the runtime to the
report. A pnpm Git install provides its pinned CLI commit through its package
path. With another install method, pass the commit with `--cli-ref` before
publishing if the draft shows `unknown`.

For a person at a terminal, `localdev issue bug` or `localdev issue request`
asks for the details, shows the formatted draft, then asks whether to publish.
For an unattended agent, put the details in a JSON file:

```json
{
  "reporter": { "source": "Codex Cloud", "agentId": "<task or session ID>", "project": "<project name>" },
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
localdev issue bug --input report.json --session <session-id>
localdev issue bug --input report.json --session <session-id> --submit
```

`reporter` is required for every report. The repo is public and anyone can
open an issue, so it tells the maintainers which agent sent each one. Give
three things, each on one short line:

- `source`: where you run, such as `Codex Cloud`, `Codex local` or
  `Claude Code cloud`.
- `agentId`: your agent, task or session ID.
- `project`: the project you were working on.

These fields are self-declared. They identify a report but don't
authenticate it.

The first command prints a draft, plus a link that opens GitHub's new-issue
form with the report filled in. Use the link when `gh` isn't available.
`--submit` creates the issue in the public `alim888aa/localdev-cli` repo,
applies the `bug` label, and checks the saved title and label. The checkout
path is shown relative to your home directory (`~/...`), so your local user
name isn't published. The session option adds only the ID, fixture, state, and
checkout commit; it never attaches credential files or full receipts. Omit
`--session` when no session was created. Submission is refused when the CLI
commit is unknown; use `--cli-ref <installed-commit>` in that case.

For a request, use `localdev issue request` with an input file containing
`title`, `task`, `desired`, `whyShared`, and `acceptance`. Optional `impact` and
`evidence` fields add context. It applies the `enhancement` label. For both
kinds, the input file must already be free of secrets and personal data; the
command does not inspect or redact arbitrary text. Issues are public. `--submit` needs `gh` installed and
authenticated; without it, use the printed link.

Search existing issues before submitting. Problems confined to a project's
adapter, fixture, or app belong in that project's repo. The optional
`$localdev-issue-maker` Codex skill helps agents investigate and route a
finding; every project agent can use this CLI command without installing the
skill.
