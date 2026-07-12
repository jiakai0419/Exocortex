export class PaginationLimitError extends Error {
    code = "pagination_limit";
    maxPages;
    constructor(message, maxPages) {
        super(message);
        this.name = "PaginationLimitError";
        this.maxPages = maxPages;
    }
}
export function isPaginationLimitError(error) {
    return (error instanceof PaginationLimitError ||
        (typeof error === "object" && error !== null && error.code === "pagination_limit"));
}
export function compareRecordToCursor(record, cursor, fallbackStartMs) {
    const hasCursor = cursor?.created_at_ms !== undefined && cursor?.created_at_ms !== null;
    if (!Number.isFinite(record.occurred_at_ms)) {
        throw new Error(`invalid record occurred_at_ms: ${String(record.occurred_at_ms)}`);
    }
    const rawCursorMs = hasCursor ? cursor.created_at_ms : fallbackStartMs - 1;
    if (typeof rawCursorMs !== "number" || !Number.isFinite(rawCursorMs)) {
        const label = hasCursor ? "cursor.created_at_ms" : "fallback start";
        throw new Error(`invalid ${label}: ${String(rawCursorMs)}`);
    }
    const cursorMs = rawCursorMs;
    const cursorId = String(cursor?.message_id ?? "");
    if (record.occurred_at_ms > cursorMs)
        return 1;
    if (record.occurred_at_ms < cursorMs)
        return -1;
    return String(record.external_id).localeCompare(cursorId);
}
export function windowRecordsAfterCursor(records, cursor, startMs, endMs, filterFn = null) {
    return records
        .filter((record) => Number.isFinite(record.occurred_at_ms))
        .filter((record) => record.occurred_at_ms <= endMs)
        .filter((record) => compareRecordToCursor(record, cursor, startMs) > 0)
        .filter((record) => (filterFn ? filterFn(record) : true))
        .sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.external_id.localeCompare(b.external_id));
}
export function floorToPrecisionMs(ms, precisionMs) {
    if (!Number.isFinite(ms))
        throw new Error(`invalid time: ${ms}`);
    if (!Number.isFinite(precisionMs) || precisionMs <= 0) {
        throw new Error(`invalid cursor precision: ${precisionMs}`);
    }
    return Math.floor(ms / precisionMs) * precisionMs;
}
export function timeCursorAfter({ endMs, precisionMs, sourceTimePrecision, kind = "time_cursor/v1", meaning = "scanned_until_inclusive", messageId = "", now = () => new Date(), }) {
    return {
        kind,
        meaning,
        source_time_precision: sourceTimePrecision,
        created_at_ms: floorToPrecisionMs(endMs, precisionMs),
        message_id: messageId,
        updated_at: now().toISOString(),
    };
}
export function stableWindowEndMs(opts, startMs) {
    if (typeof startMs !== "number" || !Number.isFinite(startMs)) {
        throw new Error(`invalid window start: ${String(startMs)}`);
    }
    if (typeof opts.endMs !== "number" || !Number.isFinite(opts.endMs)) {
        throw new Error(`invalid window end: ${String(opts.endMs)}`);
    }
    const guardMs = opts.endExplicit ? 0 : Number(opts.stableHorizonMs || 0);
    if (!Number.isFinite(guardMs) || guardMs < 0) {
        throw new Error(`invalid stable horizon: ${String(opts.stableHorizonMs)}`);
    }
    return Math.max(startMs, opts.endMs - guardMs);
}
export function timeWindow(scope, opts) {
    const cursorStart = scope.cursor?.created_at_ms;
    if (cursorStart !== undefined && cursorStart !== null) {
        if (typeof cursorStart !== "number" || !Number.isFinite(cursorStart)) {
            throw new Error(`invalid cursor.created_at_ms: ${String(cursorStart)}`);
        }
    }
    const startMs = cursorStart ?? opts.startMs;
    if (typeof startMs !== "number" || !Number.isFinite(startMs)) {
        throw new Error(`invalid window start: ${String(startMs)}`);
    }
    return {
        startMs,
        endMs: stableWindowEndMs(opts, startMs),
    };
}
export function readPaginatedPages({ fetchPage, getItems, getHasMore, getPageToken, maxPages, missingPageTokenMessage, maxPagesMessage, }) {
    const items = [];
    let pageToken = "";
    let hasMore = false;
    let pages = 0;
    do {
        pages += 1;
        const page = fetchPage(pageToken);
        items.push(...getItems(page));
        hasMore = getHasMore(page);
        pageToken = getPageToken(page);
        if (hasMore && !pageToken)
            throw new Error(missingPageTokenMessage);
        if (hasMore && pages >= maxPages) {
            throw new PaginationLimitError(maxPagesMessage(maxPages), maxPages);
        }
    } while (hasMore);
    return { items, pages };
}
