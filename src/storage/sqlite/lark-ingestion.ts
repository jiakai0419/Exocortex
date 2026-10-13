import { confirmInitialLarkAccountSql } from "./lark-account-binding.js";
import { larkWriteAdmissionSql } from "./lark-write-admission.js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { JsonObject, SyncScope, StoredRecord, WriteEffects, BoundedReplayOptions } from "./ingestion-types.js";
import { quoteSql, sqlJson, sqliteQuery } from "./sqlite-executor.js";
import { acquireMaintenanceLock, releaseMaintenanceLock } from "./sync-locks.js";
import { RUN_FENCE_METADATA_KEY, scopeCursorJson, validateRecordCursor, cursorCanAdvanceSql, checkedRunId, runFenceGuardSql } from "./sync-run-fence.js";
import { normalizeStoredRecords, normalizeBoundedReplayRecords, normalizeExternalVersion, numericVersionSql, versionCanReplaceSql, upsertRecordsSql, recordWritesSql } from "./record-storage.js";
import { reviewFenceSql } from "./maintenance-review.js";
import { sourceProof } from "../../core/lark-observation.js";
import { prepareObservationRecords, observationEvidenceSql, observationGuardSql } from "./observation-store.js";
import { pendingDetailGuardSql, preparePendingDetailObservation, type PendingDetailAcquisition } from "./pending-detail-observation.js";

/** A historical acceptance may supersede a queued root, but never supplies
 * forward-window coverage. Rebase only the descriptor selected before fetching;
 * leave a concurrently changed task/list generation untouched. A normal detail
 * retry must still validate and complete the debt before the full cursor moves. */
function historyDetailCoordinationSql(scope: SyncScope, history: NonNullable<BoundedReplayOptions["history"]>, records: StoredRecord[]) {
  const task = history.detailTask, record = records[0];
  if (!task || !record || !["accept", "equivalent"].includes(record.observation?.action || "")) return "";
  const root = larkDetailRoot(JSON.parse(record.raw_json), false);
  if (root.fingerprint === task.fingerprint) return "";
  return `UPDATE lark_im_detail_tasks SET raw_root_json=${quoteSql(root.raw_json)},fingerprint=${quoteSql(root.fingerprint)},
      external_version=${quoteSql(root.external_version)},occurred_at_ms=${root.occurred_at_ms},
      retry_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error_type=NULL,last_error_message=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE scope_id=${quoteSql(scope.id)} AND message_id=${quoteSql(record.external_id)} AND status='pending'
      AND fingerprint=${quoteSql(task.fingerprint)} AND raw_root_json IS ${quoteSql(task.raw_root_json)}
      AND external_version IS ${quoteSql(task.external_version)} AND occurred_at_ms=${task.occurred_at_ms}
      AND (SELECT generation FROM lark_im_list_progress WHERE scope_id=${quoteSql(scope.id)})=${task.list_generation}
      AND EXISTS(SELECT 1 FROM records WHERE id=${history.selectedId} AND raw_json IS ${quoteSql(record.raw_json)}
        AND external_version IS ${quoteSql(record.external_version)})
      AND EXISTS(SELECT 1 FROM (SELECT ${quoteSql(root.external_version)} AS external_version) incoming
        WHERE ${versionCanReplaceSql("lark_im_detail_tasks", "incoming")});
    UPDATE lark_im_list_progress SET generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE scope_id=${quoteSql(scope.id)} AND changes()>0;`;
}

/** Queue hints and fairness advance with the source acquisition, never before
 * it. Only the independent sampler removes findings; awaiting is not resolved. */
