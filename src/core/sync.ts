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

export function compareRecordToCursor(
  record: CursorRecord,
  cursor: TimeCursor | null | undefined,
  fallbackStartMs: number,
) {
  const hasCursor = cursor?.created_at_ms !== undefined && cursor?.created_at_ms !== null;
  const cursorMs = Number(hasCursor ? cursor.created_at_ms : fallbackStartMs - 1);
  const cursorId = String(cursor?.message_id ?? "");
  if (record.occurred_at_ms > cursorMs) return 1;
  if (record.occurred_at_ms < cursorMs) return -1;
  return String(record.external_id).localeCompare(cursorId);
}

export function windowRecordsAfterCursor<TRecord extends CursorRecord>(
  records: TRecord[],
  cursor: TimeCursor | null | undefined,
  startMs: number,
  endMs: number,
  filterFn: ((record: TRecord) => boolean) | null = null,
) {
  return records
    .filter((record) => Number.isFinite(record.occurred_at_ms))
    .filter((record) => record.occurred_at_ms <= endMs)
    .filter((record) => compareRecordToCursor(record, cursor, startMs) > 0)
    .filter((record) => (filterFn ? filterFn(record) : true))
    .sort((a, b) => a.occurred_at_ms - b.occurred_at_ms || a.external_id.localeCompare(b.external_id));
}

export function floorToPrecisionMs(ms: number, precisionMs: number) {
  if (!Number.isFinite(ms)) throw new Error(`invalid time: ${ms}`);
  if (!Number.isFinite(precisionMs) || precisionMs <= 0) {
    throw new Error(`invalid cursor precision: ${precisionMs}`);
  }
  return Math.floor(ms / precisionMs) * precisionMs;
}

export function timeCursorAfter({
  endMs,
  precisionMs,
  sourceTimePrecision,
  kind = "time_cursor/v1",
  meaning = "scanned_until_inclusive",
  messageId = "",
  now = () => new Date(),
}: TimeCursorOptions): TimeCursor {
  return {
    kind,
    meaning,
    source_time_precision: sourceTimePrecision,
    created_at_ms: floorToPrecisionMs(endMs, precisionMs),
    message_id: messageId,
    updated_at: now().toISOString(),
  };
}

export function stableWindowEndMs(opts: WindowOptions, startMs: number) {
  const guardMs = opts.endExplicit ? 0 : Number(opts.stableHorizonMs || 0);
  return Math.max(startMs, opts.endMs - guardMs);
}

export function timeWindow(scope: ScopeWithCursor, opts: WindowOptions) {
  const startMs = Number(scope.cursor?.created_at_ms ?? opts.startMs);
  return {
    startMs,
    endMs: stableWindowEndMs(opts, startMs),
  };
}

export function readPaginatedPages<TPage, TItem>({
  fetchPage,
  getItems,
  getHasMore,
  getPageToken,
  maxPages,
  missingPageTokenMessage,
  maxPagesMessage,
}: PaginationOptions<TPage, TItem>) {
  const items: TItem[] = [];
  let pageToken = "";
  let hasMore = false;
  let pages = 0;
  do {
    pages += 1;
    const page = fetchPage(pageToken);
    items.push(...getItems(page));
    hasMore = getHasMore(page);
    pageToken = getPageToken(page);
    if (hasMore && !pageToken) throw new Error(missingPageTokenMessage);
    if (hasMore && pages >= maxPages) throw new Error(maxPagesMessage(maxPages));
  } while (hasMore);
  return { items, pages };
}
