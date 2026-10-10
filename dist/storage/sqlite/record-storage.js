import { quoteSql } from "./sqlite-executor.js";
import { mergeLarkNameProjectionSql } from "./lark-name-projection.js";
import { compareObservation, isNativeRecord } from "../../core/lark-observation.js";
import { observationAllowsSql, observationEvidenceSql, observationGuardSql, prepareObservationRecords } from "./observation-store.js";
/** Encode adapter evidence without inferring ordering from a token's spelling.
 * Decimal revisions are ordered; opaque tokens retain exact string identity. */
function encodeSourceVersion(value) {
    if (!value || typeof value !== "object")
        throw new Error("source version requires a token or revision");
    const hasToken = Object.prototype.hasOwnProperty.call(value, "token");
    const hasRevision = Object.prototype.hasOwnProperty.call(value, "revision");
    if (hasToken === hasRevision)
        throw new Error("source version requires exactly one token or revision");
    if (hasToken) {
        if (typeof value.token !== "string")
            throw new Error("source version token must be a string");
        return `opaque:${JSON.stringify(value.token)}`;
    }
    const revision = value.revision;
    if ((typeof revision === "number" && !Number.isSafeInteger(revision)) ||
        !["number", "string", "bigint"].includes(typeof revision) || !/^\d+$/.test(String(revision))) {
        throw new Error("source revision must be a nonnegative integer with exact precision");
    }
    return BigInt(String(revision)).toString();
}
function normalizeExternalVersion(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const text = String(value).trim();
    if (!text)
        return null;
    if (/^\d+$/.test(text))
        return BigInt(text).toString();
    return text;
}
function preferIncomingRecord(current, incoming) {
    const currentVersion = normalizeExternalVersion(current.external_version);
    const incomingVersion = normalizeExternalVersion(incoming.external_version);
    if (currentVersion === null && incomingVersion !== null)
        return true;
    if (currentVersion !== null && incomingVersion === null)
        return false;
    if (currentVersion === incomingVersion && isNativeRecord(current) && isNativeRecord(incoming)) {
        if (!compareObservation(current, incoming).equivalent)
            throw new Error("response contains ambiguous duplicate source observations");
        // Selection must not depend on pagination or response order.
        return JSON.stringify(incoming) < JSON.stringify(current);
    }
    if (currentVersion === null && incomingVersion === null)
        return true;
    if (/^\d+$/.test(String(currentVersion)) && /^\d+$/.test(String(incomingVersion))) {
        return BigInt(String(incomingVersion)) >= BigInt(String(currentVersion));
    }
    if (currentVersion !== incomingVersion)
        throw new Error("ambiguous unordered source versions in one batch");
    if (current.expected_external_version !== incoming.expected_external_version) {
        throw new Error("ambiguous expected source versions in one batch");
    }
    return true;
}
function normalizeStoredRecords(records, sourceId) {
    const deduped = new Map();
    for (const original of records) {
        if (original.expected_external_version !== undefined && original.expected_external_version !== null &&
            typeof original.expected_external_version !== "string")
            throw new Error("expected_external_version must be undefined, null, or a stored version string");
        if (sourceId && original.source_id !== sourceId) {
            throw new Error(`record ${original.external_id} belongs to ${original.source_id}, expected source ${sourceId}`);
        }
        const record = {
            ...original,
            external_version: normalizeExternalVersion(original.external_version),
        };
        const key = `${record.source_id}\u0000${record.external_id}`;
        const current = deduped.get(key);
        if (current && (current.expected_external_version !== undefined || record.expected_external_version !== undefined) &&
            (current.record_type !== record.record_type || current.expected_external_version !== record.expected_external_version)) {
            throw new Error("conflicting CAS candidates for one source identity");
        }
        if (!current || preferIncomingRecord(current, record))
            deduped.set(key, record);
    }
    return [...deduped.values()];
}
/** A repair must not silently choose between unordered conflicting page items. */
function normalizeBoundedReplayRecords(records, sourceId) {
    const seen = new Map();
    for (const original of records) {
        const incoming = { ...original, external_version: normalizeExternalVersion(original.external_version) };
        const current = seen.get(incoming.external_id);
        if (current && !(isNativeRecord(current) && isNativeRecord(incoming) && compareObservation(current, incoming).equivalent)
            && (current.raw_json !== incoming.raw_json || current.content_hash !== incoming.content_hash)) {
            const a = current.external_version;
            const b = incoming.external_version;
            if (a === null || b === null || !/^\d+$/.test(a) || !/^\d+$/.test(b) || a === b) {
                throw new Error("bounded replay response contains ambiguous duplicate facts");
            }
        }
        if (!current || preferIncomingRecord(current, incoming))
            seen.set(incoming.external_id, incoming);
    }
    return normalizeStoredRecords(records, sourceId);
}
function numericVersionSql(valueSql) {
    return `(${valueSql} IS NOT NULL AND ${valueSql} <> '' AND ${valueSql} NOT GLOB '*[^0-9]*')`;
}
function normalizedNumericVersionSql(valueSql) {
    return `(CASE WHEN ltrim(${valueSql}, '0') = '' THEN '0' ELSE ltrim(${valueSql}, '0') END)`;
}
function versionCanReplaceSql(existingAlias, incomingAlias, expectedVersionSql = "NULL") {
    const existing = `${existingAlias}.external_version`;
    const incoming = `${incomingAlias}.external_version`;
    const existingNumeric = normalizedNumericVersionSql(existing);
    const incomingNumeric = normalizedNumericVersionSql(incoming);
    return `(
    ${existing} IS NULL
    OR (
      ${incoming} IS NOT NULL
      AND (
        ${incoming} = ${existing}
        OR (${existing} = ${expectedVersionSql}
          AND NOT ${numericVersionSql(existing)} AND NOT ${numericVersionSql(incoming)})
        OR (
          ${numericVersionSql(existing)}
          AND ${numericVersionSql(incoming)}
          AND (
            length(${incomingNumeric}) > length(${existingNumeric})
            OR (
              length(${incomingNumeric}) = length(${existingNumeric})
              AND ${incomingNumeric} >= ${existingNumeric} COLLATE BINARY
            )
          )
        )
      )
    )
  )`;
}
const MUTABLE_RECORD_COLUMNS = [
    "external_version",
    "record_type",
    "occurred_at",
    "occurred_at_ms",
    "actor_id",
    "container_id",
    "direction",
    "title",
    "body",
    "content_hash",
    "canonical_json",
    "raw_json",
];
const REVIEW_EFFECTIVE_COLUMNS = ["id", "source_id", "first_seen_scope_id", "external_id", ...MUTABLE_RECORD_COLUMNS];
function mergedCanonicalSql(existingAlias, incomingAlias) {
    const existing = existingAlias;
    const incoming = incomingAlias;
    return `(CASE WHEN ${existing}.source_id = 'lark.im' AND ${incoming}.source_id = 'lark.im'
    AND ${existing}.record_type = 'lark.im.message' AND ${incoming}.record_type = 'lark.im.message'
    THEN ${mergeLarkNameProjectionSql(`${existing}.canonical_json`, `${incoming}.canonical_json`, `${existing}.actor_id`, `${incoming}.actor_id`, `${existing}.container_id`, `${incoming}.container_id`, `${existing}.raw_json`, `${incoming}.raw_json`)}
    ELSE ${incoming}.canonical_json END)`;
}
function recordDiffSql(existingAlias, incomingAlias) {
    return `(${MUTABLE_RECORD_COLUMNS.map((column) => `${existingAlias}.${column} IS NOT ${column === "canonical_json"
        ? mergedCanonicalSql(existingAlias, incomingAlias) : `${incomingAlias}.${column}`}`).join(" OR ")})`;
}
function strictlyNewerVersionSql(existingAlias, incomingAlias) {
    const existing = `${existingAlias}.external_version`;
    const incoming = `${incomingAlias}.external_version`;
    const oldNumeric = normalizedNumericVersionSql(existing);
    const newNumeric = normalizedNumericVersionSql(incoming);
    return `(${numericVersionSql(existing)} AND ${numericVersionSql(incoming)} AND (
      length(${newNumeric}) > length(${oldNumeric}) OR (
        length(${newNumeric}) = length(${oldNumeric}) AND ${newNumeric} > ${oldNumeric} COLLATE BINARY
      )
  ))`;
}
/** A common source-selection predicate. Exact legacy approvals add their own
 * authorization gate; they do not define a different native source policy. */