function historySchedulingSql(history: NonNullable<BoundedReplayOptions["history"]>,
  records: StoredRecord[], attemptId: string, resultSql: string) {
  const scheduling = history.scheduling;
  if (!scheduling) return "";
  const selected = scheduling.queue.find(row => row.record_id === history.selectedId);
  const queue = scheduling.hints === null ? "" : `
    DELETE FROM bounded_replay_runs WHERE id IN (SELECT json_extract(last_result_json,'$.effects.audit_id') FROM lark_im_history_debt
      ${scheduling.queue.length ? `WHERE record_id NOT IN (${scheduling.queue.map(row => row.record_id).join(',')})` : ''})
      AND id NOT IN (SELECT json_extract(last_result_json,'$.effects.audit_id') FROM lark_im_history_progress WHERE last_result_json IS NOT NULL);
    DELETE FROM lark_im_history_debt ${scheduling.queue.length ? `WHERE record_id NOT IN (${scheduling.queue.map(row => row.record_id).join(',')})` : ''};
    ${scheduling.queue.map(row => `INSERT INTO lark_im_history_debt
      (record_id,scope_id,finding_key,database_key,account_key,context_fingerprint,debt_fingerprint,debts_json,
       enqueued_at_ms,sample_checked_at_ms,generation,last_attempt_at_ms,next_due_at_ms,failures,status,last_attempt_id,last_result_json,verification_generation,verification_requested_at_ms)
      VALUES(${row.record_id},${quoteSql(row.scope_id)},${quoteSql(row.finding_key)},${quoteSql(row.database_key)},${quoteSql(row.account_key)},
        ${quoteSql(row.context_fingerprint)},${quoteSql(row.debt_fingerprint)},${quoteSql(row.debts_json)},${row.enqueued_at_ms},
        ${row.sample_checked_at_ms},${row.generation},${row.last_attempt_at_ms},${row.next_due_at_ms},${row.failures},
        ${quoteSql(row.status)},${quoteSql(row.last_attempt_id)},${quoteSql(row.last_result_json)},${row.verification_generation ?? "NULL"},${row.verification_requested_at_ms})
      ON CONFLICT(record_id) DO UPDATE SET scope_id=excluded.scope_id,finding_key=excluded.finding_key,
        database_key=excluded.database_key,account_key=excluded.account_key,context_fingerprint=excluded.context_fingerprint,
        debt_fingerprint=excluded.debt_fingerprint,debts_json=excluded.debts_json,enqueued_at_ms=excluded.enqueued_at_ms,
        sample_checked_at_ms=excluded.sample_checked_at_ms,generation=excluded.generation,last_attempt_at_ms=excluded.last_attempt_at_ms,
        next_due_at_ms=excluded.next_due_at_ms,failures=excluded.failures,status=excluded.status,
        last_attempt_id=excluded.last_attempt_id,last_result_json=excluded.last_result_json,
        verification_generation=excluded.verification_generation,verification_requested_at_ms=excluded.verification_requested_at_ms;`).join('\n')}`;
  const failed = history.error !== null;
  const candidate = records.some(record => record.observation?.action === 'conflict');
  const failures = failed ? Math.min(16, (selected?.failures || 0) + 1) : 0;
  const due = history.startedAtMs + (failed ? Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(9, failures - 1)) : candidate ? 1000 : 0);
  const round = scheduling.fairRound;
  const previous = scheduling.queueBefore.find(row => row.record_id === history.selectedId);
  const newDebt = Boolean(selected && previous && ['finding_key','database_key','account_key','context_fingerprint','debt_fingerprint']
    .some(key => selected[key as keyof typeof selected] !== previous[key as keyof typeof previous]));
  // A record generation also changes for local metadata. Only a committed,
  // accepted source change renews an existing debt's fast-verification ticket.
  const sourceAccepted = records.some(record => record.observation?.action === 'accept' && record.observation.before &&
    (record.observation.before.raw_json !== record.raw_json || record.observation.before.external_version !== record.external_version));
  const renewed = newDebt ? '1' : sourceAccepted ? 'EXISTS(SELECT 1 FROM __replay_effects WHERE changed=1 AND existed=1)' : '0';
  // Source acquisition time is not commit order: a sampler may finish between
  // them. Both real SQL time and the injected commit-entry clock form a lower
  // bound; +1 orders even a same-millisecond preceding sample strictly before
  // this ticket. Readers may defer this at most one millisecond into the future.
  const ticketTime = `MAX(${history.commitReadyAtMs ?? history.startedAtMs},
    CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))+1`;
  return `${queue}
    ${round ? `DELETE FROM lark_im_history_round ${round.baselines.length ? `WHERE scope_id NOT IN (${round.baselines.map(row => quoteSql(row.scope_id)).join(',')})` : ''};
      ${round.baselines.map(row => `INSERT INTO lark_im_history_round(scope_id,round,baseline_sweeps,enrolled_at_ms)
        VALUES(${quoteSql(row.scope_id)},${row.round},${row.baseline_sweeps},${row.enrolled_at_ms}) ON CONFLICT(scope_id)
        DO UPDATE SET round=excluded.round,baseline_sweeps=excluded.baseline_sweeps,enrolled_at_ms=excluded.enrolled_at_ms;`).join('\n')}` : ''}
    ${selected ? `UPDATE lark_im_history_debt SET generation=generation+1,last_attempt_at_ms=${history.startedAtMs},
      next_due_at_ms=${due},failures=${failures},status=${quoteSql(failed || candidate ? 'ready' : 'awaiting_verification')},
      last_attempt_id=${quoteSql(attemptId)},last_result_json=${resultSql}
      ${failed || candidate ? '' : `,verification_requested_at_ms=CASE WHEN verification_generation IS NULL OR ${renewed}
        THEN ${ticketTime} ELSE verification_requested_at_ms END,
        verification_generation=(SELECT generation FROM record_observation_state WHERE record_id=${history.selectedId})`}
      WHERE record_id=${history.selectedId};` : ''}
    INSERT INTO lark_im_history_scheduler(id,generation,priority_streak,last_attempt_id,last_result_json,fair_round)
      VALUES(1,${scheduling.generation + 1},${scheduling.lane === 'priority' ? scheduling.priorityStreak + 1 : 0},${quoteSql(attemptId)},${resultSql},
        ${round ? round.nextRound : 'COALESCE((SELECT fair_round FROM lark_im_history_scheduler WHERE id=1),0)'})
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,priority_streak=excluded.priority_streak,fair_round=excluded.fair_round,
        last_attempt_id=excluded.last_attempt_id,last_result_json=excluded.last_result_json;`;
}

