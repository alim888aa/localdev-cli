/** The temp dir path for a session of this state dir; record it before makeTempDir creates it. */
export declare function tempDirFor(stateRoot: string, id: string): Promise<string>;
/**
 * Create a session's temp dir (0700) and its identity marker. An existing path fails instead of being reused. If the
 * chmod or marker write fails, the dir this call just made is rolled back (rollBack) and TempDirSetupError thrown.
 */
export declare function makeTempDir(stateRoot: string, id: string): Promise<void>;
/**
 * stop's removal of a session's temp dir: only once proven (see unproven). Anything else is left in place and named on
 * stderr (skip-and-alert), so a stop always finishes and never deletes what isn't the session's.
 */
export declare function removeTempDir(stateRoot: string, id: string, dir: string): Promise<void>;
/**
 * Remove this state dir's proven temp dirs whose session has no session dir (say, an older localdev stopped it). A
 * temp dir is made after its session dir and removed before it, so a live session's is never taken, lock or not. A dir
 * that can't be proven isn't this state dir's and is left alone quietly. Never throws: a failure is named on stderr.
 */
export declare function sweepOrphanTempDirs(stateRoot: string, hasSessionDir: (id: string) => Promise<boolean>): Promise<void>;
