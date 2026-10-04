/** null means procfs is unavailable; false means no verified owned listener. */
export declare function linuxListenerOwned(port: number, group: number, procRoot?: string): boolean | null;
/** Every PID holding a TCP listener on the port, whoever owns it; null means procfs is unavailable. */
export declare function linuxListenerPids(port: number, procRoot?: string): number[] | null;
