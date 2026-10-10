import { confirmInitialLarkAccountSql } from "./lark-account-binding.js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { quoteSql, sqlJson, sqliteQuery } from "./sqlite-executor.js";
import { acquireMaintenanceLock, releaseMaintenanceLock } from "./sync-locks.js";
import { RUN_FENCE_METADATA_KEY, scopeCursorJson, validateRecordCursor, cursorCanAdvanceSql, checkedRunId, runFenceGuardSql } from "./sync-run-fence.js";
import { normalizeStoredRecords, normalizeBoundedReplayRecords, normalizeExternalVersion, numericVersionSql, versionCanReplaceSql, upsertRecordsSql, recordWritesSql } from "./record-storage.js";
import { reviewFenceSql } from "./maintenance-review.js";
import { sourceProof } from "../../core/lark-observation.js";
import { prepareObservationRecords } from "./observation-store.js";
/** Commit one completely fetched, explicitly bounded repair without touching
 * normal runs, scope cursors, or freshness markers. Remote work belongs outside
 * this method; only this short transaction holds a maintenance lease. */
function commitBoundedReplayRecords(dbPath, options) {
    const { scope, initialSyncStartMs, startMs, endMs, planId, attemptId, selfIdHash, pages, fetchedCount } = options;
    for (const time of [initialSyncStartMs, startMs, endMs]) {
        if (!Number.isSafeInteger(time) || time < 100_000_000_000 || time > 253_402_300_799_999) {
            throw new Error("bounded replay requires modern epoch-millisecond timestamps");
        }
    }
    if (startMs < initialSyncStartMs || endMs <= startMs)
        throw new Error("invalid bounded replay window");
    if (scope.source_id !== "lark.im" || !scope.id.startsWith("lark.im.received.chat.") || scope.enabled !== 1) {
        throw new Error("bounded replay requires an enabled Lark received scope");
    }
    const config = JSON.parse(scope.config_json || "{}");
    if (!config || typeof config.chat_id !== "string" || !config.chat_id)
        throw new Error("bounded replay scope has no chat identity");
    if (!/^[a-f0-9]{64}$/.test(planId) || !/^[a-f0-9]{64}$/.test(selfIdHash) || !attemptId) {
        throw new Error("invalid bounded replay audit identity");
    }
    if (!Number.isSafeInteger(pages) || pages < 1 || !Number.isSafeInteger(fetchedCount) || fetchedCount < 0) {
        throw new Error("invalid bounded replay fetch evidence");
    }
    if (options.legacyApprovalGate && !options.reviewFence)
        throw new Error("legacy approval gate requires a review fence");
    const history = options.history;
    if (options.observationAcquisition && !history)
        throw new Error("history acquisition requires its checkpoint fence");
    const historyKey = history ? createHash("sha256").update(JSON.stringify({ scope, history, attemptId, records: options.records, initialSyncStartMs, startMs, endMs, planId, selfIdHash, pages, fetchedCount,
        reviewFence: options.reviewFence, acquisition: options.observationAcquisition ? { ...options.observationAcquisition, basis: [...options.observationAcquisition.basis] } : null })).digest("hex") : null;
    if (history) {
        if (![history.generation, history.afterId, history.sweepMaxId, history.completedSweeps, history.selectedId,
            history.nextSweepMaxId, history.startedAtMs].every(n => Number.isSafeInteger(n) && n >= 0)
            || history.selectedId < 1 || history.selectedId > history.nextSweepMaxId
            || options.records.length > 1 || !options.reviewFence || options.observationAcquisition?.attempt !== attemptId
            || options.observationAcquisition.confirm !== true || options.observationAcquisition.startedAtMs !== history.startedAtMs
            || !/^[a-f0-9]{64}$/.test(options.observationAcquisition.contextKey)
            || options.reviewFence.records.length !== 1 || options.reviewFence.records[0].id !== history.selectedId
            || options.records.some(record => record.external_id !== options.reviewFence.records[0].external_id)
            || ![null, "incomplete", "size_limit", "identity", "ambiguous", "missing", "fetch_unavailable"].includes(history.error)) {
            throw new Error("invalid historical recheck fence");
        }
        const receipt = sqliteQuery(dbPath, `SELECT last_attempt_id,last_result_json FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)};`, "read history receipt")[0];
        if (receipt?.last_attempt_id === attemptId) {
            const saved = JSON.parse(receipt.last_result_json);
            if (saved.history_key !== historyKey)
                throw new Error("history acquisition identity reused");
            return saved.effects;
        }
    }
    const records = prepareObservationRecords(dbPath, normalizeBoundedReplayRecords(options.records, scope.source_id), options.observationAcquisition);
    if (options.reviewFence?.mode === "names")
        throw new Error("bounded replay rejects a names review fence");
    const reviewFence = options.reviewFence === undefined ? "" : reviewFenceSql(options.reviewFence);
    if (options.reviewFence && !history && (options.reviewFence.records.length !== records.length || records.some((record) => !options.reviewFence.records.some((before) => before.source_id === record.source_id && before.external_id === record.external_id)))) {
        throw new Error("bounded replay review fence must cover every candidate exactly");
    }
    if (records.length > 10_000 || records.length > fetchedCount)
        throw new Error("bounded replay candidate limit exceeded");
    for (const record of records) {
        if (record.record_type !== "lark.im.message" || record.first_seen_scope_id !== scope.id ||
            record.container_id !== config.chat_id || !Number.isSafeInteger(record.occurred_at_ms) ||
            record.occurred_at_ms < startMs || record.occurred_at_ms > endMs) {
            throw new Error("bounded replay candidate is outside the selected scope or window");
        }
    }
    const exactTargets = options.exactTargets;
    if (exactTargets !== undefined && (!Array.isArray(exactTargets) || !exactTargets.length || exactTargets.length > 100 ||
        exactTargets.length !== records.length || new Set(exactTargets.map((target) => target.external_id)).size !== exactTargets.length ||
        exactTargets.some((target) => !Number.isSafeInteger(target.id) || target.id < 1 ||
            typeof target.external_id !== "string" || !target.external_id || target.container_id !== config.chat_id ||
            !Number.isSafeInteger(target.occurred_at_ms) || target.occurred_at_ms < startMs || target.occurred_at_ms > endMs ||
            typeof target.external_version !== "string" || !/^\d+$/.test(target.external_version) ||
            !records.some((record) => record.external_id === target.external_id && record.container_id === target.container_id &&
                record.occurred_at_ms === target.occurred_at_ms && record.expected_external_version === target.external_version)))) {
        throw new Error("invalid exact replay target fence");
    }
    // Never create or migrate a missing database as a side effect of a repair.
    const preflight = spawnSync("sqlite3", ["-readonly", resolve(dbPath)], {
        input: ".bail on\nPRAGMA query_only=ON;\nSELECT id FROM bounded_replay_runs LIMIT 0;\n",
        encoding: "utf8", timeout: 5000,
    });
    if (preflight.status !== 0 || preflight.error)
        throw new Error("bounded replay audit schema unavailable; migrate the existing database first");
    const auditId = randomUUID();
    const owner = `pid:${process.pid}:bounded-replay:${auditId}`;
    const lock = acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason: "bounded Lark replay commit" });
    if (!lock.acquired)
        throw new Error("bounded replay commit blocked by active locks");
    try {
        const statements = records.map((record) => `
      DELETE FROM __replay_before;
      INSERT INTO __replay_before (existed, same_fact)
      SELECT EXISTS (SELECT 1 FROM records WHERE source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)}),
             EXISTS (SELECT 1 FROM records WHERE source_id=${quoteSql(record.source_id)} AND external_id=${quoteSql(record.external_id)}
               AND external_version IS ${quoteSql(record.external_version)}
               AND content_hash IS ${quoteSql(record.content_hash)} AND raw_json IS ${quoteSql(record.raw_json)});
      ${upsertRecordsSql([record], { strictVersionIncrease: true, legacyApprovalGate: options.legacyApprovalGate })}
      INSERT INTO __replay_effects (changed, existed, same_fact)
      SELECT changes(), existed, same_fact FROM __replay_before;
    `).join("\n");
        options.reviewBeforeCommit?.();
        const rows = sqliteQuery(dbPath, `
      BEGIN IMMEDIATE;
      ${reviewFence}
      CREATE TEMP TABLE __replay_guard (allowed INTEGER NOT NULL CHECK (allowed=1));
      INSERT INTO __replay_guard SELECT CASE WHEN EXISTS (
        SELECT 1 FROM maintenance_locks WHERE name='global' AND owner=${quoteSql(owner)}
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ) AND NOT EXISTS (SELECT 1 FROM sync_locks) AND EXISTS (
        SELECT 1 FROM sync_scopes s JOIN sources src ON src.id=s.source_id
        WHERE s.id=${quoteSql(scope.id)} AND s.source_id=${quoteSql(scope.source_id)}
          AND s.enabled=1 AND src.enabled=1 AND s.config_json IS ${quoteSql(scope.config_json)}
          AND json_extract(src.config_json,'$.initial_sync_start_ms') IS ${initialSyncStartMs}
      ) THEN 1 ELSE 0 END;
      ${(exactTargets || []).map((target) => `INSERT INTO __replay_guard SELECT CASE WHEN EXISTS (
        SELECT 1 FROM records WHERE id=${target.id} AND source_id=${quoteSql(scope.source_id)}
          AND external_id=${quoteSql(target.external_id)} AND record_type='lark.im.message'
          AND container_id IS ${quoteSql(target.container_id)} AND occurred_at_ms IS ${target.occurred_at_ms}
          AND external_version IS ${quoteSql(target.external_version)}
      ) THEN 1 ELSE 0 END;`).join("\n")}
      ${history ? `INSERT INTO __replay_guard SELECT CASE WHEN
        COALESCE((SELECT generation FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)}),0)=${history.generation}
        AND COALESCE((SELECT after_id FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)}),0)=${history.afterId}
        AND COALESCE((SELECT sweep_max_id FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)}),0)=${history.sweepMaxId}
        THEN 1 ELSE 0 END;` : ""}
      CREATE TEMP TABLE __replay_before (existed INTEGER NOT NULL, same_fact INTEGER NOT NULL);
      CREATE TEMP TABLE __replay_effects (changed INTEGER NOT NULL, existed INTEGER NOT NULL, same_fact INTEGER NOT NULL);
      ${statements}
      ${history ? `DELETE FROM bounded_replay_runs WHERE scope_id=${quoteSql(scope.id)} AND id=(
        SELECT json_extract(last_result_json,'$.effects.audit_id') FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)}
      );` : ""}
      INSERT INTO bounded_replay_runs (
        id,plan_id,attempt_id,source_id,scope_id,initial_sync_start_ms,window_start_ms,window_end_ms,self_id_hash,
        page_count,fetched_count,candidate_count,inserted_count,updated_count,duplicate_count,conflict_count,finished_at
      ) SELECT ${quoteSql(auditId)},${quoteSql(planId)},${quoteSql(attemptId)},${quoteSql(scope.source_id)},${quoteSql(scope.id)},
        ${initialSyncStartMs},${startMs},${endMs},${quoteSql(selfIdHash)},${pages},${fetchedCount},${records.length},
        COALESCE(SUM(changed=1 AND existed=0),0), COALESCE(SUM(changed=1 AND existed=1),0),
        COALESCE(SUM(changed=0 AND same_fact=1),0), COALESCE(SUM(changed=0 AND same_fact=0),0),
        strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM __replay_effects;
      ${history ? `UPDATE record_observation_state SET history_error=${quoteSql(history.error)} WHERE record_id=${history.selectedId};
        INSERT INTO lark_im_history_progress(scope_id,generation,sweep_max_id,after_id,last_attempt_at_ms,last_attempt_id,last_result_json,completed_sweeps)
        SELECT ${quoteSql(scope.id)},${history.generation + 1},${history.nextSweepMaxId},${history.selectedId},${history.startedAtMs},${quoteSql(attemptId)},
          json_object('history_key',${quoteSql(historyKey)},'error',${quoteSql(history.error)},'request_budget',json(${quoteSql(JSON.stringify(history.requestBudget))}),
            'effects',json_object('audit_id',id,'inserted',inserted_count,'updated',updated_count,'duplicate',duplicate_count,'conflicts',conflict_count)),
          ${history.completedSweeps + (history.selectedId === history.nextSweepMaxId ? 1 : 0)}
        FROM bounded_replay_runs WHERE id=${quoteSql(auditId)}
        ON CONFLICT(scope_id) DO UPDATE SET generation=excluded.generation,sweep_max_id=excluded.sweep_max_id,after_id=excluded.after_id,
          last_attempt_at_ms=excluded.last_attempt_at_ms,last_attempt_id=excluded.last_attempt_id,last_result_json=excluded.last_result_json,
          completed_sweeps=excluded.completed_sweeps;` : ""}
      SELECT id AS audit_id,inserted_count AS inserted,updated_count AS updated,
        duplicate_count AS duplicate,conflict_count AS conflicts FROM bounded_replay_runs WHERE id=${quoteSql(auditId)};
      COMMIT;
    `, "commit bounded replay");
        if (!rows[0])
            throw new Error("bounded replay commit returned no evidence");
        return { audit_id: String(rows[0].audit_id), inserted: Number(rows[0].inserted), updated: Number(rows[0].updated),
            duplicate: Number(rows[0].duplicate), conflicts: Number(rows[0].conflicts) };
    }
    finally {
        releaseMaintenanceLock(dbPath, owner);
    }
}
function requireLarkScope(scope) {
    if (scope.source_id !== "lark.im")
        throw new Error("Lark detail progress requires a Lark scope");
}
function larkScopeIdentity(scope) {
    const config = scope.config_json ? JSON.parse(scope.config_json) : scope.config || {};
    return JSON.stringify({ chat_id: config.chat_id ?? null });
}
function readLarkListProgress(dbPath, scope) {
    requireLarkScope(scope);
    const row = sqliteQuery(dbPath, `SELECT * FROM lark_im_list_progress WHERE scope_id = ${quoteSql(scope.id)};`, "read Lark list progress")[0];
    if (!row)
        return null;
    if (row.anchor_cursor_json !== scopeCursorJson(scope) || row.scope_config_json !== larkScopeIdentity(scope)) {
        throw new Error("Lark list progress anchor or scope configuration changed; reconciliation is required");
    }
    return { ...row, cursor: JSON.parse(row.cursor_json),
        anchor_cursor: row.anchor_cursor_json === null ? null : JSON.parse(row.anchor_cursor_json) };
}
/** Only due debt is returned; completed descriptors are durable replay receipts. */
function readPendingLarkDetails(dbPath, scope, { limit = 8, now = new Date() } = {}) {
    requireLarkScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("detail retry limit must be between 1 and 100");
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime()))
        throw new Error("invalid detail retry clock");
    return sqliteQuery(dbPath, `SELECT * FROM lark_im_detail_tasks WHERE scope_id = ${quoteSql(scope.id)}
       AND status = 'pending' AND retry_at <= ${quoteSql(date.toISOString())}
     ORDER BY retry_at, occurred_at_ms, message_id LIMIT ${limit};`, "read pending Lark details")
        .map((row) => ({ ...row, raw_root: JSON.parse(row.raw_root_json), raw: JSON.parse(row.raw_root_json) }));
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
function larkRootTime(value) {
    const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    const time = typeof numeric === "number" ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
        : typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(time) || time < 0)
        throw new Error("detail root has an invalid source timestamp");
    return time;
}
function larkDetailRoot(raw, requireMerge = true) {
    // Queue source descriptors, never rendered text or expansion wrappers. A
    // completed receipt may describe an authoritative root whose type changed.
    const root = JSON.parse(JSON.stringify(raw));
    if (!root || typeof root.message_id !== "string" || !root.message_id.trim() ||
        (requireMerge && (root.msg_type || root.message_type) !== "merge_forward"))
        throw new Error("invalid Lark merge-forward root");
    delete root.raw_api_expansions;
    const occurredAtMs = larkRootTime(root.create_time);
    const externalVersion = root.update_time == null || root.update_time === "" ? null : String(larkRootTime(root.update_time));
    // Native list/detail endpoints may use equivalent timestamp representations
    // and omit versus emit empty root-parent metadata. These are the same source.
    const source = { ...root, create_time: occurredAtMs, update_time: externalVersion };
    if (source.upper_message_id === undefined || source.upper_message_id === null || source.upper_message_id === "") {
        delete source.upper_message_id;
    }
    return { message_id: root.message_id, raw_json: stableJson(root),
        fingerprint: sourceProof(JSON.stringify(source)).structural || createHash("sha256").update(stableJson(source)).digest("hex"),
        occurred_at_ms: occurredAtMs, external_version: externalVersion };
}
function larkRunFenceSql(scope, runId, now) {
    return `${runFenceGuardSql(scope, runId, now, { assert: true, extraPredicate: `s.cursor_json IS ${quoteSql(scopeCursorJson(scope))}
      AND json_object('chat_id', json_extract(s.config_json, '$.chat_id')) IS json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.scope_config')
      AND json_object('chat_id', json_extract(s.config_json, '$.chat_id')) IS ${quoteSql(larkScopeIdentity(scope))}
      AND COALESCE((SELECT generation FROM lark_im_list_progress WHERE scope_id = s.id), 0)
        = json_extract(r.metadata_json, '$.${RUN_FENCE_METADATA_KEY}.list_generation')
      AND NOT EXISTS (SELECT 1 FROM lark_im_list_progress p WHERE p.scope_id = s.id
        AND (p.anchor_cursor_json IS NOT s.cursor_json OR p.scope_config_json IS NOT json_object('chat_id', json_extract(s.config_json, '$.chat_id'))))` })}
    CREATE TEMP TABLE __lark_guard (allowed INTEGER NOT NULL CHECK (allowed = 1));`;
}
/** Finish list or detail work using only durable coverage and debt as evidence. */
function commitLarkProgress(dbPath, scope, runId, records, scannedCount, metadata, mutationSql, phase) {
    requireLarkScope(scope);
    if (!Number.isSafeInteger(scannedCount) || scannedCount < 0)
        throw new Error("invalid Lark scanned count");
    const normalized = prepareObservationRecords(dbPath, normalizeStoredRecords(records, scope.source_id));
    if (normalized.some((record) => record.first_seen_scope_id !== scope.id || record.record_type !== "lark.im.message")) {
        throw new Error("detail progress record does not belong to this Lark scope");
    }
    const safeMetadata = { ...metadata };
    for (const key of Object.keys(safeMetadata)) {
        if (key === RUN_FENCE_METADATA_KEY || key.startsWith("window_") ||
            ["coverage_mode", "details_complete", "list_complete", "pending_detail_count", "lark_progress"].includes(key))
            delete safeMetadata[key];
    }
    const now = new Date().toISOString();
    const rows = sqliteQuery(dbPath, `
    BEGIN IMMEDIATE;
    ${larkRunFenceSql(scope, runId, now)}
    CREATE TEMP TABLE __lark_attempts (failed INTEGER NOT NULL CHECK (failed IN (0, 1)));
    ${phase === "list" ? mutationSql : ""}
    ${recordWritesSql(normalized, now)}
    ${phase === "details" ? mutationSql : ""}
    CREATE TEMP TABLE __lark_finish AS
      SELECT p.cursor_json, p.coverage_start_ms, p.generation,
        CAST(json_extract(p.cursor_json, '$.created_at_ms') AS INTEGER) AS end_ms,
        (SELECT COUNT(*) FROM __lark_attempts) AS attempted,
        (SELECT COALESCE(SUM(failed), 0) FROM __lark_attempts) AS failed,
        (SELECT COUNT(*) FROM lark_im_detail_tasks d WHERE d.scope_id = p.scope_id AND d.status = 'pending') AS pending
      FROM lark_im_list_progress p WHERE p.scope_id = ${quoteSql(scope.id)};
    INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM __lark_finish)
      AND ${cursorCanAdvanceSql(quoteSql(scopeCursorJson(scope)), "(SELECT cursor_json FROM __lark_finish)")}
      THEN 1 ELSE 0 END;
    UPDATE sync_runs SET
      status = CASE WHEN (SELECT failed FROM __lark_finish) = 0 THEN 'succeeded' ELSE 'failed' END,
      cursor_after_json = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN (SELECT cursor_json FROM __lark_finish) ELSE NULL END,
      error_type = CASE WHEN (SELECT failed FROM __lark_finish) > 0 THEN 'LarkDetailIncomplete' ELSE NULL END,
      error_message = CASE WHEN (SELECT failed FROM __lark_finish) > 0 THEN 'Message detail attempts failed; merge-forward details remain pending' ELSE NULL END,
      finished_at = ${quoteSql(now)}, scanned_count = ${scannedCount},
      inserted_count = (SELECT inserted FROM __write_effects), updated_count = (SELECT updated FROM __write_effects),
      duplicate_count = (SELECT duplicate FROM __write_effects),
      metadata_json = json_patch(
        json_remove(COALESCE(metadata_json, '{}'), '$.window_start', '$.window_end', '$.window_start_ms', '$.window_end_ms',
          '$.coverage_mode', '$.window_complete', '$.details_complete', '$.list_complete', '$.pending_detail_count', '$.lark_progress'),
        json_patch(${sqlJson(safeMetadata)}, json_patch(
          json_object('source_observation_conflicts',(SELECT conflicts FROM __write_effects),'list_complete', json('true'), 'details_complete', json(CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN 'true' ELSE 'false' END),
            'window_complete', json(CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN 'true' ELSE 'false' END),
            'pending_detail_count', (SELECT pending FROM __lark_finish),
            'lark_progress', json_object('version', 1, 'phase', ${quoteSql(phase)},
              'outcome', CASE WHEN (SELECT failed FROM __lark_finish) > 0 THEN 'attempt_failed'
                WHEN (SELECT pending FROM __lark_finish) > 0 THEN 'awaiting_details' ELSE 'complete' END,
              'attempted', (SELECT attempted FROM __lark_finish),
              'completed', (SELECT attempted - failed FROM __lark_finish),
              'failed', (SELECT failed FROM __lark_finish), 'generation', (SELECT generation FROM __lark_finish))),
          CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN json_object(
            'coverage_mode', 'list_checkpoint_and_details', 'window_start_ms', (SELECT coverage_start_ms FROM __lark_finish),
            'window_end_ms', (SELECT end_ms FROM __lark_finish),
            'window_start', strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT coverage_start_ms FROM __lark_finish) / 1000.0, 'unixepoch'),
            'window_end', strftime('%Y-%m-%dT%H:%M:%fZ', (SELECT end_ms FROM __lark_finish) / 1000.0, 'unixepoch')) ELSE '{}' END)))
      WHERE id = ${checkedRunId(runId)};
    UPDATE sync_scopes SET
      cursor_json = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN (SELECT cursor_json FROM __lark_finish) ELSE cursor_json END,
      cursor_updated_at = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN ${quoteSql(now)} ELSE cursor_updated_at END,
      last_success_run_id = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN ${runId} ELSE last_success_run_id END,
      last_error_run_id = CASE WHEN (SELECT failed FROM __lark_finish) > 0 THEN ${runId} ELSE last_error_run_id END,
      updated_at = ${quoteSql(now)} WHERE id = ${quoteSql(scope.id)};
    UPDATE lark_im_list_progress SET
      anchor_cursor_json = (SELECT cursor_json FROM sync_scopes WHERE id = ${quoteSql(scope.id)}),
      coverage_start_ms = CASE WHEN (SELECT pending FROM __lark_finish) = 0 THEN (SELECT end_ms FROM __lark_finish) ELSE coverage_start_ms END
      WHERE scope_id = ${quoteSql(scope.id)};
    DELETE FROM sync_locks WHERE scope_id = ${quoteSql(scope.id)}
      AND locked_by = (SELECT lock_owner FROM __run_fence_guard)
      AND locked_at = (SELECT lock_acquired_at FROM __run_fence_guard)
      AND (SELECT implicit FROM __run_fence_guard) = 1;
    SELECT e.*, f.pending AS pending_details, (f.pending = 0) AS full_cursor_promoted, f.cursor_json
      FROM __write_effects e CROSS JOIN __lark_finish f;
    COMMIT;
  `, `commit Lark progress run ${runId} (stale, unfenced, or discontinuous state is rejected)`);
    const row = rows[0];
    if (!row)
        throw new Error("Lark progress commit returned no evidence");
    return { inserted: Number(row.inserted), updated: Number(row.updated), duplicate: Number(row.duplicate),
        ...(Number(row.conflicts) > 0 ? { conflicts: Number(row.conflicts) } : {}),
        pending_details: Number(row.pending_details), full_cursor_promoted: row.full_cursor_promoted === 1,
        list_cursor: JSON.parse(row.cursor_json) };
}
/** Call only after the complete list window has passed pagination validation. */
function commitLarkListRun(dbPath, scope, runId, records, rawMergeRoots, scannedCount, listCursor, metadata) {
    validateRecordCursor(listCursor, "Lark list cursor");
    const start = metadata.list_window_start_ms;
    const end = metadata.list_window_end_ms;
    const frontier = listCursor.created_at_ms;
    if (![start, end, frontier].every(Number.isSafeInteger) || end < start || frontier < start || frontier > end) {
        throw new Error("invalid Lark list coverage bounds");
    }
    if (records.some((record) => {
        const raw = JSON.parse(record.raw_json);
        return (raw.msg_type || raw.message_type) === "merge_forward";
    }))
        throw new Error("Lark list writes must not contain merge-forward placeholders");
    const rootById = new Map();
    for (const rawRoot of rawMergeRoots) {
        const root = larkDetailRoot(rawRoot);
        const previous = rootById.get(root.message_id);
        if (previous && previous.fingerprint !== root.fingerprint)
            throw new Error("conflicting duplicate Lark detail root descriptors");
        rootById.set(root.message_id, root);
    }
    const roots = [...rootById.values()];
    if (roots.some((root) => root.occurred_at_ms < start || root.occurred_at_ms > end))
        throw new Error("Lark detail root outside list window");
    const fullCursorMs = scope.cursor?.created_at_ms ?? (scopeCursorJson(scope) ? JSON.parse(scopeCursorJson(scope))?.created_at_ms : null);
    const initialStart = fullCursorMs ?? metadata.initial_sync_start_ms;
    if (!Number.isSafeInteger(initialStart))
        throw new Error("Lark list coverage requires an initial sync start");
    const now = new Date().toISOString();
    const mutationSql = `
    ${confirmInitialLarkAccountSql(now)}
    ${fullCursorMs == null ? `INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (
      SELECT 1 FROM sources WHERE id = ${quoteSql(scope.source_id)}
        AND json_extract(config_json, '$.initial_sync_start_ms') = ${initialStart}) THEN 1 ELSE 0 END;` : ""}
    INSERT INTO __lark_guard SELECT CASE WHEN ${start} = COALESCE(
      (SELECT CAST(json_extract(cursor_json, '$.created_at_ms') AS INTEGER) FROM lark_im_list_progress WHERE scope_id = ${quoteSql(scope.id)}),
      ${initialStart}) THEN 1 ELSE 0 END;
    INSERT INTO lark_im_list_progress (scope_id, anchor_cursor_json, cursor_json, coverage_start_ms, generation, scope_config_json, updated_at)
      VALUES (${quoteSql(scope.id)}, ${quoteSql(scopeCursorJson(scope))}, ${sqlJson(listCursor)}, ${start}, 1,
        ${quoteSql(larkScopeIdentity(scope))}, ${quoteSql(now)})
      ON CONFLICT(scope_id) DO UPDATE SET cursor_json = excluded.cursor_json,
        generation = lark_im_list_progress.generation + 1, updated_at = excluded.updated_at;
    ${roots.map((root) => `
      INSERT INTO lark_im_detail_tasks (scope_id, message_id, raw_root_json, fingerprint, external_version, occurred_at_ms,
        status, attempt_count, retry_at, created_at, updated_at)
      VALUES (${quoteSql(scope.id)}, ${quoteSql(root.message_id)}, ${quoteSql(root.raw_json)}, ${quoteSql(root.fingerprint)},
        ${quoteSql(root.external_version)}, ${root.occurred_at_ms}, 'pending', 0, ${quoteSql(now)}, ${quoteSql(now)}, ${quoteSql(now)})
      ON CONFLICT(scope_id, message_id) DO UPDATE SET raw_root_json = excluded.raw_root_json,
        fingerprint = excluded.fingerprint, external_version = excluded.external_version, occurred_at_ms = excluded.occurred_at_ms,
        status = 'pending', attempt_count = 0, retry_at = excluded.retry_at, last_error_type = NULL, last_error_message = NULL,
        updated_at = excluded.updated_at, completed_at = NULL
      WHERE lark_im_detail_tasks.fingerprint <> excluded.fingerprint
        AND NOT (${numericVersionSql("lark_im_detail_tasks.external_version")}
          AND ${numericVersionSql("excluded.external_version")}
          AND NOT ${versionCanReplaceSql("lark_im_detail_tasks", "excluded")});
    `).join("\n")}
  `;
    return commitLarkProgress(dbPath, scope, runId, records, scannedCount, metadata, mutationSql, "list");
}
/** A complete detail response replaces content; failed attempts only reschedule debt. */
function finishLarkDetailRun(dbPath, scope, runId, outcomes, metadata = {}) {
    if (outcomes.length < 1 || outcomes.length > 100)
        throw new Error("detail outcome count must be between 1 and 100");
    if (new Set(outcomes.map((outcome) => outcome.message_id)).size !== outcomes.length)
        throw new Error("duplicate detail outcomes");
    const now = new Date().toISOString();
    const records = [];
    const statements = outcomes.map((outcome) => {
        if (!outcome.message_id || !/^[a-f0-9]{64}$/.test(outcome.fingerprint) || Boolean(outcome.record) === Boolean(outcome.error)) {
            throw new Error("detail outcome needs exactly one complete record or error");
        }
        if (outcome.record && outcome.record.external_id !== outcome.message_id)
            throw new Error("detail outcome record identity mismatch");
        if (outcome.retry_at && !Number.isFinite(Date.parse(outcome.retry_at)))
            throw new Error("invalid detail retry timestamp");
        let resolvedRoot = null;
        if (outcome.record) {
            const raw = JSON.parse(outcome.record.raw_json);
            if (raw.message_id !== outcome.message_id ||
                ((raw.msg_type || raw.message_type) === "merge_forward" &&
                    (!Array.isArray(raw.raw_api_expansions?.merge_forward?.items) ||
                        !raw.raw_api_expansions.merge_forward.items.some((item) => item.message_id === outcome.message_id)))) {
                throw new Error("detail outcome lacks complete source evidence");
            }
            resolvedRoot = larkDetailRoot(raw, false);
            records.push(outcome.record);
        }
        const recordVersion = normalizeExternalVersion(outcome.record?.external_version);
        const taskCondition = `scope_id = ${quoteSql(scope.id)} AND message_id = ${quoteSql(outcome.message_id)}
      AND fingerprint = ${quoteSql(outcome.fingerprint)} AND status = 'pending'`;
        // Consume the exact acceptance result used by the record write, including
        // equal-version source conflicts. No independent detail selection policy.
        const completeSql = outcome.record ? `EXISTS (
      SELECT 1 FROM __record_acceptance a WHERE a.source_id=${quoteSql(scope.source_id)}
        AND a.external_id=${quoteSql(outcome.message_id)} AND a.accepted
    )` : "0";
        return `
      INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM lark_im_detail_tasks WHERE ${taskCondition}) THEN 1 ELSE 0 END;
      ${outcome.record ? `INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (
        SELECT 1 FROM lark_im_detail_tasks t CROSS JOIN (SELECT ${quoteSql(recordVersion)} AS external_version) incoming
        WHERE ${taskCondition} AND ${versionCanReplaceSql("t", "incoming")}) THEN 1 ELSE 0 END;` : ""}
      UPDATE lark_im_detail_tasks SET status = CASE WHEN ${completeSql} THEN 'complete' ELSE 'pending' END, attempt_count = attempt_count + 1,
        raw_root_json = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.raw_json)} ELSE raw_root_json END,
        fingerprint = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.fingerprint)} ELSE fingerprint END,
        external_version = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.external_version)} ELSE external_version END,
        occurred_at_ms = CASE WHEN ${completeSql} THEN ${resolvedRoot?.occurred_at_ms ?? "NULL"} ELSE occurred_at_ms END,
        retry_at = ${outcome.retry_at ? quoteSql(new Date(outcome.retry_at).toISOString())
            : `strftime('%Y-%m-%dT%H:%M:%fZ', ${quoteSql(now)}, '+' || min(86400, 60 * (1 << min(attempt_count, 11))) || ' seconds')`},
        last_error_type = CASE WHEN ${completeSql} THEN NULL ELSE ${quoteSql(outcome.error?.name || (outcome.error ? "Error" : "LarkDetailObservationConflict"))} END,
        last_error_message = CASE WHEN ${completeSql} THEN NULL ELSE ${quoteSql(outcome.error
            ? String(outcome.error.message).slice(0, 4000) : "Detail observation was not accepted; complete-content debt remains pending")} END,
        updated_at = ${quoteSql(now)}, completed_at = CASE WHEN ${completeSql} THEN ${quoteSql(now)} ELSE NULL END WHERE ${taskCondition};
      INSERT INTO __lark_attempts SELECT status = 'pending' FROM lark_im_detail_tasks
        WHERE scope_id = ${quoteSql(scope.id)} AND message_id = ${quoteSql(outcome.message_id)};
    `;
    });
    // Generation also advances on retries, so an older list run cannot overwrite
    // new retry state even when the full-content watermark has not moved.
    const mutationSql = `${statements.join("\n")}
    UPDATE lark_im_list_progress SET generation = generation + 1, updated_at = ${quoteSql(now)}
      WHERE scope_id = ${quoteSql(scope.id)};`;
    return commitLarkProgress(dbPath, scope, runId, records, outcomes.length, { ...metadata, detail_retry: true }, mutationSql, "details");
}
function larkRunMetadataEntriesSql() {
    return `, '$.${RUN_FENCE_METADATA_KEY}.list_generation', COALESCE((SELECT generation FROM lark_im_list_progress WHERE scope_id = s.id), 0),
    '$.${RUN_FENCE_METADATA_KEY}.scope_config', json_object('chat_id', json_extract(s.config_json, '$.chat_id'))`;
}
export { larkRunMetadataEntriesSql, commitBoundedReplayRecords, commitLarkListRun, finishLarkDetailRun, readLarkListProgress, readPendingLarkDetails };
