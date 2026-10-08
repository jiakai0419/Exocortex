/** Write only a locally constructed or already sanitized public message.
 * @param {{stdout:{write:(text:string)=>unknown}, stderr:{write:(text:string)=>unknown}}} streams
 * @param {{format?:string, code:"invalid_arguments"|"execution_failed", message:string, reason?:string, textPrefix?:string, requestBudget?:Record<string,number|string|null>}} error
 */
export function writeCliError(streams: {
    stdout: {
        write: (text: string) => unknown;
    };
    stderr: {
        write: (text: string) => unknown;
    };
}, { format, code, message, reason, textPrefix, requestBudget }: {
    format?: string;
    code: "invalid_arguments" | "execution_failed";
    message: string;
    reason?: string;
    textPrefix?: string;
    requestBudget?: Record<string, number | string | null>;
}): void;
/** One invocation captures its clock and path roots before any work starts. */
export function createCommandContext(overrides?: {}): {
    cwd: string;
    root: string;
    now: any;
    startedAtMs: any;
    env: any;
    stdout: any;
    stderr: any;
    provided: any;
    route: any;
    resolvePath(value: any, { explicit }?: {
        explicit?: boolean | undefined;
    }): string;
};
export const PROJECT_ROOT: string;
export class CliUsageError extends Error {
    constructor(message: any);
}
/** A deliberately public message constructed locally, never remote stderr. */
export class CliExecutionError extends Error {
    /** @param {string} message @param {string} [reason] */
    constructor(message: string, reason?: string);
    reason: string | undefined;
}
