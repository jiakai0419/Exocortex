import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC_ERROR_REASONS = new Set(["dependency_unavailable", "read_timeout", "read_failed", "invalid_response"]);
export class CliUsageError extends Error {
    constructor(message) { super(message); this.name = "CliUsageError"; }
}
/** A deliberately public message constructed locally, never remote stderr. */
export class CliExecutionError extends Error {
    /** @param {string} message @param {string} [reason] */
    constructor(message, reason) {
        super(message);
        this.name = "CliExecutionError";
        this.reason = PUBLIC_ERROR_REASONS.has(reason || "") ? reason : undefined;
    }
}
/** Write only a locally constructed or already sanitized public message.
 * @param {{stdout:{write:(text:string)=>unknown}, stderr:{write:(text:string)=>unknown}}} streams
 * @param {{format?:string, code:"invalid_arguments"|"execution_failed", message:string, reason?:string, textPrefix?:string, requestBudget?:Record<string,number|string|null>}} error
 */
export function writeCliError(streams, { format, code, message, reason, textPrefix = "", requestBudget }) {
    if (format === "json") {
        streams.stdout.write(`${JSON.stringify({ schema_version: 1, ok: false, error: { code, message,
                ...(PUBLIC_ERROR_REASONS.has(reason || "") ? { reason } : {}) },
            ...(requestBudget ? { request_budget: requestBudget } : {}) })}\n`);
    }
    else
        streams.stderr.write(`${textPrefix}${message}\n`);
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
