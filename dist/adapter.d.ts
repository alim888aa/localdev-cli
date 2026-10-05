import type { ProjectAdapter, ProxyUnit, SessionPlan } from "./types.js";
/** Import a project adapter and check its shape, including proxyPorts (always returned, empty when none). */
export declare function loadAdapter(adapterPath: string): Promise<{
    adapter: ProjectAdapter;
    proxyPorts: Record<string, ProxyUnit>;
}>;
/** Check what createSession returned before anything from it runs. */
export declare function checkPlan(plan: SessionPlan): void;
/** Paths an adapter may ask stop to delete: directly in the project root and named for this session only. */
export declare function checkCleanupPaths(paths: string[], id: string, root: string): void;
/** What status shows for a service's launchMode: a safe label, never the command (which may hold secrets). */
export declare function launchDescription(mode: string | undefined): string | null;
