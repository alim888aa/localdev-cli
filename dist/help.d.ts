/** The usage error text: every command, or one command's (issue) when its own arguments are wrong. */
export declare function usage(command?: "issue"): string;
/** Where an unknown option is pointed: the command's help topic. */
export declare function helpHint(command: string): string;
export declare function helpFor(args: string[]): string | null;