function validateHistoryScheduling(history: NonNullable<BoundedReplayOptions["history"]>) {
  const value = history.scheduling;
  if (!value) return;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (!integer(value.generation) || !integer(value.priorityStreak) || value.priorityStreak > 2 ||
    !['priority','fair'].includes(value.lane) || value.lane === 'priority' && value.priorityStreak === 2 ||
    !(value.hints === null || Array.isArray(value.hints) && value.hints.length <= 200) ||
    !Array.isArray(value.queueBefore) || value.queueBefore.length > 200 ||
    new Set(value.queueBefore.map(row => row.record_id)).size !== value.queueBefore.length ||
    !Array.isArray(value.queue) || value.queue.length > 200 || new Set(value.queue.map(row => row.record_id)).size !== value.queue.length ||
    new Set(value.queue.map(row => row.finding_key)).size !== value.queue.length ||
    value.hints === null && value.queue.length || value.lane === 'priority' && !value.queue.some(row => row.record_id === history.selectedId))
    throw new Error('invalid history schedule');
  const round = value.fairRound;
  if (round && (value.lane !== 'fair' || !integer(round.beforeRound) || !integer(round.nextRound) ||
    round.nextRound < round.beforeRound || round.nextRound > round.beforeRound + 1 ||
    ![round.previous,round.baselines].every(rows => Array.isArray(rows) && rows.length <= 10000 &&
      new Set(rows.map(row => row.scope_id)).size === rows.length && rows.every(row =>
        row.scope_id.startsWith('lark.im.received.chat.') && integer(row.round) && integer(row.baseline_sweeps) && integer(row.enrolled_at_ms)))))
    throw new Error('invalid history fair round');
  for (const row of [...value.queue,...value.queueBefore]) {
    if (![row.record_id,row.enqueued_at_ms,row.sample_checked_at_ms,row.generation,row.last_attempt_at_ms,row.next_due_at_ms,row.failures,row.verification_requested_at_ms].every(integer) ||
      row.record_id < 1 || row.failures > 16 || !(row.verification_generation === null || integer(row.verification_generation)) || !['ready','awaiting_verification'].includes(row.status) ||
      ![row.finding_key,row.database_key,row.account_key,row.context_fingerprint,row.debt_fingerprint].every(value => /^[a-f0-9]{64}$/.test(value)) ||
      !row.scope_id.startsWith('lark.im.received.chat.') || typeof row.debts_json !== 'string' || row.debts_json.length > 1024 ||
      !(row.last_attempt_id === null || typeof row.last_attempt_id === 'string') ||
      !(row.last_result_json === null || typeof row.last_result_json === 'string')) throw new Error('invalid history debt hint');
    if (Object.keys(row).some(key => !['record_id','scope_id','finding_key','database_key','account_key','context_fingerprint','debt_fingerprint',
      'debts_json','enqueued_at_ms','sample_checked_at_ms','generation','last_attempt_at_ms','next_due_at_ms','failures','status',
      'last_attempt_id','last_result_json','verification_generation','verification_requested_at_ms'].includes(key))) throw new Error('invalid history debt fields');
    JSON.parse(row.debts_json);
  }
}

/** Commit one completely fetched, explicitly bounded repair without touching
 * normal runs, scope cursors, or freshness markers. Remote work belongs outside
 * this method; only this short transaction holds a maintenance lease. */
