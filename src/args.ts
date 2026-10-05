import { helpHint } from "./help.js";

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
export function parseArgs(args: string[], options: CommandOptions): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith("--")) {
      if (options.positional) throw options.positional(token);
      positionals.push(token);
      continue;
    }
    let value: string | true = true;
    const next = args[index + 1];
    const hasValue = next !== undefined && next !== "" && !next.startsWith("--");
    if (options.values?.includes(token)) {
      if (!hasValue) throw options.missingValue(token);
      value = next;
      index++;
    } else if (options.optionalValues?.includes(token)) {
      if (hasValue) { value = next; index++; }
    } else if (!options.booleans?.includes(token)) {
      throw new Error(`Unknown ${options.command} option: ${token}. ${helpHint(options.command)}`);
    }
    if (token in flags) {
      if (options.duplicate) throw options.duplicate(token);
      continue;
    }
    flags[token] = value;
  }
  return { flags, positionals };
}
