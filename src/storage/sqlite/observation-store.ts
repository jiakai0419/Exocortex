import { randomUUID } from "node:crypto";
import { compareObservation, isNativeRecord, retainSourceRepresentation, OBSERVATION_POLICY } from "../../core/lark-observation.js";
import type { StoredRecord } from "./ingestion-types.js";
import { quoteSql, sqliteQuery } from "./sqlite-executor.js";

type Acquisition = { attempt: string; startedAtMs: number; basis?: Map<string, number>; confirm?: boolean; contextKey?: string };

/** Read outside the transaction, then bind the complete local row and its ABA
 * generation inside it. The result is internal data, never approval input. */
function prepareObservationRecords(dbPath: string, records: StoredRecord[], acquisition?: Acquisition): StoredRecord[] {
  const native = records.filter(isNativeRecord);
  if (!native.length) return records;
  const rows = sqliteQuery(dbPath, `SELECT r.*, s.generation AS observation_generation,s.evidence_generation,
    s.candidate_json, s.candidate_generation, s.candidate_attempt, s.candidate_policy, s.candidate_context, s.candidate_observed_at_ms
    FROM records r JOIN record_observation_state s ON s.record_id=r.id
    WHERE r.source_id='lark.im' AND r.external_id IN (${native.map(r => quoteSql(r.external_id)).join(",")});`, "read observation basis");
  const byId = new Map(rows.map(({ observation_generation, evidence_generation, candidate_json, candidate_generation, candidate_attempt, candidate_policy, candidate_context, candidate_observed_at_ms, ...before }) =>
    [before.external_id, { before, generation: Number(observation_generation), evidenceGeneration: Number(evidence_generation), candidate_json, candidate_generation, candidate_attempt, candidate_policy, candidate_context, candidate_observed_at_ms }]));
  const attempt = acquisition?.attempt || randomUUID(), observedAtMs = Date.now();
  return records.map(original => {
    if (!isNativeRecord(original)) return original;
    const { observation: ignored, ...incoming } = original;
    const state = byId.get(original.external_id), before = state?.before || null;
    let record: StoredRecord = { ...incoming }, action: NonNullable<StoredRecord["observation"]>["action"] = "accept", reason = "new_observation";
    // Missing native provenance is a legacy row, not inferred from its shape.
    // Its original version/repair behavior stays intact until an explicit newer
    // native observation replaces it.
    if (before && !isNativeRecord(before as StoredRecord)) return original;
    if (before) {
      const comparison = compareObservation(before as StoredRecord, incoming);
      if (acquisition?.basis && acquisition.basis.get(original.external_id) !== state!.generation) {
        action = "stale"; reason = "local_generation_changed";
      } else if (comparison.identity !== "same") { action = "conflict"; reason = "identity_conflict"; }
      else if (comparison.version === "older") { action = "older"; reason = "source_timestamp_regressed"; }
      else if (comparison.equivalent) {
        action = "equivalent"; reason = comparison.representation;
        record = retainSourceRepresentation(before as StoredRecord, incoming);
      } else if (comparison.version === "newer") { reason = "newer_observed_timestamp"; }
      else {
        action = "conflict"; reason = comparison.representation === "unverified" ? "source_comparison_unverified" : "same_version_source_difference";
        // Only a later, separately acquired history observation may confirm an
        // ambiguous source. A replay, retry or two entries in one page cannot.
        if (acquisition?.confirm && acquisition.contextKey && state!.candidate_context === acquisition.contextKey && comparison.version === "equal" && state!.candidate_json
          && state!.candidate_generation === state!.generation && state!.candidate_policy === OBSERVATION_POLICY && state!.candidate_attempt !== attempt
          && state!.candidate_observed_at_ms < acquisition.startedAtMs) {
          const pending = JSON.parse(state!.candidate_json) as StoredRecord;
          if (compareObservation(pending, incoming).equivalent) { action = "accept"; reason = "repeated_observation_not_latest_proof"; }
        }
      }
    }
    return { ...record, observation: { action, reason, before, generation: state?.generation ?? null, evidenceGeneration: state?.evidenceGeneration ?? null,
      incoming, attempt, observedAtMs, contextKey: acquisition?.contextKey || null } };
  });
}

/** The preparation basis is checked even for a no-op, so preview and commit
 * cannot silently decide against different local facts. */
function observationGuardSql(records: StoredRecord[]) {
  const observed = records.filter(record => record.observation);
  if (!observed.length) return "";
  return `CREATE TEMP TABLE IF NOT EXISTS __observation_guard (allowed INTEGER NOT NULL CHECK(allowed=1));
    ${observed.map(record => {
      const o = record.observation!, before = o.before;
      const condition = before ? `EXISTS (SELECT 1 FROM records r JOIN record_observation_state s ON s.record_id=r.id
        WHERE r.id=${Number(before.id)} AND s.generation=${o.generation} AND s.evidence_generation=${o.evidenceGeneration}
          AND ${Object.entries(before).map(([key,value]) => `r.${key} IS ${typeof value === "number" ? value : quoteSql(value)}`).join(" AND ")})`
        : `NOT EXISTS (SELECT 1 FROM records WHERE source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)})`;
      return `INSERT INTO __observation_guard SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END;`;
    }).join("\n")}`;
}

/** Before the final record write, so SQLite changes() still refers to records.
 * All statements share the caller's fenced transaction. Current/previous/pending
 * are bounded slots, not an assertion that every historical edit is retained. */
function observationEvidenceSql(records: StoredRecord[], admission = "1") {
  return records.filter(record => record.observation?.before).map(record => {
    const o = record.observation!, accepted = o.action === "accept" || o.action === "equivalent";
    const candidate = JSON.stringify(o.incoming);
    if (Buffer.byteLength(candidate) > 4 * 1024 * 1024) throw new Error("observation evidence capacity exceeded");
    return `UPDATE record_observation_state SET evidence_generation=evidence_generation+1,
      last_observed_json=${quoteSql(candidate)},
      previous_json=${o.action === "accept" ? quoteSql(JSON.stringify(o.before)) : "previous_json"},
      candidate_json=${accepted ? "NULL" : quoteSql(candidate)},
      candidate_generation=${accepted || o.action === "stale" ? "NULL" : String(o.generation)},
      candidate_attempt=${accepted ? "NULL" : quoteSql(o.attempt)},
      candidate_policy=${accepted ? "NULL" : quoteSql(OBSERVATION_POLICY)},
      candidate_context=${accepted ? "NULL" : quoteSql(o.contextKey)},
      candidate_observed_at_ms=${accepted ? "NULL" : o.observedAtMs},
      reason=${quoteSql(o.reason)}, observed_at_ms=${o.observedAtMs}
      WHERE record_id=${Number(o.before!.id)} AND (${admission});`;
  }).join("\n");
}

function observationAllowsSql(record: StoredRecord): string | null {
  return record.observation ? ["accept", "equivalent"].includes(record.observation.action) ? "1" : "0" : null;
}

export { prepareObservationRecords, observationGuardSql, observationEvidenceSql, observationAllowsSql };
export type { Acquisition };