function commitBoundedReplayRecords(dbPath: string, options: BoundedReplayOptions) {
  const { scope, initialSyncStartMs, startMs, endMs, planId, attemptId, selfIdHash, pages, fetchedCount } = options;
  for (const time of [initialSyncStartMs, startMs, endMs]) {
    if (!Number.isSafeInteger(time) || time < 100_000_000_000 || time > 253_402_300_799_999) {
      throw new Error("bounded replay requires modern epoch-millisecond timestamps");
    }
  }
  if (startMs < initialSyncStartMs || endMs <= startMs) throw new Error("invalid bounded replay window");
  if (scope.source_id !== "lark.im" || !scope.id.startsWith("lark.im.received.chat.") || scope.enabled !== 1) {
    throw new Error("bounded replay requires an enabled Lark received scope");
  }
  const config = JSON.parse(scope.config_json || "{}");
  if (!config || typeof config.chat_id !== "string" || !config.chat_id) throw new Error("bounded replay scope has no chat identity");
  if (!/^[a-f0-9]{64}$/.test(planId) || !/^[a-f0-9]{64}$/.test(selfIdHash) || !attemptId) {
    throw new Error("invalid bounded replay audit identity");
  }
  if (!Number.isSafeInteger(pages) || pages < 1 || !Number.isSafeInteger(fetchedCount) || fetchedCount < 0) {
    throw new Error("invalid bounded replay fetch evidence");
  }
  if (options.legacyApprovalGate && !options.reviewFence) throw new Error("legacy approval gate requires a review fence");
  const history = options.history;
  if (options.observationAcquisition && !history) throw new Error("history acquisition requires its checkpoint fence");
  const historyKey = history ? createHash("sha256").update(JSON.stringify({ scope, history, attemptId, records: options.records, initialSyncStartMs, startMs, endMs, planId, selfIdHash, pages, fetchedCount,
    reviewFence: options.reviewFence, acquisition: options.observationAcquisition ? { ...options.observationAcquisition, basis: [...options.observationAcquisition.basis] } : null })).digest("hex") : null;
  if (history) {
    validateHistoryScheduling(history);
    if (history.commitReadyAtMs !== undefined && (!Number.isSafeInteger(history.commitReadyAtMs) ||
      history.commitReadyAtMs < history.startedAtMs || history.commitReadyAtMs >= 253_402_300_799_999)) {
      throw new Error('invalid history commit clock');
    }
    const task = history.detailTask;
    if (task != null && (!/^[a-f0-9]{64}$/.test(task.fingerprint) || typeof task.raw_root_json !== "string"
      || !Number.isSafeInteger(task.occurred_at_ms) || task.occurred_at_ms < 0
      || !Number.isSafeInteger(task.list_generation) || task.list_generation < 1
      || (task.external_version !== null && !/^\d+$/.test(task.external_version)))) throw new Error("invalid historical detail descriptor");
    if (![history.generation, history.afterId, history.sweepMaxId, history.completedSweeps, history.selectedId,
      history.nextSweepMaxId, history.startedAtMs].every(n => Number.isSafeInteger(n) && n >= 0)
      || history.selectedId < 1 || history.selectedId > history.nextSweepMaxId
      || options.records.length > 1 || !options.reviewFence || options.observationAcquisition?.attempt !== attemptId
      || options.observationAcquisition.confirm !== true || options.observationAcquisition.startedAtMs !== history.startedAtMs
      || !/^[a-f0-9]{64}$/.test(options.observationAcquisition.contextKey)
      || options.reviewFence.records.length !== 1 || options.reviewFence.records[0].id !== history.selectedId
      || options.records.some(record => record.external_id !== options.reviewFence!.records[0].external_id)
      || ![null, "incomplete", "size_limit", "identity", "ambiguous", "missing", "fetch_unavailable"].includes(history.error)) {
      throw new Error("invalid historical recheck fence");
    }
    const receipt = sqliteQuery(dbPath, history.scheduling ? `SELECT last_attempt_id,last_result_json FROM lark_im_history_scheduler
      WHERE id=1 AND last_attempt_id=${quoteSql(attemptId)} UNION ALL
      SELECT last_attempt_id,last_result_json FROM lark_im_history_debt WHERE record_id=${history.selectedId} AND last_attempt_id=${quoteSql(attemptId)}
      UNION ALL SELECT last_attempt_id,last_result_json FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)} AND last_attempt_id=${quoteSql(attemptId)};`
      : `SELECT last_attempt_id,last_result_json FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)};`, "read history receipt")[0];
    if (receipt?.last_attempt_id === attemptId) {
      const saved = JSON.parse(receipt.last_result_json);
      if (saved.history_key !== historyKey) throw new Error("history acquisition identity reused");
      return saved.effects;
    }
  }
  const records = prepareObservationRecords(dbPath, normalizeBoundedReplayRecords(options.records, scope.source_id), options.observationAcquisition);
  if (options.reviewFence?.mode === "names") throw new Error("bounded replay rejects a names review fence");
  const reviewFence = options.reviewFence === undefined ? "" : reviewFenceSql(options.reviewFence);
  if (options.reviewFence && !history && (options.reviewFence.records.length !== records.length || records.some((record) =>
    !options.reviewFence!.records.some((before) => before.source_id === record.source_id && before.external_id === record.external_id)))) {
    throw new Error("bounded replay review fence must cover every candidate exactly");
  }
  if (records.length > 10_000 || records.length > fetchedCount) throw new Error("bounded replay candidate limit exceeded");
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
  if (preflight.status !== 0 || preflight.error) throw new Error("bounded replay audit schema unavailable; migrate the existing database first");
  const auditId = randomUUID();
  const owner = `pid:${process.pid}:bounded-replay:${auditId}`;
  const lock = acquireMaintenanceLock(dbPath, { owner, ttlSeconds: 60, reason: "bounded Lark replay commit" });
  if (!lock.acquired) throw new Error("bounded replay commit blocked by active locks");
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
      ${options.writeAdmission ? larkWriteAdmissionSql(options.writeAdmission) : ""}
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
        AND COALESCE((SELECT completed_sweeps FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)}),0)=${history.completedSweeps}
        THEN 1 ELSE 0 END;` : ""}
      ${history?.scheduling ? `INSERT INTO __replay_guard SELECT CASE WHEN
        COALESCE((SELECT generation FROM lark_im_history_scheduler WHERE id=1),0)=${history.scheduling.generation}
        AND COALESCE((SELECT priority_streak FROM lark_im_history_scheduler WHERE id=1),0)=${history.scheduling.priorityStreak}
        AND (SELECT COUNT(*) FROM lark_im_history_debt)=${history.scheduling.queueBefore.length}
        ${history.scheduling.queueBefore.map(row => `AND EXISTS(SELECT 1 FROM lark_im_history_debt
          WHERE ${Object.entries(row).map(([key,value]) => `${key} IS ${quoteSql(value)}`).join(' AND ')})`).join(' ')}
        THEN 1 ELSE 0 END;
        ${history.scheduling.fairRound ? `INSERT INTO __replay_guard SELECT CASE WHEN
          COALESCE((SELECT fair_round FROM lark_im_history_scheduler WHERE id=1),0)=${history.scheduling.fairRound.beforeRound}
          AND (SELECT COUNT(*) FROM lark_im_history_round)=${history.scheduling.fairRound.previous.length}
          ${history.scheduling.fairRound.previous.length ? `AND NOT EXISTS(SELECT scope_id,round,baseline_sweeps,enrolled_at_ms FROM lark_im_history_round
            EXCEPT SELECT column1,column2,column3,column4 FROM (VALUES ${history.scheduling.fairRound.previous.map(row =>
              `(${quoteSql(row.scope_id)},${row.round},${row.baseline_sweeps},${row.enrolled_at_ms})`).join(',')}))` : ''}
          THEN 1 ELSE 0 END;` : ''}` : ''}
      CREATE TEMP TABLE __replay_before (existed INTEGER NOT NULL, same_fact INTEGER NOT NULL);
      CREATE TEMP TABLE __replay_effects (changed INTEGER NOT NULL, existed INTEGER NOT NULL, same_fact INTEGER NOT NULL);
      ${statements}
      ${history ? historyDetailCoordinationSql(scope, history, records) : ""}
      ${history ? `DELETE FROM bounded_replay_runs WHERE scope_id=${quoteSql(scope.id)} AND id=(
        SELECT json_extract(last_result_json,'$.effects.audit_id') FROM ${history.scheduling?.lane === 'priority' ?
          `lark_im_history_debt WHERE record_id=${history.selectedId}` : `lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)}`}
      ) ${history.scheduling?.lane === 'priority' ? "AND id NOT IN (SELECT json_extract(last_result_json,'$.effects.audit_id') FROM lark_im_history_progress WHERE last_result_json IS NOT NULL)" : ''};` : ""}
      ${history?.scheduling ? `DELETE FROM bounded_replay_runs WHERE id=(SELECT json_extract(last_result_json,'$.effects.audit_id')
        FROM lark_im_history_debt WHERE record_id=${history.selectedId})
        AND id NOT IN (SELECT json_extract(last_result_json,'$.effects.audit_id') FROM lark_im_history_progress WHERE last_result_json IS NOT NULL);` : ''}
      INSERT INTO bounded_replay_runs (
        id,plan_id,attempt_id,source_id,scope_id,initial_sync_start_ms,window_start_ms,window_end_ms,self_id_hash,
        page_count,fetched_count,candidate_count,inserted_count,updated_count,duplicate_count,conflict_count,finished_at
      ) SELECT ${quoteSql(auditId)},${quoteSql(planId)},${quoteSql(attemptId)},${quoteSql(scope.source_id)},${quoteSql(scope.id)},
        ${initialSyncStartMs},${startMs},${endMs},${quoteSql(selfIdHash)},${pages},${fetchedCount},${records.length},
        COALESCE(SUM(changed=1 AND existed=0),0), COALESCE(SUM(changed=1 AND existed=1),0),
        COALESCE(SUM(changed=0 AND same_fact=1),0), COALESCE(SUM(changed=0 AND same_fact=0),0),
        strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM __replay_effects;
      ${history ? `UPDATE record_observation_state SET history_error=${quoteSql(history.error)} WHERE record_id=${history.selectedId};
        ${history.scheduling?.lane === 'priority' ? '' : `INSERT INTO lark_im_history_progress(scope_id,generation,sweep_max_id,after_id,last_attempt_at_ms,last_attempt_id,last_result_json,completed_sweeps)
        SELECT ${quoteSql(scope.id)},${history.generation + 1},${history.nextSweepMaxId},${history.selectedId},${history.startedAtMs},${quoteSql(attemptId)},
          json_object('history_key',${quoteSql(historyKey)},'error',${quoteSql(history.error)},'request_budget',json(${quoteSql(JSON.stringify(history.requestBudget))}),
            'effects',json_object('audit_id',id,'inserted',inserted_count,'updated',updated_count,'duplicate',duplicate_count,'conflicts',conflict_count)),
          ${history.completedSweeps + (history.selectedId === history.nextSweepMaxId ? 1 : 0)}
        FROM bounded_replay_runs WHERE id=${quoteSql(auditId)}
        ON CONFLICT(scope_id) DO UPDATE SET generation=excluded.generation,sweep_max_id=excluded.sweep_max_id,after_id=excluded.after_id,
          last_attempt_at_ms=excluded.last_attempt_at_ms,last_attempt_id=excluded.last_attempt_id,last_result_json=excluded.last_result_json,
          completed_sweeps=excluded.completed_sweeps;`}
        ${historySchedulingSql(history, records, attemptId, `(SELECT json_object('history_key',${quoteSql(historyKey)},'error',${quoteSql(history.error)},
          'request_budget',json(${quoteSql(JSON.stringify(history.requestBudget))}),
          'effects',json_object('audit_id',id,'inserted',inserted_count,'updated',updated_count,'duplicate',duplicate_count,'conflicts',conflict_count))
          FROM bounded_replay_runs WHERE id=${quoteSql(auditId)})`)} ` : ""}
      SELECT id AS audit_id,inserted_count AS inserted,updated_count AS updated,
        duplicate_count AS duplicate,conflict_count AS conflicts FROM bounded_replay_runs WHERE id=${quoteSql(auditId)};
      COMMIT;
    `, "commit bounded replay");
    if (!rows[0]) throw new Error("bounded replay commit returned no evidence");
    return { audit_id: String(rows[0].audit_id), inserted: Number(rows[0].inserted), updated: Number(rows[0].updated),
      duplicate: Number(rows[0].duplicate), conflicts: Number(rows[0].conflicts) };
  } finally {
    releaseMaintenanceLock(dbPath, owner);
  }
}

