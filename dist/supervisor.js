import { spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const configPath = process.argv[2];
const config = JSON.parse(readFileSync(configPath, "utf8"));
unlinkSync(configPath);
const guard = spawn(process.execPath, [fileURLToPath(new URL("./guard.js", import.meta.url))], {
    stdio: "ignore",
});
guard.once("spawn", () => {
    writeFileSync(config.guardFile, String(guard.pid), { mode: 0o600 });
});
const command = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: ["ignore", "inherit", "inherit"],
});
const recordExit = (code, signal) => {
    writeFileSync(config.exitFile, JSON.stringify({ code, signal }), { mode: 0o600 });
};
command.once("exit", recordExit);
command.once("error", (error) => {
    writeFileSync(config.exitFile, JSON.stringify({ code: 1, signal: null, error: error.message }), { mode: 0o600 });
});
// Stay alive after the launcher exits so the CLI can safely stop its child group.
setInterval(() => undefined, 60_000);
