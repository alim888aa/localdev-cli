/**
 * Runs a command synchronously and returns its stdout. Some sandboxes (new Codex Cloud environments) report EPERM
 * from every synchronous spawn even when the command ran and exited 0, so the exit status decides success, not the
 * spawn error (EPERM only). Like execFileSync, it throws when the command failed or never ran; the error carries `code` (e.g.
 * ENOENT when the command is missing), `status` and `stderr`.
 */
export declare function runSync(command: string, args: string[], options?: {
    cwd?: string;
}): string;