function sourceCanReplaceSql(existing, incoming, expected = "NULL", strict = false, prepared = null) {
    const native = `${incoming}.source_id='lark.im' AND ${incoming}.record_type='lark.im.message'
    AND CASE WHEN json_valid(${incoming}.canonical_json) THEN json_extract(${incoming}.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END
    AND CASE WHEN json_valid(${existing}.canonical_json) THEN json_extract(${existing}.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END`;
    return `(CASE WHEN ${native} THEN (
    ${existing}.record_type IS ${incoming}.record_type AND ${existing}.container_id IS ${incoming}.container_id
    AND ${existing}.occurred_at_ms IS ${incoming}.occurred_at_ms AND
    ${prepared ?? `(${strictlyNewerVersionSql(existing, incoming)} OR (${existing}.external_version IS ${incoming}.external_version AND ${existing}.raw_json IS ${incoming}.raw_json))`}
  ) ELSE ${strict ? strictlyNewerVersionSql(existing, incoming) : versionCanReplaceSql(existing, incoming, expected)} END)`;
}
/** Read-only projection for existing exact replay targets. This is the actual
 * strict upsert expression, including its SQL-side name merge, rather than a
 * JavaScript approximation of what incoming canonical JSON might become.
 * Callers must require one returned row per selected existing target. */
