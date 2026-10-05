/** One command's options. Every other `--flag` is rejected, so a typo never silently changes what a command does. */
export interface CommandOptions {
    /** The command name, for the unknown-option error and its help hint. */
    command: string;
    /** Flags that take a value: the next argument, which must exist and not start with "--". */
    values?: string[];
    /** Flags that take a value only when the next argument does not start with "--" (startup --replace [ID]). */
    optionalValues?: string[];
    booleans?: string[];
    missingValue(flag: string): Error;
    /** A repeated flag fails with this; without it the first occurrence wins. */
    duplicate?(flag: string): Error;
    /** A positional argument fails with this; without it positionals are returned in order. */
    positional?(token: string): Error;
}
export interface ParsedArgs {
    /** Each given flag (with its "--") and its value; true for a boolean or an optional value left out. */
    flags: Record<string, string | true>;
    positionals: string[];
}
/** The one argument parser: every command checks its flags here, before it reads or changes any session. */
export declare function parseArgs(args: string[], options: CommandOptions): ParsedArgs;
