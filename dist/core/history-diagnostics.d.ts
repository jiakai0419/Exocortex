type TransportDiagnostic = {
    operation: string;
    execution: string;
    result_kind: string | null;
    result_code: number | null;
    remote_result: boolean;
    local_reason: string | null;
};
type Diagnostic = {
    version: 1;
    stage: string;
    kind: string;
    operation?: string;
    transport?: TransportDiagnostic;
};
export declare function isHistoryFailureOperation(value: unknown): value is string;
/** Exact, closed public structures. Never copy arbitrary nested error fields. */
export declare function sanitizeHistoryDiagnostic(value: unknown, role: 'hint' | 'failure'): Diagnostic | null;
export declare function sanitizeHistorySelectionStops(value: unknown): Record<string, number> | null;
export {};
