import { quoteSql } from "./sqlite-executor.js";
const REVIEW_RECORD_COLUMNS = [
    "id", "source_id", "first_seen_scope_id", "external_id", "external_version", "record_type",
    "occurred_at", "occurred_at_ms", "received_at", "actor_id", "container_id", "direction",
    "title", "body", "content_hash", "canonical_json", "raw_json", "created_at", "updated_at",
];
const REVIEW_LIFETIME_MS = 30 * 60_000;
const nullableText = new Set(["external_version", "occurred_at", "actor_id", "container_id", "direction",
    "title", "body", "content_hash", "canonical_json"]);
function exactObject(value, required, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
        required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
        throw new Error("invalid maintenance review fence schema");
    }
}
function jsonText(value, objectOnly = false) {
    if (typeof value !== "string" || value.includes("\0"))
        return false;
    try {
        const parsed = JSON.parse(value);
        return !objectOnly || Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    }
    catch {
        return false;
    }
}
/** All predicates execute after BEGIN IMMEDIATE, before any business update.
 * This intentionally fences no-op selected rows too. The runtime clock is
 * SQLite's transaction-time clock, not a pre-API JavaScript timestamp. */
function reviewFenceSql(fence) {
    exactObject(fence, ["createdAtMs", "expiresAtMs", "sourceConfigJson", "sentActor", "records"], ["scopes"]);
    if (!Number.isSafeInteger(fence.createdAtMs) || fence.createdAtMs < 0 ||
        !Number.isSafeInteger(fence.expiresAtMs) || fence.expiresAtMs - fence.createdAtMs !== REVIEW_LIFETIME_MS ||
        !jsonText(fence.sourceConfigJson, true) ||
        !(fence.sentActor === null || typeof fence.sentActor === "string" && /^ou_[A-Za-z0-9_-]+$/.test(fence.sentActor)) ||
        !Array.isArray(fence.records) ||
        fence.records.length < 1 || fence.records.length > 100) {
        throw new Error("invalid maintenance review fence");
    }
    const ids = new Set();
    for (const row of fence.records) {
        exactObject(row, REVIEW_RECORD_COLUMNS);
        for (const column of REVIEW_RECORD_COLUMNS) {
            const value = row[column];
            const valid = column === "id" ? typeof value === "number" && Number.isSafeInteger(value) && value > 0
                : column === "occurred_at_ms" ? value === null || typeof value === "number" && Number.isSafeInteger(value)
                    : typeof value === "string" && !value.includes("\0") || value === null && nullableText.has(column);
            if (!valid)
                throw new Error("invalid maintenance review record snapshot");
        }
        if (row.source_id !== "lark.im" || row.record_type !== "lark.im.message" ||
            !row.external_id || !row.first_seen_scope_id || !jsonText(row.raw_json) ||
            row.canonical_json !== null && !jsonText(row.canonical_json) || ids.has(row.id)) {
            throw new Error("invalid maintenance review record identity");
        }
        if (row.direction !== null && row.direction !== "sent" && row.direction !== "received") {
            throw new Error("invalid maintenance review record direction");
        }
        ids.add(row.id);
    }
    if (fence.scopes !== undefined) {
        if (!Array.isArray(fence.scopes) || fence.scopes.length < 1 || fence.scopes.length > 100) {
            throw new Error("invalid maintenance review scopes");
        }
        const scopeIds = new Set();
        for (const scope of fence.scopes) {
            exactObject(scope, ["id", "source_id", "enabled", "config_json"]);
            if (typeof scope.id !== "string" || !scope.id || scope.id.includes("\0") || scope.source_id !== "lark.im" ||
                scope.enabled !== 1 || !jsonText(scope.config_json, true) || scopeIds.has(scope.id)) {
                throw new Error("invalid maintenance review scope snapshot");
            }
            scopeIds.add(scope.id);
        }
    }
    const nowMs = "(CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
    const sentRows = "source_id='lark.im' AND direction='sent'";
    const accountGuard = fence.sentActor === null ? `NOT EXISTS (SELECT 1 FROM records WHERE ${sentRows})`
        : `EXISTS (SELECT 1 FROM records WHERE ${sentRows} AND actor_id IS ${quoteSql(fence.sentActor)})
      AND NOT EXISTS (SELECT 1 FROM records WHERE ${sentRows} AND (
        actor_id IS NOT ${quoteSql(fence.sentActor)} OR canonical_json IS NOT NULL AND (
          json_extract(canonical_json,'$.sender_id') IS NOT NULL AND json_extract(canonical_json,'$.sender_id') IS NOT actor_id
          OR json_extract(canonical_json,'$.sender_id_type') IS NOT NULL AND json_extract(canonical_json,'$.sender_id_type') IS NOT 'open_id'
        )))`;
    return `CREATE TEMP TABLE __maintenance_review_fence (allowed INTEGER NOT NULL CHECK (allowed = 1));
    INSERT INTO __maintenance_review_fence SELECT CASE WHEN
      ${nowMs} >= ${fence.createdAtMs} AND ${nowMs} < ${fence.expiresAtMs}
      AND (SELECT COUNT(*) FROM pragma_table_info('records')) = ${REVIEW_RECORD_COLUMNS.length}
      AND NOT EXISTS (SELECT 1 FROM pragma_table_info('records') WHERE name NOT IN (${REVIEW_RECORD_COLUMNS.map(quoteSql).join(",")}))
      AND EXISTS (SELECT 1 FROM sources WHERE id='lark.im' AND enabled=1 AND config_json IS ${quoteSql(fence.sourceConfigJson)})
      AND (${accountGuard})
      THEN 1 ELSE 0 END;
    ${(fence.scopes || []).map((scope) => `INSERT INTO __maintenance_review_fence SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sync_scopes WHERE id IS ${quoteSql(scope.id)} AND source_id IS ${quoteSql(scope.source_id)}
        AND enabled IS ${scope.enabled} AND config_json IS ${quoteSql(scope.config_json)}
      ) THEN 1 ELSE 0 END;`).join("\n")}
    ${fence.records.map((row) => `INSERT INTO __maintenance_review_fence SELECT CASE WHEN EXISTS (
      SELECT 1 FROM records WHERE ${REVIEW_RECORD_COLUMNS.map((column) => `${column} IS ${quoteSql(row[column])}`).join(" AND ")}
      ) THEN 1 ELSE 0 END;`).join("\n")}`;
}
export { REVIEW_RECORD_COLUMNS, REVIEW_LIFETIME_MS, reviewFenceSql };
