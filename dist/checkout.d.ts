/**
 * A checkout's canonical path, so a symlinked checkout and its target are one project wherever paths are compared
 * (startup's receipt, duplicate matching, issue --session). A path that cannot be resolved, such as a removed
 * checkout, stays absolute as given unless mustExist, which rethrows (startup needs the checkout).
 */
export declare function projectRoot(dir: string, { mustExist }?: {
    mustExist?: boolean | undefined;
}): Promise<string>;
/** The checkout's HEAD commit, or null outside Git. */
export declare function gitCommit(root: string): string | null;
