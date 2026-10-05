#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { applyFault, clearFaults, faultRequest, releaseHeld } from "./fault.js";
import { helpFor, usage } from "./help.js";
import { issueCommand } from "./issue.js";
import { describeSession, startSession, stopSession } from "./session.js";
import { findReceipt, listReceipts } from "./state.js";
// Parse arguments, call the module that owns the command, print its JSON.
const usageError = () => new Error(usage());
/** The options a command accepts; a missing value is a usage error, a repeated flag keeps its first value. */
function parse(command, args, flags = {}) {
    return parseArgs(args, { command, missingValue: usageError, ...flags }).flags;
}
const print = (value) => console.log(JSON.stringify(value, null, 2));
function wholeNumber(raw, max, message) {
    if (raw === undefined)
        return undefined;
    const value = Number(raw);
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || value < 1 || value > max)
        throw new Error(message);
    return value;
}
async function startup(args) {
    const flags = parse("startup", args, {
        values: ["--project", "--adapter"], optionalValues: ["--replace"], booleans: ["--parallel", "--no-outbound"],
    });
    const replace = flags["--replace"];
    print(await startSession({
        fixture: args[0] && !args[0].startsWith("-") ? args[0] : undefined,
        project: flags["--project"],
        adapter: flags["--adapter"],
        replace,
        parallel: flags["--parallel"] === true,
        outbound: flags["--no-outbound"] ? "deny" : undefined,
    }));
}
async function status(args) {
    parse("status", args);
    const [id] = args;
    if (!id) {
        print(await Promise.all((await listReceipts()).map(describeSession)));
        return;
    }
    const receipt = await findReceipt(id);
    // stop removes the session, so a stopped or unknown ID is reported, not thrown (like stop's alreadyGone).
    print([receipt ? await describeSession(receipt) : { id, state: "gone" }]);
}
async function stop(args) {
    parse("stop", args);
    const [id] = args;
    if (!id)
        throw usageError();
    console.log(JSON.stringify(await stopSession(id)));
}
async function fault(args) {
    const flags = parse("fault", args, { values: ["--mode", "--ms", "--count"], booleans: ["--release", "--clear"] });
    const [id, second] = args;
    if (!id || id.startsWith("--"))
        throw usageError();
    const portName = second && !second.startsWith("--") ? second : undefined;
    const mode = flags["--mode"];
    const release = flags["--release"] === true;
    const clear = flags["--clear"] === true;
    if ([Boolean(mode), release, clear].filter(Boolean).length !== 1)
        throw new Error("Choose one of --mode, --release or --clear");
    const ms = wholeNumber(flags["--ms"], 600_000, "--ms must be a whole number from 1 to 600000");
    const count = wholeNumber(flags["--count"], Number.MAX_SAFE_INTEGER, "--count must be a positive whole number");
    if (clear) {
        if (count !== undefined || ms !== undefined)
            throw new Error("--clear takes no --ms or --count");
        print({ id, cleared: await clearFaults(id, portName) });
        return;
    }
    if (release) {
        if (!portName)
            throw new Error("Name the port whose held requests to release, e.g. localdev fault <id> api --release");
        if (ms !== undefined)
            throw new Error("--ms applies only to --mode slow");
        print({ id, ...(await releaseHeld(id, portName, count)) });
        return;
    }
    print({ id, fault: await applyFault(id, faultRequest(portName, mode, { ms, count })) });
}
async function main() {
    const argv = process.argv.slice(2);
    const help = helpFor(argv);
    if (help) {
        console.log(help);
        return;
    }
    const [command, ...args] = argv;
    if (command === "startup")
        await startup(args);
    else if (command === "status")
        await status(args);
    else if (command === "stop")
        await stop(args);
    else if (command === "fault")
        await fault(args);
    else if (command === "issue")
        await issueCommand(args);
    else
        throw usageError();
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
