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
    constructor(message: any);
}
