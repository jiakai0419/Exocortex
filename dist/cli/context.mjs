import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export class CliUsageError extends Error {
    constructor(message) { super(message); this.name = "CliUsageError"; }
}
/** A deliberately public message constructed locally, never remote stderr. */
export class CliExecutionError extends Error {
    constructor(message) { super(message); this.name = "CliExecutionError"; }
}
/** One invocation captures its clock and path roots before any work starts. */
export function createCommandContext(overrides = {}) {
    const cwd = resolve(overrides.cwd || process.cwd());
    const root = resolve(overrides.root || PROJECT_ROOT);
    const now = overrides.now || Date.now;
    return {
        ...overrides, cwd, root, now,
        startedAtMs: overrides.startedAtMs ?? now(),
        env: overrides.env || process.env,
        stdout: overrides.stdout || process.stdout,
        stderr: overrides.stderr || process.stderr,
        provided: overrides.provided || new Set(),
        route: overrides.route || "",
        resolvePath(value, { explicit = false } = {}) {
            return resolve(explicit ? cwd : root, value);
        },
    };
}