type LarkDetailOutcome = {
  message_id: string;
  fingerprint: string;
  record?: StoredRecord;
  error?: Error;
  retry_at?: string;
  acquisition?: PendingDetailAcquisition;
};

type PendingLarkDetail = JsonObject & {
  message_id: string;
  fingerprint: string;
  raw_root: JsonObject;
  raw: JsonObject;
};

type LarkProgressEffects = WriteEffects & {
  pending_details: number;
  full_cursor_promoted: boolean;
  list_cursor: JsonObject;
};

function requireLarkScope(scope: SyncScope) {
  if (scope.source_id !== "lark.im") throw new Error("Lark detail progress requires a Lark scope");
}

function larkScopeIdentity(scope: SyncScope) {
  const config = scope.config_json ? JSON.parse(scope.config_json) : scope.config || {};
  return JSON.stringify({ chat_id: config.chat_id ?? null });
}

function readLarkListProgress(dbPath: string, scope: SyncScope) {
  requireLarkScope(scope);
  const row = sqliteQuery(dbPath,
    `SELECT * FROM lark_im_list_progress WHERE scope_id = ${quoteSql(scope.id)};`,
    "read Lark list progress")[0];
  if (!row) return null;
  if (row.anchor_cursor_json !== scopeCursorJson(scope) || row.scope_config_json !== larkScopeIdentity(scope)) {
    throw new Error("Lark list progress anchor or scope configuration changed; reconciliation is required");
  }
  return { ...row, cursor: JSON.parse(row.cursor_json),
    anchor_cursor: row.anchor_cursor_json === null ? null : JSON.parse(row.anchor_cursor_json) };
}

