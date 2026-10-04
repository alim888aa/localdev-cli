import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readReceipt } from "./state.js";
const REPO = "alim888aa/localdev-cli";
const required = {
    bug: [
        ["title", "Short problem title"],
        ["summary", "What happened"],
        ["expected", "What should happen"],
        ["steps", "Steps to reproduce"],
        ["impact", "What work is affected"],
    ],
    request: [
        ["title", "Short request title"],
        ["task", "Agent task and current manual steps"],
        ["desired", "Desired result"],
        ["whyShared", "Why the shared CLI should handle this"],
        ["acceptance", "How to verify it works"],
    ],
};
function parse(args) {
    const kind = args.shift();
    if (kind !== "bug" && kind !== "request") {
        throw new Error("Usage: localdev issue bug|request [--input FILE] [--project DIR] [--session ID] [--cli-ref SHA] [--submit]");
    }
    const options = {};
    const valueFlags = new Set(["--input", "--project", "--session", "--cli-ref"]);
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (flag === "--submit") {
            if (options.submit)
                throw new Error("Duplicate --submit");
            options.submit = true;
        }
        else if (valueFlags.has(flag)) {
            const value = args[++i];
            if (!value || value.startsWith("--"))
                throw new Error(`Missing value for ${flag}`);
            const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            if (options[key])
                throw new Error(`Duplicate ${flag}`);
            options[key] = value;
        }
        else {
            throw new Error(`Unknown issue option: ${flag}`);
        }
    }
    return { kind, options };
}
function field(fields, name, mandatory = true) {
    const value = fields[name];
    if (value === undefined || value === null || value === "") {
        if (mandatory)
            throw new Error(`Missing issue field: ${name}`);
        return "";
    }
    if (name === "steps" && Array.isArray(value) && value.every((item) => typeof item === "string")) {
        if (!value.length || value.some((item) => !item.trim()))
            throw new Error("Invalid issue field: steps");
        return value.map((item, index) => `${index + 1}. ${item.trim()}`).join("\n");
    }
    if (typeof value !== "string" || !value.trim())
        throw new Error(`Invalid issue field: ${name}`);
    return value.trim();
}
function gitCommit(root) {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    catch {
        return null;
    }
}
function cliSourceCommit() {
    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    try {
        const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return path.resolve(topLevel) === path.resolve(packageRoot) ? gitCommit(packageRoot) : null;
    }
    catch {
        return null;
    }
}
async function installedCliCommit() {
    const sourceCommit = cliSourceCommit();
    if (sourceCommit)
        return sourceCommit;
    const installedPath = fileURLToPath(import.meta.url);
    const storeFolder = installedPath.split(path.sep).find((part) => part.startsWith("@local-tools+cli@git+"));
    const match = storeFolder?.match(/localdev-cli\.git\+([0-9a-f]{40})$/);
    if (match)
        return match[1];
    return null;
}
async function collectFields(kind, input) {
    if (input) {
        const value = JSON.parse(await fs.readFile(path.resolve(input), "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("Issue input must be a JSON object");
        return value;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Use --input FILE for unattended issue reports");
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const fields = {};
        for (const [key, prompt] of required[kind])
            fields[key] = await rl.question(`${prompt}: `);
        fields.evidence = await rl.question("Sanitized evidence or relevant error (optional): ");
        return fields;
    }
    finally {
        rl.close();
    }
}
function render(kind, fields, context) {
    for (const [key] of required[kind])
        field(fields, key);
    const shortTitle = field(fields, "title").replace(/\s+/g, " ");
    if (shortTitle.length > 150 || shortTitle.includes("\n"))
        throw new Error("Issue title is too long");
    const title = `${kind === "bug" ? "bug" : "request"}: ${shortTitle}`;
    const contextLines = [
        `- Project checkout: \`${context.projectRoot}\``,
        `- Project commit: \`${context.projectCommit ?? "unknown"}\``,
        `- localdev version: \`${context.cliVersion}\``,
        `- localdev Git ref: \`${context.cliRef ?? "unknown"}\``,
        `- Runtime: \`Node ${process.version}, ${process.platform}/${process.arch}\``,
    ];
    if (context.session) {
        contextLines.push(`- Session: \`${context.session.id}\` (${context.session.fixture}, ${context.session.state}; checkout commit \`${context.session.commit ?? "unknown"}\`)`);
    }
    const evidence = field(fields, "evidence", false);
    const body = kind === "bug" ? [
        "## What went wrong", field(fields, "summary"),
        "## Impact", field(fields, "impact"),
        "## Expected result", field(fields, "expected"),
        "## Reproduce it", field(fields, "steps"),
        "## Environment", ...contextLines,
        "## Evidence", evidence || "None supplied; add sanitized logs or status if available.",
        "## Cleanup", field(fields, "cleanup", false) || "Unknown; check `localdev stop <id>` if a session was created.",
        "## Cause trace", field(fields, "causeTrace", false) || "Unknown; investigation needed.",
        "## How to verify a fix", field(fields, "verify", false) || "Repeat the repro steps and check the expected result.",
    ] : [
        "## Agent task", field(fields, "task"),
        "## Impact", field(fields, "impact", false) || "Unknown; confirm during triage.",
        "## Desired result", field(fields, "desired"),
        "## Why the shared CLI?", field(fields, "whyShared"),
        "## Acceptance check", field(fields, "acceptance"),
        "## Project context", ...contextLines,
        "## Related work", evidence || "None supplied.",
    ];
    return { title, body: `${body.join("\n\n")}\n`, label: kind === "bug" ? "bug" : "enhancement" };
}
/** Thrown only when GitHub definitely created nothing, so the caller can print the draft for someone else. */
class NotPublishedError extends Error {
}
function ghFailure(error) {
    const failure = error;
    const stderr = String(failure.stderr ?? "").trim();
    const message = stderr || (error instanceof Error ? error.message : String(error));
    // gh missing, gh not logged in (exit 4), or an HTTP 4xx rejection: the request created nothing.
    const definite = failure.code === "ENOENT" || failure.status === 4 || /\bHTTP 4\d\d\b/.test(stderr);
    return { definite, message };
}
/** After an ambiguous POST, look for an issue with this exact title and body created in the last 15 minutes. */
function findCreated(title, body) {
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const recent = JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/issues?state=all&sort=created&direction=desc&per_page=30&since=${since}`], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }));
    return recent.find((item) => !item.pull_request && item.title === title && (item.body ?? "").trim() === body.trim()) ?? null;
}
// REST rather than `gh issue create`: cloud sandboxes block GitHub GraphQL but allow REST.
async function publish(title, body, label) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "localdev-issue-"));
    const bodyFile = path.join(temporary, "body.md");
    try {
        await fs.writeFile(bodyFile, body, { mode: 0o600 });
        let created;
        try {
            created = JSON.parse(execFileSync("gh", [
                "api", `repos/${REPO}/issues`, "-X", "POST",
                "-f", `title=${title}`, "-F", `body=@${bodyFile}`, "-f", `labels[]=${label}`,
            ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
        }
        catch (error) {
            const failure = ghFailure(error);
            if (failure.definite)
                throw new NotPublishedError(failure.message);
            // The request may have reached GitHub before the response was lost.
            try {
                created = findCreated(title, body);
            }
            catch {
                created = null;
            }
            if (!created)
                throw new Error(`Publishing outcome unknown (${failure.message}). Check ${REPO} for an issue titled "${title}" before retrying.`);
        }
        if (!created)
            throw new Error(`Publishing outcome unknown. Check ${REPO} for an issue titled "${title}" before retrying.`);
        const url = created.html_url;
        let saved;
        try {
            saved = JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/issues/${created.number}`], {
                encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            }));
        }
        catch {
            throw new Error(`Issue was created at ${url}, but readback failed; inspect it before retrying`);
        }
        if (saved.title !== title || saved.html_url !== url || !saved.labels.some((item) => item.name === label)) {
            throw new Error(`Issue was created at ${url}, but its title or label did not match; inspect it before retrying`);
        }
        return url;
    }
    finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
