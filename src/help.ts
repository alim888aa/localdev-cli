const help: Record<string, string> = {
  overview: `localdev — isolated local test sessions for any project

Usage:
  localdev startup [fixture] [--project DIR] [--adapter FILE] [--replace [ID] | --parallel] [--no-outbound]
  localdev status [ID]
  localdev stop ID
  localdev fault ID PORT --mode pause|fail|slow|hold|kill [--ms N] [--count N]
  localdev fault ID PORT --release [--count N]
  localdev fault ID [PORT] --clear
  localdev issue bug|request [options]
  localdev help [command]

Examples:
  localdev startup
  localdev startup messages
  localdev status
  localdev stop <session-id>
  localdev fault <session-id> dataconnect --mode pause
  localdev issue bug

Run "localdev help startup|status|stop|fault|issue" for details. Each project defines
its own fixtures in local.adapter.mjs and should list them in its agent guide.`,

  startup: `Start an isolated app and emulator session from a project checkout.

Usage: localdev startup [fixture] [--project DIR] [--adapter FILE] [--replace [ID] | --parallel] [--no-outbound]

  fixture         Project-defined test data; omit for the adapter's defaultFixture.
  --project DIR   Project checkout; defaults to the current directory.
  --adapter FILE  Adapter file; defaults to <project>/local.adapter.mjs.
  --replace [ID] Stop one healthy matching session, then start a fresh one.
  --parallel     Deliberately keep matching sessions and start another.
  --no-outbound  Block the app, its workers and the seed from reaching outside
                 hosts (Node processes; loopback and emulators still work).

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
  localdev startup catalog --project /path/to/project
  localdev startup --no-outbound

--no-outbound refuses non-loopback connections from every Node process of the
session (error code ELOCALDEV_OUTBOUND) and clears HTTP(S)_PROXY. It survives
fault --mode kill restarts; status shows outbound: "blocked". Java, Go and
other non-Node children are not enforced on a Mac. It is a guard against
accidental calls to paid or real services, not a sandbox.`,

  status: `Show localdev sessions and their health.

Usage: localdev status [ID]

  localdev status       List every session on this machine.
  localdev status <id>  Show one session. A stopped or unknown ID prints
                        [{"id": "<id>", "state": "gone"}] and exits 0.

The JSON includes checkout commit, URLs, ports, logs, and process health.
A degraded session may have a dead server or a port owned by another process.
Active localdev faults are listed under faults, with their unit and remaining
count; proxiedPorts names the ports fail, slow and hold work on, and proxy:
"unreachable" means the fault proxy died (its faults are gone, the session is
degraded). A paused service
still accepts TCP connections, so its process shows reachable: true; check
faults, not reachable, to see what is frozen.`,

  stop: `Stop and clean up one localdev session.

Usage: localdev stop ID

Get the ID from startup or status. The command stops only that session's owned
processes and removes its files and data. Paused services are resumed first,
so stop never waits on a frozen process. If ownership cannot be verified, it
keeps the receipt for inspection instead of claiming success.

Example:
  localdev stop <session-id>`,

  fault: `Make one service of a session fail on purpose, then restore it.

Usage:
  localdev fault ID PORT --mode pause            Freeze the service listening on PORT.
  localdev fault ID PORT --mode kill             Kill it like a crash; it restarts with its data.
  localdev fault ID PORT --mode fail [--count N] Reset requests, like an outage.
  localdev fault ID PORT --mode slow --ms N [--count N]  Delay each request by N ms.
  localdev fault ID PORT --mode hold [--count N] Park requests until released.
  localdev fault ID PORT --release [--count N]   Let held requests through, oldest first.
  localdev fault ID PORT --clear                 End PORT's fault; held requests go on.
  localdev fault ID --clear                      End every fault.

PORT is a port name from the session's receipt, such as app or dataconnect.

pause and kill act on the session's own process listening on PORT and work on
any port. pause freezes it: clients connect but get no response, and it keeps
its data. kill sends SIGKILL, starts it again from the session's recorded
command, and returns once it is ready; files under the session's data dir
survive, in-memory state does not. A process serving several ports is paused
or killed with all of them; the fault's sharedPorts lists them.

fail, slow and hold work on ports the project's adapter puts behind the
session's fault proxy (status lists them under proxiedPorts). They count
requests on HTTP ports and connections on TCP ports; status shows the unit and
the remaining count. With --count N a fault applies to the next N, then clears
itself (requests it holds stay held until released). Without it, the fault
lasts until --clear.

stop ends every fault, resumes paused services and drops held requests.

Examples:
  localdev fault <session-id> api --mode slow --ms 3000
  localdev fault <session-id> api --mode hold
  localdev fault <session-id> api --release --count 1
  localdev fault <session-id> dataconnect --mode kill
  localdev fault <session-id> --clear`,

  issue: `Draft or publish a standard issue for the shared localdev CLI.

Usage:
  localdev issue bug [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]
  localdev issue request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]

Run from the affected project's checkout. Without --input, a terminal user
answers prompts. Unattended agents supply a JSON file. Without --submit, the
command prints a draft; a terminal user can confirm publication after seeing
it. --submit publishes directly to the public repo alim888aa/localdev-cli with
a bug or enhancement label; it needs authenticated gh and a known CLI commit.
Without gh, open the printed link to file the draft from a browser.
Every report must say who sent it: reporter { source, agentId, project }.
Issues are public: review the draft for secrets and personal data first.

Run "localdev help issue bug|request" for the required JSON fields.`,

  "issue bug": `Report a shared-CLI bug. Project-only adapter bugs belong in that project.

Usage: localdev issue bug [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]

JSON input requires: reporter, title, summary, expected, steps, impact.
  reporter    { source, agentId, project }: where you run (e.g. Codex Cloud),
              your agent or session ID, and the project you were working on.
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

JSON input requires: reporter, title, task, desired, whyShared, acceptance.
  reporter    { source, agentId, project }, as for bugs.
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