/** Only due debt is returned; completed descriptors are durable replay receipts. */
function readPendingLarkDetails(dbPath: string, scope: SyncScope,
  { limit = 8, now = new Date() }: { limit?: number; now?: Date | string } = {}): PendingLarkDetail[] {
  requireLarkScope(scope);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("detail retry limit must be between 1 and 100");
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid detail retry clock");
  // A legal per-task candidate can approach 4 MiB. Never export a batch of
  // those blobs through SQLite's shared stdout buffer: first select lightweight
  // identities in due order, then load one generation-qualified task at a time.
  const selected = sqliteQuery(dbPath,
    `SELECT message_id, descriptor_generation, evidence_generation FROM lark_im_detail_tasks
     WHERE scope_id = ${quoteSql(scope.id)} AND status = 'pending' AND descriptor_generation >= 0
       AND retry_at <= ${quoteSql(date.toISOString())}
     ORDER BY retry_at, occurred_at_ms, message_id LIMIT ${limit};`, "read pending Lark details");
  const tasks: PendingLarkDetail[] = [];
  for (const selectedTask of selected) {
    // Read record ownership in the SAME statement as the complete task. Rows
    // changed between selection and acquisition are deferred, never combined
    // with an old candidate/owner snapshot or replaced by an out-of-order row.
    const row = sqliteQuery(dbPath,
      `SELECT d.*, EXISTS(SELECT 1 FROM records r WHERE r.source_id='lark.im' AND r.external_id=d.message_id) AS record_exists
       FROM lark_im_detail_tasks d WHERE scope_id = ${quoteSql(scope.id)} AND message_id = ${quoteSql(selectedTask.message_id)}
         AND status = 'pending' AND retry_at <= ${quoteSql(date.toISOString())}
         AND descriptor_generation = ${Number(selectedTask.descriptor_generation)}
         AND evidence_generation = ${Number(selectedTask.evidence_generation)};`, "read pending Lark detail evidence")[0];
    if (row) tasks.push({ ...row, raw_root: JSON.parse(row.raw_root_json), raw: JSON.parse(row.raw_root_json) } as PendingLarkDetail);
  }
  return tasks;
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function larkRootTime(value: unknown) {
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const time = typeof numeric === "number" ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time < 0) throw new Error("detail root has an invalid source timestamp");
  return time;
}

