type Diagnostic = {
    version: 1;
    stage: string;
    kind: string;
};
/** Exact, closed public structures. Never copy arbitrary nested error fields. */
export declare function sanitizeHistoryDiagnostic(value: unknown, role: 'hint' | 'failure'): Diagnostic | null;
export declare function sanitizeHistorySelectionStops(value: unknown): Record<string, number> | null;
export {};
