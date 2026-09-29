/** null means procfs is unavailable; false means no verified owned listener. */
export declare function linuxListenerOwned(port: number, group: number, procRoot?: string): boolean | null;
