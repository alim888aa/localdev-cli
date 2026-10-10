# Design

localdev has no visual UI: no pages, components, colors or styling. Its "look"
is what it prints. The frontend review lens has nothing to review here beyond
this file. Treat an output change as an interface change: clients parse it
(see **Must never break** in [CONTEXT.md](CONTEXT.md)).

## Output

- Commands that act on sessions (`startup`, `status`, `stop`, `fault`) print
  JSON to stdout and nothing else there. Everything else goes to stderr.
- `startup`, `status` and `fault` pretty-print with two spaces. `stop` prints
  one compact line.
- `status` always prints an array, even for one ID. A stopped or unknown ID is
  `[{ "id": "...", "state": "gone" }]` with exit 0; `stop` says
  `alreadyGone: true` the same way.
- Not JSON, on purpose: `help` (plain text) and `issue` (a Markdown draft, then
  `Created <url> [label]`). The fault proxy's one ready line goes to its log.
- Prompts appear only in a terminal. Unattended runs never wait for input; they
  fail with the flag to pass instead.

## Errors and exit codes

- Exit 0 on success, 1 on any failure. There are no other codes.
- A failure is one plain line on stderr, no stack and no JSON. It starts with a
  capital, names the thing (session ID, port name, flag) and, where the CLI
  knows it, the next step, often after a semicolon (`...; run localdev fault
  <id> <port> --clear first`). Trailing periods are not consistent.
- Bad flags say `Unknown <command> option: --x. Run "localdev help <command>"
  for its options.`
- Details are in [ERRORS.md](ERRORS.md).

## Help text

- Every usage and help string lives in `help`. Syntax lines are written once
  and reused by the overview, the topics and the usage error.
- `localdev help`, `localdev --help` and `localdev -h` show the overview.
  `localdev help <command>` or `<command> --help` shows a topic; `issue` has
  `issue bug` and `issue request` topics too.
- A topic is one sentence of purpose, a `Usage:` line, flags indented two
  spaces with a short description, then `Examples:` with `<session-id>` style
  placeholders.
- When a command or flag changes, change its help topic and the README in the
  same PR.

## Flags and names

- Flags are long (`--parallel`), values follow as the next argument; `-h` is the
  only short flag. A flag that is repeated keeps its first value (`issue` rejects
  a repeat).
- The command is `localdev`; the name `local` is not used.
- Port names, fixture names and service names are the adapter's words, as in
  [CONTEXT.md](CONTEXT.md).

## Status fields

- Keys are camelCase (`dataDir`, `credentialsFile`, `proxiedPorts`,
  `listenerOwned`, `commandExit`). Session IDs are UUIDs.
- States are lowercase words: `starting`, `ready`, `failed`, `stopping`,
  plus the derived `degraded` and `gone`. `outbound` is `"blocked"` or
  `"allowed"`, though the receipt stores `deny`.
- Ports are numbers, keyed by port name. Durations are milliseconds. Times are
  ISO 8601 strings.
- Unknown values are `null` (`commit`, `launchMode`), while optional parts are
  left out (`role`, `proxy`, `outboundRefused`). Both exist today.
- Status shows absolute local paths (checkout, logs, data directory). Anything
  meant for a public place, such as an issue draft, shows `~/...` instead.
- Status never prints service env, specs or credentials.
