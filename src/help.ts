const help: Record<string, string> = {
  overview: `localdev — isolated local test sessions for any project

Usage:
  localdev startup [fixture] [--project DIR] [--adapter FILE] [--replace [ID] | --parallel]
  localdev status [ID]
  localdev stop ID
  localdev issue bug|request [options]
  localdev help [command]

Examples:
  localdev startup
  localdev startup messages
  localdev status
  localdev stop <session-id>
  localdev issue bug

Run "localdev help startup|status|stop|issue" for details. Each project defines
its own fixtures in local.adapter.mjs and should list them in its agent guide.`,

  startup: `Start an isolated app and emulator session from a project checkout.

Usage: localdev startup [fixture] [--project DIR] [--adapter FILE] [--replace [ID] | --parallel]

  fixture         Project-defined test data; omit for the adapter's defaultFixture.
  --project DIR   Project checkout; defaults to the current directory.
  --adapter FILE  Adapter file; defaults to <project>/local.adapter.mjs.
  --replace [ID] Stop one healthy matching session, then start a fresh one.
  --parallel     Deliberately keep matching sessions and start another.

Each session gets its own ports and data, even beside other projects. The
receipt shows its ID, URLs, checkout commit, logs, and credentials-file path.
If this checkout already has a healthy session for the same fixture, unattended
startup exits and shows its ID and URL. In a terminal, choose to replace one or
keep both. Multiple matches require an ID for --replace. Other worktrees and
fixtures remain independent. Dead or stale receipts do not block startup.
Check your project's agent guide for fixture names and what they seed.

Examples:
  localdev startup
  localdev startup messages
  localdev startup messages --replace
  localdev startup messages --parallel
  localdev startup catalog --project /path/to/project`,

  status: `Show localdev sessions and their health.

Usage: localdev status [ID]

  localdev status       List every session on this machine.
  localdev status <id>  Show one session.

The JSON includes checkout commit, URLs, ports, logs, and process health.
A degraded session may have a dead server or a port owned by another process.`,

  stop: `Stop and clean up one localdev session.

Usage: localdev stop ID

Get the ID from startup or status. The command stops only that session's owned
processes and removes its files and data. If ownership cannot be verified, it
keeps the receipt for inspection instead of claiming success.

Example:
  localdev stop <session-id>`,

  issue: `Draft or publish a standard issue for the shared localdev CLI.

Usage:
  localdev issue bug [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]
  localdev issue request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]

Run from the affected project's checkout. Without --input, a terminal user
answers prompts. Unattended agents supply a JSON file. Without --submit, the
command prints a draft; a terminal user can confirm publication after seeing
it. --submit publishes directly to private repo alim888aa/localdev-cli with a
bug or enhancement label. Publishing needs authenticated gh access and a known CLI commit.
Review the draft for secrets first.

Run "localdev help issue bug|request" for the required JSON fields.`,

  "issue bug": `Report a shared-CLI bug. Project-only adapter bugs belong in that project.

Usage: localdev issue bug [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]

JSON input requires: title, summary, expected, steps, impact.
  steps       A string or array of step strings.
  evidence    Optional sanitized logs or status details.
  cleanup     Optional stop result and leftover process or file.
  causeTrace  Optional checked code paths and unknowns.
  verify      Optional observable fix check.

The command adds project and CLI commits. --session adds safe session details.
--submit publishes with the bug label; without it, you get a draft. Remove
credentials and personal data from your input.

Example:
  localdev issue bug --input report.json --session <session-id>`,

  "issue request": `Request a reusable capability in the shared localdev CLI.

Usage: localdev issue request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]

JSON input requires: title, task, desired, whyShared, acceptance.
  task        Agent task and current manual steps.
  desired     What the agent should be able to run or see.
  whyShared   Why the shared CLI should own this across projects.
  acceptance  How to prove it works.
  impact      Optional work blocked or repeated.
  evidence    Optional related work or sanitized evidence.

--submit publishes with the enhancement label; without it, you get a draft.

Example:
  localdev issue request --input request.json`,
};

export function helpFor(args: string[]): string | null {
  if (!args.length) return help.overview;
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h") return help.overview;
  if (first === "help") {
    const topic = rest.join(" ") || "overview";
    if (!help[topic]) throw new Error(`Unknown help topic: ${topic}. Run localdev help for commands.`);
    return help[topic];
  }
  if (args.includes("--help") || args.includes("-h")) {
    const topic = first === "issue" && (rest[0] === "bug" || rest[0] === "request")
      ? `issue ${rest[0]}` : first;
    if (!help[topic]) throw new Error(`Unknown help topic: ${topic}. Run localdev help for commands.`);
    return help[topic];
  }
  return null;
}
