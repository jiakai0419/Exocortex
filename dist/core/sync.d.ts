export type TimeCursor = {
    kind?: string;
    meaning?: string;
    source_time_precision?: string;
    created_at_ms?: number;
    message_id?: string;
    updated_at?: string;
    [key: string]: unknown;
};
export type CursorRecord = {
    occurred_at_ms: number;
    external_id: string;
    [key: string]: unknown;
};
export type WindowOptions = {
    startMs: number;
    endMs: number;
    stableHorizonMs?: number;
    endExplicit?: boolean;
};
export type ScopeWithCursor = {
    cursor?: TimeCursor | null;
};
export type TimeCursorOptions = {
    endMs: number;
    precisionMs: number;
    sourceTimePrecision: string;
    kind?: string;
    meaning?: string;
    messageId?: string;
    now?: () => Date;
};
export type PaginationOptions<TPage, TItem> = {
    fetchPage: (pageToken: string) => TPage;
    getItems: (page: TPage) => TItem[];
    getHasMore: (page: TPage) => boolean;
    getPageToken: (page: TPage) => string;
    maxPages: number;
    missingPageTokenMessage: string;
    maxPagesMessage: (maxPages: number) => string;
};
export declare function compareRecordToCursor(record: CursorRecord, cursor: TimeCursor | null | undefined, fallbackStartMs: number): number;
export declare function windowRecordsAfterCursor<TRecord extends CursorRecord>(records: TRecord[], cursor: TimeCursor | null | undefined, startMs: number, endMs: number, filterFn?: ((record: TRecord) => boolean) | null): TRecord[];
export declare function floorToPrecisionMs(ms: number, precisionMs: number): number;
export declare function timeCursorAfter({ endMs, precisionMs, sourceTimePrecision, kind, meaning, messageId, now, }: TimeCursorOptions): TimeCursor;
export declare function stableWindowEndMs(opts: WindowOptions, startMs: number): number;
export declare function timeWindow(scope: ScopeWithCursor, opts: WindowOptions): {
    startMs: number;
    endMs: number;
};
export declare function readPaginatedPages<TPage, TItem>({ fetchPage, getItems, getHasMore, getPageToken, maxPages, missingPageTokenMessage, maxPagesMessage, }: PaginationOptions<TPage, TItem>): {
    items: TItem[];
    pages: number;
};