function boundedReplayProjectionSql(records, options = {}) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
        throw new Error("bounded replay review requires between 1 and 100 records");
    }
    const initial = normalizeBoundedReplayRecords(records, "lark.im");
    const normalized = options.dbPath ? prepareObservationRecords(options.dbPath, initial) : initial;
    if (normalized.some((record) => record.record_type !== "lark.im.message" ||
        !Number.isSafeInteger(record.occurred_at_ms))) {
        throw new Error("invalid bounded replay review record");
    }
    const incomingColumns = ["source_id", "external_id", ...MUTABLE_RECORD_COLUMNS];
    const sameFact = "r.external_version IS i.external_version AND r.content_hash IS i.content_hash AND r.raw_json IS i.raw_json";
    const allow = options.legacyStrict ? strictlyNewerVersionSql("r", "i") : sourceCanReplaceSql("r", "i", "NULL", true, "COALESCE(i.allow_update, (" + strictlyNewerVersionSql("r", "i") + " OR (r.external_version IS i.external_version AND r.raw_json IS i.raw_json)))");
    return `WITH i (${incomingColumns.join(",")},allow_update) AS (VALUES
      ${normalized.map((record) => `(${incomingColumns.map((column) => column === "occurred_at_ms"
        ? String(record.occurred_at_ms) : quoteSql(record[column])).join(",")},${observationAllowsSql(record) ?? "NULL"})`).join(",\n")}
    ), projection AS MATERIALIZED (
      SELECT r.*, CASE WHEN ${allow} AND ${recordDiffSql("r", "i")} THEN 1 ELSE 0 END AS should_update,
        CASE WHEN ${sameFact} THEN 1 ELSE 0 END AS same_fact,
        ${MUTABLE_RECORD_COLUMNS.map((column) => `${column === "canonical_json"
        ? mergedCanonicalSql("r", "i") : `i.${column}`} AS incoming_${column}`).join(",\n")}
      FROM i JOIN records r ON r.source_id=i.source_id AND r.external_id=i.external_id
    ) SELECT id, external_id,
      CASE WHEN should_update=1 THEN 'update' WHEN same_fact=1 THEN 'duplicate' ELSE 'conflict' END AS outcome,
      json_object(${REVIEW_EFFECTIVE_COLUMNS.flatMap((column) => [quoteSql(column),
        MUTABLE_RECORD_COLUMNS.includes(column) ? `CASE WHEN should_update=1 THEN incoming_${column} ELSE ${column} END` : column]).join(",\n")}) AS after_json
      FROM projection ORDER BY id;`;
}
function recordUpdateSetSql() {
    return [...MUTABLE_RECORD_COLUMNS.map((column) => `${column} = ${column === "canonical_json"
            ? mergedCanonicalSql("records", "excluded") : `excluded.${column}`}`), "updated_at = excluded.updated_at"].join(",\n  ");
}
/** A failed explicit predecessor check aborts its surrounding transaction.
 * A CAS hint cannot repurpose an existing record's type. Ordinary writes retain
 * their version-protected type replacement semantics. */
