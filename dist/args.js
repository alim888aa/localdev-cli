import { helpHint } from "./help.js";
/** The one argument parser: every command checks its flags here, before it reads or changes any session. */
export function parseArgs(args, options) {
    const flags = {};
    const positionals = [];
    for (let index = 0; index < args.length; index++) {
        const token = args[index];
        if (!token.startsWith("--")) {
            if (options.positional)
                throw options.positional(token);
            positionals.push(token);
            continue;
        }
        let value = true;
        const next = args[index + 1];
        const hasValue = next !== undefined && next !== "" && !next.startsWith("--");
        if (options.values?.includes(token)) {
            if (!hasValue)
                throw options.missingValue(token);
            value = next;
            index++;
        }
        else if (options.optionalValues?.includes(token)) {
            if (hasValue) {
                value = next;
                index++;
            }
        }
        else if (!options.booleans?.includes(token)) {
            throw new Error(`Unknown ${options.command} option: ${token}. ${helpHint(options.command)}`);
        }
        if (token in flags) {
            if (options.duplicate)
                throw options.duplicate(token);
            continue;
        }
        flags[token] = value;
    }
    return { flags, positionals };
}
