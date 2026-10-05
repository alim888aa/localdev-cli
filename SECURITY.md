# Security

localdev starts and stops processes, signals process groups and writes session
files on the machine it runs on. Treat a way to make it act outside its own
session as a security problem. That includes signalling another process,
deleting files outside a session, or reading another session's credentials.

## Reporting

**Don't open a public issue for a vulnerability.** Report it privately through
GitHub's private vulnerability reporting (Security tab → "Report a
vulnerability") on this repository. Include the localdev commit, the steps and
the impact. You'll get an answer in the advisory thread.

## Issues are public

Every issue on this repo is public, including those filed by
`localdev issue --submit`. Never include passwords, tokens, credential files,
private URLs, full session receipts or personal data. `localdev issue` shows
the checkout path relative to your home directory, but it doesn't redact
anything else you type.
