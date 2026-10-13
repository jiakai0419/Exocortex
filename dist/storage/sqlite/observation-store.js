import { randomUUID } from "node:crypto";
import { compareObservation, isNativeRecord, retainSourceRepresentation, OBSERVATION_POLICY } from "../../core/lark-observation.js";
import { quoteSql, sqliteQuery } from "./sqlite-executor.js";
/** One source decision for accepted records and incomplete detail descriptors.
 * Callers own acquisition, bounded evidence storage and transaction/CAS guards.
 * In particular, this function never treats a descriptor as a stored record or
 * a repeated observation as proof of the latest remote state. */
function evaluateObservation(before, incoming, state, acquisition) {
    const { observation: ignored, ...source } = incoming;
    let record = { ...source }, action = "accept", reason = "new_observation", preserveCandidate = false;
    if (!before)
        return { record, action, reason, preserveCandidate };
    const comparison = compareObservation(before, source);
    if (acquisition.basis && acquisition.basis.get(source.external_id) !== state?.generation) {
        return { record, action: "stale", reason: "local_generation_changed", preserveCandidate };
    }
    const qualified = Boolean(state?.candidate_context && state.candidate_json
        && typeof state.candidate_attempt === "string" && state.candidate_attempt.length > 0
        && Number.isSafeInteger(state.candidate_observed_at_ms) && state.candidate_observed_at_ms >= 0
        && state.candidate_generation === state.generation && state.candidate_policy === OBSERVATION_POLICY);
    const pending = qualified ? JSON.parse(state.candidate_json) : null;
    const pendingComparison = pending ? compareObservation(pending, source) : null;
    const matchesCandidate = pendingComparison?.equivalent === true && pendingComparison.version === "equal";
    // An acquisition ID binds one source observation and context. Replaying it
    // cannot rewrite the first candidate's time, or give different evidence the
    // original acquisition's qualification.
    if (qualified && state.candidate_attempt === acquisition.attempt
        && (!matchesCandidate || state.candidate_context !== (acquisition.contextKey || null))) {
        throw new Error("observation acquisition identity reused");
    }
    if (comparison.identity !== "same") {
        action = "conflict";
        reason = "identity_conflict";
    }
    else if (comparison.version === "older") {
        action = "older";
        reason = "source_timestamp_regressed";
    }
    else if (comparison.equivalent) {
        action = "equivalent";
        reason = comparison.representation;
        record = retainSourceRepresentation(before, source, () => { reason = "equivalent_projection_capacity_deferred"; });
    }
    else if (comparison.version === "newer") {
        reason = "newer_observed_timestamp";
    }
    else {
        action = "conflict";
        reason = comparison.version === "unordered" ? "source_version_unordered"
            : comparison.representation === "unverified" ? "source_comparison_unverified" : "same_version_source_difference";
        // Only a later, separately acquired and context-qualified observation may
        // confirm an ambiguous source. A replay or two entries in one page cannot.
        if (acquisition.confirm && acquisition.contextKey && qualified && comparison.version === "equal"
            && state.candidate_context === acquisition.contextKey && state.candidate_attempt !== acquisition.attempt
            && typeof acquisition.attempt === "string" && acquisition.attempt.length > 0
            && Number.isSafeInteger(acquisition.startedAtMs) && state.candidate_observed_at_ms < acquisition.startedAtMs
            && matchesCandidate) {
            action = "accept";
            reason = "repeated_observation_not_latest_proof";
        }
        // Ordinary equivalent retries may retain an inert old context but cannot
        // refresh its qualification. An exact same-attempt replay also retains its
        // first observation time; only a later independent acquisition can confirm.
        if (action === "conflict" && comparison.version === "equal" && qualified && matchesCandidate
            && (!acquisition.confirm || state.candidate_attempt === acquisition.attempt))
            preserveCandidate = true;
    }
    return { record, action, reason, preserveCandidate };
}
/** Read outside the transaction, then bind the complete local row and its ABA
 * generation inside it. The result is internal data, never approval input. */
