import { spawnSync } from "node:child_process";
/**
 * Runs a command synchronously and returns its stdout. Some sandboxes (new Codex Cloud environments) report EPERM
 * from every synchronous spawn even when the command ran and exited 0, so the exit status decides success, not the
 * spawn error (EPERM only). Like execFileSync, it throws when the command failed or never ran; the error carries `code` (e.g.
 * ENOENT when the command is missing), `status` and `stderr`.
 */
export function runSync(command, args, options = {}) {
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    // Only that known EPERM report is overridden; any other spawn error, or missing output, still fails.
    const spawnError = result.error?.code;
    if (result.status === 0 && result.signal === null && (!spawnError || spawnError === "EPERM") && typeof result.stdout === "string") {
        return result.stdout;
    }
    const reason = result.error ? result.error.message : result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw Object.assign(new Error(`${command} ${args.join(" ")} failed (${reason})${result.stderr ? `: ${result.stderr.trim()}` : ""}`), {
        code: spawnError, status: result.status, stderr: result.stderr ?? "",
    });
}
