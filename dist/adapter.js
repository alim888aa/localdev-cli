import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkServiceName } from "./proxy.js";
// The adapter contract (docs/adapter.md): what a project's local.adapter.mjs must look like and what its session
// plan may contain. Unique port names are checked by state.ts reserveSession, which allocates them.
/** Import a project adapter and check its shape, including proxyPorts (always returned, empty when none). */
export async function loadAdapter(adapterPath) {
    const imported = await import(pathToFileURL(adapterPath).href);
    const adapter = imported.default;
    if (!adapter || !Array.isArray(adapter.ports) || typeof adapter.createSession !== "function") {
        throw new Error(`Invalid adapter: ${adapterPath}`);
    }
    const proxyPorts = adapter.proxyPorts ?? {};
    if (typeof proxyPorts !== "object" || Array.isArray(proxyPorts))
        throw new Error(`Invalid adapter proxyPorts: ${adapterPath}`);
    for (const [name, unit] of Object.entries(proxyPorts)) {
        if (!adapter.ports.includes(name))
            throw new Error(`Adapter proxyPorts names unknown port ${name}; declare it in ports too`);
        if (unit !== "http" && unit !== "tcp")
            throw new Error(`Adapter proxyPorts.${name} must be "http" or "tcp"`);
    }
    return { adapter, proxyPorts };
}
/** Check what createSession returned before anything from it runs. */
export function checkPlan(plan) {
    if ("cleanupPaths" in plan) {
        throw new Error("Adapter cleanupPaths must be declared before createSession");
    }
    if (!plan.services?.length)
        throw new Error("Adapter did not define any services");
    if (new Set(plan.services.map((item) => item.name)).size !== plan.services.length) {
        throw new Error("Service names must be unique");
    }
    for (const service of plan.services)
        checkServiceName(service.name);
    for (const service of plan.services)
        launchDescription(service.launchMode);
}
/** Paths an adapter may ask stop to delete: directly in the project root and named for this session only. */
export function checkCleanupPaths(paths, id, root) {
    for (const item of paths) {
        if (!path.isAbsolute(item) || path.dirname(item) !== root || !path.basename(item).startsWith(`.local-cli-${id}.`)) {
            throw new Error(`Adapter cleanup path must be ID-scoped in project root: ${item}`);
        }
    }
}
const launchModeDescriptions = new Map([
    ["next-turbopack", "next dev --turbopack"],
    ["next-webpack", "next dev --webpack"],
    ["vite", "vite"],
    ["tanstack-start", "tanstack start"],
]);
/** What status shows for a service's launchMode: a safe label, never the command (which may hold secrets). */
export function launchDescription(mode) {
    if (mode === undefined)
        return null;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(mode)) {
        throw new Error("Service launchMode must be a short, lowercase mode ID without arguments or secrets");
    }
    return launchModeDescriptions.get(mode) ?? mode;
}