function recordIdentityGuardSql(records) {
    if (!records.length)
        return "";
    return `${observationGuardSql(records)}
    CREATE TEMP TABLE IF NOT EXISTS __record_identity_guard (allowed INTEGER NOT NULL CHECK (allowed = 1));
    ${records.map((record) => {
        const identity = `source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)}`;
        const expected = record.expected_external_version;
        const sameType = expected === undefined ? "1"
            : `NOT EXISTS (SELECT 1 FROM records WHERE ${identity} AND record_type IS NOT ${quoteSql(record.record_type)})`;
        const cas = expected === undefined ? "1" : expected === null
            ? `NOT EXISTS (SELECT 1 FROM records WHERE ${identity} AND external_version IS NOT NULL)`
            : `EXISTS (SELECT 1 FROM records WHERE ${identity} AND external_version IS ${quoteSql(expected)})`;
        const ownScope = `EXISTS (SELECT 1 FROM sync_scopes WHERE id=${quoteSql(record.first_seen_scope_id)} AND source_id=${quoteSql(record.source_id)})`;
        return `INSERT INTO __record_identity_guard SELECT CASE WHEN ${sameType} AND ${cas} AND ${ownScope} THEN 1 ELSE 0 END;`;
    }).join("\n")}`;
}
function upsertRecordsSql(records, options = {}) {
    const initial = normalizeStoredRecords(records);
    const normalized = options.dbPath ? prepareObservationRecords(options.dbPath, initial) : initial;
    return recordIdentityGuardSql(normalized) + observationEvidenceSql(normalized) + normalized
        .map((record) => `
INSERT INTO records (
  source_id,
  first_seen_scope_id,
  external_id,
  external_version,
  record_type,
  occurred_at,
  occurred_at_ms,
  actor_id,
  container_id,
  direction,
  title,
  body,
  content_hash,
  canonical_json,
  raw_json,
  updated_at
)
VALUES (
  ${quoteSql(record.source_id)},
  ${quoteSql(record.first_seen_scope_id)},
  ${quoteSql(record.external_id)},
  ${quoteSql(record.external_version)},
  ${quoteSql(record.record_type)},
  ${quoteSql(record.occurred_at)},
  ${Number(record.occurred_at_ms)},
  ${quoteSql(record.actor_id)},
  ${quoteSql(record.container_id)},
  ${quoteSql(record.direction)},
  ${quoteSql(record.title)},
  ${quoteSql(record.body)},
  ${quoteSql(record.content_hash)},
  ${quoteSql(record.canonical_json)},
  ${quoteSql(record.raw_json)},
  ${quoteSql(new Date().toISOString())}
)
ON CONFLICT(source_id, external_id) DO UPDATE SET
  ${recordUpdateSetSql()}
WHERE ${sourceCanReplaceSql("records", "excluded", quoteSql(record.expected_external_version), options.strictVersionIncrease, observationAllowsSql(record))}
  AND ${options.legacyApprovalGate ? strictlyNewerVersionSql("records", "excluded") : "1"}
  AND ${recordDiffSql("records", "excluded")};
`)
        .join("\n");
}
function incomingRecordsSql(records) {
    const inserts = records
        .map((record) => `INSERT INTO __incoming_records (
  source_id, first_seen_scope_id, external_id, external_version, record_type,
  occurred_at, occurred_at_ms, actor_id, container_id, direction, title, body,
  content_hash, canonical_json, raw_json, expected_external_version, allow_update
) VALUES (
  ${quoteSql(record.source_id)},
  ${quoteSql(record.first_seen_scope_id)},
  ${quoteSql(record.external_id)},
  ${quoteSql(record.external_version)},
  ${quoteSql(record.record_type)},
  ${quoteSql(record.occurred_at)},
  ${Number(record.occurred_at_ms)},
  ${quoteSql(record.actor_id)},
  ${quoteSql(record.container_id)},
  ${quoteSql(record.direction)},
  ${quoteSql(record.title)},
  ${quoteSql(record.body)},
  ${quoteSql(record.content_hash)},
  ${quoteSql(record.canonical_json)},
  ${quoteSql(record.raw_json)},
  ${quoteSql(record.expected_external_version)},
  ${observationAllowsSql(record) ?? "NULL"}
);`)
        .join("\n");
    return `
CREATE TEMP TABLE __incoming_records (
  source_id TEXT NOT NULL,
  first_seen_scope_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_version TEXT,
  record_type TEXT NOT NULL,
  occurred_at TEXT,
  occurred_at_ms INTEGER,
  actor_id TEXT,
  container_id TEXT,
  direction TEXT,
  title TEXT,
  body TEXT,
  content_hash TEXT,
  canonical_json TEXT,
  raw_json TEXT NOT NULL,
  expected_external_version TEXT,
  allow_update INTEGER,
  PRIMARY KEY (source_id, external_id)
);
${inserts}
`;
}
function recordWritesSql(normalizedRecords, now) {
    const canReplace = sourceCanReplaceSql("r", "i", "i.expected_external_version", false, `COALESCE(i.allow_update, (${strictlyNewerVersionSql("r", "i")} OR (r.external_version IS i.external_version AND r.raw_json IS i.raw_json)))`);
    const differs = recordDiffSql("r", "i");
    return `
${recordIdentityGuardSql(normalizedRecords)}
${observationEvidenceSql(normalizedRecords, "EXISTS (SELECT 1 FROM __run_fence_guard)")}
${incomingRecordsSql(normalizedRecords)}
    CREATE TEMP TABLE __write_effects (
      inserted INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      duplicate INTEGER NOT NULL,
      conflicts INTEGER NOT NULL
    );
    INSERT INTO __write_effects (inserted, updated, duplicate, conflicts)
    SELECT
      COALESCE(SUM(CASE WHEN r.id IS NULL THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND ${canReplace} AND ${differs} THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND COALESCE(i.allow_update,1)<>0 AND NOT (${canReplace} AND ${differs}) THEN 1 ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND i.allow_update=0 THEN 1 ELSE 0 END), 0)
    FROM __incoming_records i
    LEFT JOIN records r
      ON r.source_id = i.source_id
     AND r.external_id = i.external_id
    WHERE EXISTS (SELECT 1 FROM __run_fence_guard);
    INSERT INTO records (
      source_id, first_seen_scope_id, external_id, external_version, record_type,
      occurred_at, occurred_at_ms, actor_id, container_id, direction, title, body,
      content_hash, canonical_json, raw_json, updated_at
    )
    SELECT
      i.source_id, i.first_seen_scope_id, i.external_id, i.external_version, i.record_type,
      i.occurred_at, i.occurred_at_ms, i.actor_id, i.container_id, i.direction, i.title, i.body,
      i.content_hash, i.canonical_json, i.raw_json, ${quoteSql(now)}
    FROM __incoming_records i
    WHERE EXISTS (SELECT 1 FROM __run_fence_guard)
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      ${recordUpdateSetSql()}
    WHERE ${sourceCanReplaceSql("records", "excluded", "(SELECT expected_external_version FROM __incoming_records candidate WHERE candidate.source_id=excluded.source_id AND candidate.external_id=excluded.external_id)", false, `(SELECT COALESCE(allow_update, (${strictlyNewerVersionSql("records", "excluded")} OR (records.external_version IS excluded.external_version AND records.raw_json IS excluded.raw_json))) FROM __incoming_records candidate WHERE candidate.source_id=excluded.source_id AND candidate.external_id=excluded.external_id)`)}
      AND ${recordDiffSql("records", "excluded")};
`;
}
export { REVIEW_EFFECTIVE_COLUMNS, boundedReplayProjectionSql, encodeSourceVersion, normalizeExternalVersion, normalizeStoredRecords, normalizeBoundedReplayRecords, numericVersionSql, versionCanReplaceSql, upsertRecordsSql, recordWritesSql };