function prepareObservationRecords(dbPath, records, acquisition) {
    const native = records.filter(isNativeRecord);
    if (!native.length)
        return records;
    const rows = sqliteQuery(dbPath, `SELECT r.*, s.generation AS observation_generation,s.evidence_generation,
    s.candidate_json, s.candidate_generation, s.candidate_attempt, s.candidate_policy, s.candidate_context, s.candidate_observed_at_ms
    FROM records r JOIN record_observation_state s ON s.record_id=r.id
    WHERE r.source_id='lark.im' AND r.external_id IN (${native.map(r => quoteSql(r.external_id)).join(",")});`, "read observation basis");
    const byId = new Map(rows.map(({ observation_generation, evidence_generation, candidate_json, candidate_generation, candidate_attempt, candidate_policy, candidate_context, candidate_observed_at_ms, ...before }) => [before.external_id, { before, generation: Number(observation_generation), evidenceGeneration: Number(evidence_generation), candidate_json, candidate_generation, candidate_attempt, candidate_policy, candidate_context, candidate_observed_at_ms }]));
    const attempt = acquisition?.attempt || randomUUID(), observedAtMs = Date.now();
    const selectedAcquisition = { ...acquisition, attempt, startedAtMs: acquisition?.startedAtMs ?? observedAtMs };
    return records.map(original => {
        if (!isNativeRecord(original))
            return original;
        const { observation: ignored, ...incoming } = original;
        const state = byId.get(original.external_id), before = state?.before || null;
        // Missing native provenance is a legacy row, not inferred from its shape.
        // Its original version/repair behavior stays intact until an explicit newer
        // native observation replaces it.
        if (before && !isNativeRecord(before))
            return original;
        const { record, action, reason, preserveCandidate } = evaluateObservation(before, incoming, state || null, selectedAcquisition);
        return { ...record, observation: { action, reason, before, generation: state?.generation ?? null, evidenceGeneration: state?.evidenceGeneration ?? null,
                incoming, attempt, observedAtMs, contextKey: acquisition?.contextKey || null, preserveCandidate } };
    });
}
/** The preparation basis is checked even for a no-op, so preview and commit
 * cannot silently decide against different local facts. */
function observationGuardSql(records) {
    const observed = records.filter(record => record.observation);
    if (!observed.length)
        return "";
    return `CREATE TEMP TABLE IF NOT EXISTS __observation_guard (allowed INTEGER NOT NULL CHECK(allowed=1));
    ${observed.map(record => {
        const o = record.observation, before = o.before;
        const condition = before ? `EXISTS (SELECT 1 FROM records r JOIN record_observation_state s ON s.record_id=r.id
        WHERE r.id=${Number(before.id)} AND s.generation=${o.generation} AND s.evidence_generation=${o.evidenceGeneration}
          AND ${Object.entries(before).map(([key, value]) => `r.${key} IS ${typeof value === "number" ? value : quoteSql(value)}`).join(" AND ")})`
            : `NOT EXISTS (SELECT 1 FROM records WHERE source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)})`;
        return `INSERT INTO __observation_guard SELECT CASE WHEN ${condition} THEN 1 ELSE 0 END;`;
    }).join("\n")}`;
}
/** Before the final record write, so SQLite changes() still refers to records.
 * All statements share the caller's fenced transaction. Current/previous/pending
 * are bounded slots, not an assertion that every historical edit is retained. */
function observationEvidenceSql(records, admission = "1") {
    return records.filter(record => record.observation?.before).map(record => {
        const o = record.observation, accepted = o.action === "accept" || o.action === "equivalent";
        const candidate = JSON.stringify(o.incoming);
        const oversized = Buffer.byteLength(candidate) > 4 * 1024 * 1024;
        // An equivalent source already has its complete representative in records.
        // Do not copy an oversized replay envelope, but invalidate old candidates
        // and advance evidence generation exactly as for any accepted observation.
        // A deferred projection needs its complete incoming evidence for recovery;
        // it cannot use this no-copy receipt or silently discard unknown fields.
        if (oversized && (o.action !== "equivalent" || o.reason === "equivalent_projection_capacity_deferred")) {
            throw new Error("observation evidence capacity exceeded");
        }
        return `UPDATE record_observation_state SET evidence_generation=evidence_generation+1,
      last_observed_json=${oversized ? "NULL" : quoteSql(candidate)},
      previous_json=${o.action === "accept" ? quoteSql(JSON.stringify(o.before)) : "previous_json"},
      candidate_json=${o.preserveCandidate ? "candidate_json" : accepted ? "NULL" : quoteSql(candidate)},
      candidate_generation=${o.preserveCandidate ? "candidate_generation" : accepted || o.action === "stale" ? "NULL" : String(o.generation)},
      candidate_attempt=${o.preserveCandidate ? "candidate_attempt" : accepted ? "NULL" : quoteSql(o.attempt)},
      candidate_policy=${o.preserveCandidate ? "candidate_policy" : accepted ? "NULL" : quoteSql(OBSERVATION_POLICY)},
      candidate_context=${o.preserveCandidate ? "candidate_context" : accepted ? "NULL" : quoteSql(o.contextKey)},
      candidate_observed_at_ms=${o.preserveCandidate ? "candidate_observed_at_ms" : accepted ? "NULL" : o.observedAtMs},
      reason=${quoteSql(oversized ? "equivalent_evidence_capacity_deferred" : o.reason)}, observed_at_ms=${o.observedAtMs}
      WHERE record_id=${Number(o.before.id)} AND (${admission});`;
    }).join("\n");
}
function observationAllowsSql(record) {
    return record.observation ? ["accept", "equivalent"].includes(record.observation.action) ? "1" : "0" : null;
}
export { evaluateObservation, prepareObservationRecords, observationGuardSql, observationEvidenceSql, observationAllowsSql };
