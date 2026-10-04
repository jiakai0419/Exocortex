/** Primitive parsing is shared; domain window, identity and effect rules are not a DSL. */
export function parseOptions(argv: any, specs: any, { context, allowAll, resolvePaths }?: {
    context?: {
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
    } | undefined;
    allowAll?: boolean | undefined;
    resolvePaths?: boolean | undefined;
}): {
    options: Record<string, any>;
    provided: Set<any>;
    help: boolean;
    all: boolean;
};