async function publishOrPrintDraft(report) {
    try {
        const url = await publish(report.title, report.body, report.label);
        console.log(`Created ${url} [${report.label}]`);
    }
    catch (error) {
        if (!(error instanceof NotPublishedError))
            throw error;
        console.log(`# ${report.title}\n\n${report.body}\nLabel: ${report.label}\n`);
        throw new Error(`GitHub rejected the issue, so nothing was created in ${REPO}. The draft is printed above for someone with access to file. gh said: ${error.message}`);
    }
}
export async function issueCommand(args) {
    const { kind, options } = parse([...args]);
    const projectRoot = path.resolve(options.project ?? process.cwd());
    const fields = await collectFields(kind, options.input);
    const sessionId = options.session;
    const receipt = sessionId ? await readReceipt(sessionId) : null;
    if (receipt && receipt.projectRoot !== projectRoot) {
        throw new Error(`Session ${sessionId} belongs to ${receipt.projectRoot}; use --project to select that checkout`);
    }
    const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
    const cliRef = options.cliRef ?? await installedCliCommit();
    if (cliRef && !/^[0-9a-f]{7,40}$/.test(cliRef))
        throw new Error("--cli-ref must be a Git SHA (7 to 40 lowercase hex characters)");
    const report = render(kind, fields, {
        projectRoot,
        projectCommit: gitCommit(projectRoot),
        cliVersion: packageJson.version,
        cliRef,
        session: receipt ? { id: receipt.id, fixture: receipt.fixture, state: receipt.state, commit: receipt.commit } : null,
    });
    if (options.submit) {
        if (!cliRef)
            throw new Error("Cannot submit without the installed localdev Git commit; pass --cli-ref SHA");
        await publishOrPrintDraft(report);
        return;
    }
    console.log(`# ${report.title}\n\n${report.body}\nLabel: ${report.label}\n`);
    if (process.stdin.isTTY && process.stdout.isTTY) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const answer = await rl.question("Publish this issue to the private localdev repo? [y/N] ");
            if (answer.trim().toLowerCase() === "y") {
                if (!cliRef)
                    throw new Error("Cannot submit without the installed localdev Git commit; rerun with --cli-ref SHA");
                await publishOrPrintDraft(report);
                return;
            }
        }
        finally {
            rl.close();
        }
    }
    console.log("Draft only. Add --submit to publish from an unattended agent.");
}