function larkDetailRoot(raw: JsonObject, requireMerge = true) {
  // Queue source descriptors, never rendered text or expansion wrappers. A
  // completed receipt may describe an authoritative root whose type changed.
  const root = JSON.parse(JSON.stringify(raw));
  if (!root || typeof root.message_id !== "string" || !root.message_id.trim() ||
      (requireMerge && (root.msg_type || root.message_type) !== "merge_forward")) throw new Error("invalid Lark merge-forward root");
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

function larkRunFenceSql(scope: SyncScope, runId: number, now: string) {
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
function commitLarkProgress(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[],
  scannedCount: number, metadata: JsonObject, mutationSql: string, phase: "list" | "details", beforeWriteSql = ""): LarkProgressEffects {
  requireLarkScope(scope);
  if (!Number.isSafeInteger(scannedCount) || scannedCount < 0) throw new Error("invalid Lark scanned count");
  // Detail records were individually prepared and capacity-checked below. Their
  // original observation/CAS basis must reach this transaction unchanged.
  const normalized = phase === "details" ? normalizeStoredRecords(records, scope.source_id)
    : prepareObservationRecords(dbPath, normalizeStoredRecords(records, scope.source_id));
  if (normalized.some((record) => record.first_seen_scope_id !== scope.id || record.record_type !== "lark.im.message")) {
    throw new Error("detail progress record does not belong to this Lark scope");
  }
  const safeMetadata = { ...metadata };
  for (const key of Object.keys(safeMetadata)) {
    if (key === RUN_FENCE_METADATA_KEY || key.startsWith("window_") ||
        ["coverage_mode", "details_complete", "list_complete", "pending_detail_count", "lark_progress"].includes(key)) delete safeMetadata[key];
  }
  const now = new Date().toISOString();
  const rows = sqliteQuery(dbPath, `
    BEGIN IMMEDIATE;
    ${larkRunFenceSql(scope, runId, now)}
    ${beforeWriteSql}
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
  if (!row) throw new Error("Lark progress commit returned no evidence");
  return { inserted: Number(row.inserted), updated: Number(row.updated), duplicate: Number(row.duplicate),
    ...(Number(row.conflicts) > 0 ? { conflicts: Number(row.conflicts) } : {}),
    pending_details: Number(row.pending_details), full_cursor_promoted: row.full_cursor_promoted === 1,
    list_cursor: JSON.parse(row.cursor_json) };
}

/** Call only after the complete list window has passed pagination validation. */
function commitLarkListRun(dbPath: string, scope: SyncScope, runId: number, records: StoredRecord[],
  rawMergeRoots: JsonObject[], scannedCount: number, listCursor: JsonObject, metadata: JsonObject): LarkProgressEffects {
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
  })) throw new Error("Lark list writes must not contain merge-forward placeholders");
  const rootById = new Map<string, ReturnType<typeof larkDetailRoot>>();
  for (const rawRoot of rawMergeRoots) {
    const root = larkDetailRoot(rawRoot);
    const previous = rootById.get(root.message_id);
    if (previous && previous.fingerprint !== root.fingerprint) throw new Error("conflicting duplicate Lark detail root descriptors");
    rootById.set(root.message_id, root);
  }
  const roots = [...rootById.values()];
  if (roots.some((root) => root.occurred_at_ms < start || root.occurred_at_ms > end)) throw new Error("Lark detail root outside list window");
  const fullCursorMs = scope.cursor?.created_at_ms ?? (scopeCursorJson(scope) ? JSON.parse(scopeCursorJson(scope)!)?.created_at_ms : null);
  const initialStart = fullCursorMs ?? metadata.initial_sync_start_ms;
  if (!Number.isSafeInteger(initialStart)) throw new Error("Lark list coverage requires an initial sync start");
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
function finishLarkDetailRun(dbPath: string, scope: SyncScope, runId: number, outcomes: LarkDetailOutcome[],
  metadata: JsonObject = {}): LarkProgressEffects {
  if (outcomes.length < 1 || outcomes.length > 100) throw new Error("detail outcome count must be between 1 and 100");
  if (new Set(outcomes.map((outcome) => outcome.message_id)).size !== outcomes.length) throw new Error("duplicate detail outcomes");
  const now = new Date().toISOString();
  const records: StoredRecord[] = [];
  const guards: string[] = [];
  const statements = outcomes.map((outcome) => {
    if (!outcome.message_id || !/^[a-f0-9]{64}$/.test(outcome.fingerprint) || Boolean(outcome.record) === Boolean(outcome.error)) {
      throw new Error("detail outcome needs exactly one complete record or error");
    }
    if (outcome.record && outcome.record.external_id !== outcome.message_id) throw new Error("detail outcome record identity mismatch");
    if (outcome.retry_at && !Number.isFinite(Date.parse(outcome.retry_at))) throw new Error("invalid detail retry timestamp");
    let resolvedRoot: ReturnType<typeof larkDetailRoot> | null = null;
    let accepted = Boolean(outcome.record), evidenceSql = "", failureReason: string | undefined;
    if (outcome.acquisition) {
      if (outcome.acquisition.task.message_id !== outcome.message_id || outcome.acquisition.task.fingerprint !== outcome.fingerprint)
        throw new Error("detail acquisition descriptor mismatch");
      guards.push(pendingDetailGuardSql(scope, runId, outcome.acquisition));
    }
    if (outcome.record) {
      const raw = JSON.parse(outcome.record.raw_json);
      if (raw.message_id !== outcome.message_id ||
          ((raw.msg_type || raw.message_type) === "merge_forward" &&
            (!Array.isArray(raw.raw_api_expansions?.merge_forward?.items) ||
             !raw.raw_api_expansions.merge_forward.items.some((item: JsonObject) => item.message_id === outcome.message_id)))) {
        throw new Error("detail outcome lacks complete source evidence");
      }
      resolvedRoot = larkDetailRoot(raw, false);
      if (outcome.acquisition) ({ accepted, evidenceSql, failureReason } = preparePendingDetailObservation(scope, outcome.record, outcome.acquisition, resolvedRoot));
      if (accepted) {
        let prepared: StoredRecord | undefined;
        try {
          [prepared] = prepareObservationRecords(dbPath, normalizeStoredRecords([outcome.record], scope.source_id));
          // The actual evidence writer enforces its bound before any SQL is
          // committed. One over-budget source becomes ordinary retry debt;
          // healthy siblings keep their own fenced acceptance receipts.
          observationEvidenceSql([prepared]);
          records.push(prepared);
        } catch (error) {
          if (!(error instanceof Error) || !["json_patch_limit", "observation evidence capacity exceeded"].includes(error.message)) throw error;
          accepted = false;
          failureReason = error.message === "json_patch_limit" ? "detail_projection_capacity_exceeded" : "detail_evidence_capacity_exceeded";
          if (prepared?.observation?.before) {
            // An unrecordable observation is not a confirmation vote. Fence its
            // local basis and invalidate prior qualification, without deleting
            // the retained candidate bytes or inventing last-observed evidence.
            guards.push(observationGuardSql([prepared]));
            evidenceSql += `UPDATE record_observation_state SET evidence_generation=evidence_generation+1,
              candidate_generation=NULL,reason=${quoteSql(failureReason)},observed_at_ms=${Date.parse(now)}
              WHERE record_id=${Number(prepared.observation.before.id)};`;
          }
        }
      }
    }
    const recordVersion = normalizeExternalVersion(outcome.record?.external_version);
    const taskCondition = `scope_id = ${quoteSql(scope.id)} AND message_id = ${quoteSql(outcome.message_id)}
      AND fingerprint = ${quoteSql(outcome.fingerprint)} AND status = 'pending'`;
    // Consume the exact acceptance result used by the record write, including
    // equal-version source conflicts. No independent detail selection policy.
    const completeSql = accepted ? `EXISTS (
      SELECT 1 FROM __record_acceptance a WHERE a.source_id=${quoteSql(scope.source_id)}
        AND a.external_id=${quoteSql(outcome.message_id)} AND a.accepted
    )` : "0";
    return `
      INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (SELECT 1 FROM lark_im_detail_tasks WHERE ${taskCondition}) THEN 1 ELSE 0 END;
      ${outcome.record ? `INSERT INTO __lark_guard SELECT CASE WHEN EXISTS (
        SELECT 1 FROM lark_im_detail_tasks t CROSS JOIN (SELECT ${quoteSql(recordVersion)} AS external_version) incoming
        WHERE ${taskCondition} AND ${versionCanReplaceSql("t", "incoming")}) THEN 1 ELSE 0 END;` : ""}
      ${evidenceSql}
      UPDATE lark_im_detail_tasks SET status = CASE WHEN ${completeSql} THEN 'complete' ELSE 'pending' END, attempt_count = attempt_count + 1,
        raw_root_json = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.raw_json)} ELSE raw_root_json END,
        fingerprint = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.fingerprint)} ELSE fingerprint END,
        external_version = CASE WHEN ${completeSql} THEN ${quoteSql(resolvedRoot?.external_version)} ELSE external_version END,
        occurred_at_ms = CASE WHEN ${completeSql} THEN ${resolvedRoot?.occurred_at_ms ?? "NULL"} ELSE occurred_at_ms END,
        retry_at = ${outcome.retry_at ? quoteSql(new Date(outcome.retry_at).toISOString())
          : `strftime('%Y-%m-%dT%H:%M:%fZ', ${quoteSql(now)}, '+' || min(86400, 60 * (1 << min(attempt_count, 11))) || ' seconds')`},
        last_error_type = CASE WHEN ${completeSql} THEN NULL ELSE ${quoteSql(outcome.error?.name || (outcome.error ? "Error" : failureReason ? "LarkDetailEvidenceLimit" : "LarkDetailObservationConflict"))} END,
        last_error_message = CASE WHEN ${completeSql} THEN NULL ELSE ${quoteSql(outcome.error
          ? String(outcome.error.message).slice(0, 4000) : failureReason || "Detail observation was not accepted; complete-content debt remains pending")} END,
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
  return commitLarkProgress(dbPath, scope, runId, records, outcomes.length,
    { ...metadata, detail_retry: true }, mutationSql, "details", guards.join("\n"));
}


function larkRunMetadataEntriesSql() {
  return `, '$.${RUN_FENCE_METADATA_KEY}.list_generation', COALESCE((SELECT generation FROM lark_im_list_progress WHERE scope_id = s.id), 0),
    '$.${RUN_FENCE_METADATA_KEY}.scope_config', json_object('chat_id', json_extract(s.config_json, '$.chat_id'))`;
}

export { larkRunMetadataEntriesSql, commitBoundedReplayRecords, commitLarkListRun, finishLarkDetailRun, readLarkListProgress, readPendingLarkDetails };
