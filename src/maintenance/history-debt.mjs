// @ts-check
import { createHash } from 'node:crypto';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { quoteSql } from '../../dist/storage/sqlite/ingestion-store.js';
import { readRemoteSampleState, remoteSamplePaths } from '../runtime/worker/remote-sample-scheduler.mjs';
import { digest, sampleScopeHash } from '../diagnostics/remote-sample-core.mjs';
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { scopeObservationContext } from './scope-config-policy.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_METADATA = 20000;

/** One bounded metadata query maps private salted hints to existing native rows.
 * No hint is a source fact, and missing local messages never become insertions.
 * Invalid/unavailable state leaves the independent fair scan usable. */
export function loadHistoryDebtHints(db, logDir, binding, now, deps = {}) {
  const fallback = reason => ({ reason, hints: null });
  if (!logDir) return fallback('not_configured');
  try {
    const loaded = (deps.readState || readRemoteSampleState)(remoteSamplePaths(logDir, binding.database_key).state, binding.database_key, now);
    if (loaded.status !== 'ready') return fallback(loaded.status === 'missing' ? 'state_missing' : 'state_invalid');
    const state = loaded.state;
    if (!state || state.account_key !== binding.account_key) return fallback('account_mismatch');
    const observations = Object.entries(state.observations);
    if (!observations.length) return { reason: 'ready', hints: [] };
    const query = deps.sqliteJson || readOnlySqliteJson;
    const source = query(db, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", 'read history debt policy', { timeoutMs: 1000 })[0];
    if (source?.enabled !== 1) return fallback('source_disabled');
    const baseline = JSON.parse(source.config_json).initial_sync_start_ms;
    if (!Number.isSafeInteger(baseline) || baseline < 100_000_000_000) return fallback('policy_unavailable');
    const targets = [...new Set(observations.map(([, value]) => value.target))];
    const rows = query(db, `SELECT r.id,r.external_id,r.external_version,r.container_id,r.occurred_at_ms,
      s.id AS scope_id,s.config_json FROM records r INDEXED BY idx_records_container_time
      JOIN sync_scopes s ON s.source_id='lark.im' AND s.enabled=1
        AND r.container_id=json_extract(s.config_json,'$.chat_id')
      WHERE s.id LIKE 'lark.im.received.chat.%' AND json_valid(s.config_json)
        AND r.source_id='lark.im' AND r.record_type='lark.im.message'
        AND r.occurred_at_ms>=${baseline} AND r.occurred_at_ms IN (${targets.join(',')})
        AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
        AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END
      LIMIT ${MAX_METADATA + 1};`, 'map history debt metadata', { timeoutMs: 1000 });
    if (rows.length > MAX_METADATA) return fallback('metadata_budget');
    const byKey = new Map();
    for (const row of rows) {
      if (typeof row.container_id !== 'string' || typeof row.external_id !== 'string' ||
          row.container_id.length > 512 || row.external_id.length > 512 || row.scope_id !== chatScopeId(row.container_id)) continue;
      const key = digest([binding.database_key, binding.account_key, row.container_id, row.external_id, row.occurred_at_ms]);
      byKey.set(key, [...(byKey.get(key) || []), row]);
    }
    const hints = [];
    for (const [key, observation] of observations) {
      const matches = byKey.get(key) || [];
      if (matches.length !== 1) continue;
      const row = matches[0];
      if (observation.scope_hash && observation.scope_hash !== sampleScopeHash(binding, row.container_id)) continue;
      const debts = observation.debts || (observation.kind === 'version' ? { version: 0 } :
        observation.kind === 'missing' ? { missing: observation.first_seen } : { legacy_content: 0 });
      const sortedDebts = Object.fromEntries(Object.entries(debts).sort(([a], [b]) => a.localeCompare(b)));
      hints.push({ record_id: row.id, scope_id: row.scope_id, finding_key: key,
        database_key: binding.database_key, account_key: binding.account_key,
        context_fingerprint: sha({ source: source.config_json, scope: row.scope_id, policy: scopeObservationContext(row.config_json) }),
        debt_fingerprint: sha(sortedDebts), debts_json: JSON.stringify(sortedDebts),
        enqueued_at_ms: observation.first_seen, sample_checked_at_ms: observation.last_checked || observation.last_seen });
    }
    return { reason: 'ready', hints };
  } catch { return fallback('mapping_unavailable'); }
}

/** Pure reconciliation; the only persisted mutation occurs with the record's
 * fenced commit. An unavailable hint file cannot retire prior work. */
export function mergeHistoryDebtHints(hints, previous) {
  if (!hints) return [];
  const byId = new Map(previous.map(row => [row.record_id, row]));
  return hints.map(hint => {
    const old = byId.get(hint.record_id);
    const same = old && ['finding_key','database_key','account_key','context_fingerprint'].every(key => old[key] === hint[key]);
    const changed = same && (old.debt_fingerprint !== hint.debt_fingerprint || hint.sample_checked_at_ms > old.sample_checked_at_ms);
    return { ...hint, generation: old?.generation || 0,
      enqueued_at_ms: same ? old.enqueued_at_ms : hint.enqueued_at_ms,
      last_attempt_at_ms: same ? old.last_attempt_at_ms : 0,
      failures: same ? old.failures : 0,
      next_due_at_ms: same ? old.next_due_at_ms : 0,
      verification_generation: same ? old.verification_generation : null,
      verification_requested_at_ms: same ? old.verification_requested_at_ms : 0,
      status: same && !changed ? old.status : 'ready',
      last_attempt_id: same ? old.last_attempt_id : null,
      last_result_json: same ? old.last_result_json : null };
  });
}

export function readHistoryDebtSchedule(db, loaded, now, deps = {}) {
  const query = deps.sqliteJson || readOnlySqliteJson;
  const scheduler = query(db, 'SELECT * FROM lark_im_history_scheduler WHERE id=1;', 'read history scheduler', { timeoutMs: 1000 })[0] ||
    { generation: 0, priority_streak: 0 };
  const previous = query(db, 'SELECT * FROM lark_im_history_debt ORDER BY record_id LIMIT 201;', 'read history debt queue', { timeoutMs: 1000 });
  if (previous.length > 200) throw new Error('history debt queue exceeds bound');
  const queue = mergeHistoryDebtHints(loaded.hints, previous);
  const due = queue.filter(row => row.status === 'ready' && row.next_due_at_ms <= now)
    .sort((a,b) => (a.last_attempt_at_ms || a.enqueued_at_ms) - (b.last_attempt_at_ms || b.enqueued_at_ms) || a.enqueued_at_ms - b.enqueued_at_ms || a.record_id - b.record_id);
  return { scheduler, queue, previous, due, selected: scheduler.priority_streak < 2 ? due[0] || null : null,
    hints: loaded.hints, reason: loaded.reason };
}

/** Read the existing fair checkpoint but select one separately routed priority
 * record. The writer fences it while deliberately leaving that checkpoint alone. */
export function selectHistoryDebtTarget(db, hint, deps = {}) {
  const query = deps.sqliteJson || readOnlySqliteJson;
  const source = query(db, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", 'read priority source')[0];
  if (source?.enabled !== 1) return null;
  const baseline = JSON.parse(source.config_json).initial_sync_start_ms;
  const scope = query(db, `SELECT * FROM sync_scopes WHERE id=${quoteSql(hint.scope_id)} AND enabled=1 AND source_id='lark.im';`, 'read priority scope')[0];
  if (!scope || !Number.isSafeInteger(baseline) || baseline < 100_000_000_000) return null;
  const config = JSON.parse(scope.config_json);
  if (scope.id !== chatScopeId(config.chat_id)) return null;
  const selected = query(db, `SELECT r.*,o.generation AS observation_generation FROM records r JOIN record_observation_state o ON o.record_id=r.id
    WHERE r.id=${hint.record_id} AND r.source_id='lark.im' AND r.record_type='lark.im.message'
    AND r.container_id=${quoteSql(config.chat_id)} AND r.occurred_at_ms>=${baseline}
    AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
    AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END;`, 'read priority record')[0];
  if (!selected || digest([hint.database_key, hint.account_key, selected.container_id, selected.external_id, selected.occurred_at_ms]) !== hint.finding_key ||
      sha({ source: source.config_json, scope: scope.id, policy: scopeObservationContext(scope.config_json) }) !== hint.context_fingerprint) return null;
  const { observation_generation, ...record } = selected;
  const progress = query(db, `SELECT * FROM lark_im_history_progress WHERE scope_id=${quoteSql(scope.id)};`, 'read priority fair fence')[0];
  const detailTask = query(db, `SELECT d.fingerprint,d.raw_root_json,d.external_version,d.occurred_at_ms,p.generation AS list_generation
    FROM lark_im_detail_tasks d JOIN lark_im_list_progress p ON p.scope_id=d.scope_id
    WHERE d.scope_id=${quoteSql(scope.id)} AND d.message_id=${quoteSql(record.external_id)} AND d.status='pending';`, 'read priority detail descriptor')[0] || null;
  return { sourceConfigJson: source.config_json, baseline, scope, record, observationGeneration: observation_generation,
    checkpoint: { detailTask, generation: progress?.generation || 0, afterId: progress?.after_id || 0,
      sweepMaxId: progress?.sweep_max_id || 0, completedSweeps: progress?.completed_sweeps || 0,
      selectedId: record.id, nextSweepMaxId: record.id } };
}

/** Each enabled scope covers its fixed horizon once per global fair round.
 * Unequal historical completed_sweeps are enrollment baselines, never rank.
 * A 10,001st eligible scope yields an explicit legacy-fair fallback. */
export function readHistoryFairRound(db, scheduler, deps = {}) {
  const query = deps.sqliteJson || readOnlySqliteJson;
  const rows = query(db, `SELECT s.id AS scope_id,COALESCE(p.completed_sweeps,0) AS completed_sweeps,
      COALESCE(p.last_attempt_at_ms,0) AS last_attempt_at_ms
    FROM sync_scopes s JOIN sources src ON src.id=s.source_id
    LEFT JOIN lark_im_history_progress p ON p.scope_id=s.id
    WHERE s.source_id='lark.im' AND s.enabled=1 AND src.enabled=1
      AND s.id LIKE 'lark.im.received.chat.%' AND json_valid(s.config_json)
      AND EXISTS(SELECT 1 FROM records r INDEXED BY records_history_container_id WHERE r.source_id='lark.im'
        AND r.record_type='lark.im.message' AND r.container_id=json_extract(s.config_json,'$.chat_id')
        AND r.occurred_at_ms>=json_extract(src.config_json,'$.initial_sync_start_ms')
        AND r.external_version<>'' AND r.external_version NOT GLOB '*[^0-9]*'
        AND CASE WHEN json_valid(r.canonical_json) THEN json_extract(r.canonical_json,'$.source_api')='im.v1.messages' ELSE 0 END)
    ORDER BY s.id LIMIT 10001;`, 'read fair round inventory', { timeoutMs: 1000 });
  if (rows.length > 10000) return { reason: 'scope_budget', state: null, eligibleScopeIds: null };
  const previous = query(db, 'SELECT * FROM lark_im_history_round ORDER BY scope_id LIMIT 10001;', 'read fair round baselines', { timeoutMs: 1000 });
  if (previous.length > 10000) return { reason: 'scope_budget', state: null, eligibleScopeIds: null };
  const before = new Map(previous.map(row => [row.scope_id, row]));
  let round = scheduler.fair_round || 0;
  const now = (deps.now || Date.now)();
  let baselines = rows.map(row => ({ scope_id: row.scope_id, round,
    enrolled_at_ms: before.get(row.scope_id)?.round === round ? before.get(row.scope_id).enrolled_at_ms : now,
    baseline_sweeps: before.get(row.scope_id)?.round === round ? before.get(row.scope_id).baseline_sweeps : row.completed_sweeps }));
  let eligible = rows.filter((row, i) => row.completed_sweeps <= baselines[i].baseline_sweeps);
  if (rows.length && !eligible.length) {
    round++;
    baselines = rows.map(row => ({ scope_id: row.scope_id, round, baseline_sweeps: row.completed_sweeps, enrolled_at_ms: now }));
    eligible = rows;
  }
  const enrollment = new Map(baselines.map(row => [row.scope_id, row.enrolled_at_ms]));
  eligible.sort((a,b) => Math.max(a.last_attempt_at_ms, enrollment.get(a.scope_id)) - Math.max(b.last_attempt_at_ms, enrollment.get(b.scope_id)) ||
    Number(a.last_attempt_at_ms >= enrollment.get(a.scope_id)) - Number(b.last_attempt_at_ms >= enrollment.get(b.scope_id)) || a.scope_id.localeCompare(b.scope_id));
  return { reason: 'ready', eligibleScopeIds: eligible.map(row => row.scope_id),
    state: { beforeRound: scheduler.fair_round || 0, nextRound: round, previous, baselines } };
}

/** A bounded prefetch hint, never a scheduler. The real selector is re-run
 * before every commit; a miss discards the remaining in-memory acquisition.
 * No predicted result advances a queue or a fair checkpoint.
 */
export function readHistoryCandidatePool(db, selection, limit, readFairTargets) {
  const {target,schedule}=selection;
  const ordinary = item => {
    if (!item || item.checkpoint.detailTask) return false;
    try { return JSON.parse(item.record.raw_json)?.msg_type !== 'merge_forward'; }
    catch { return false; } // A corrupt hint cannot pin a valid live selection.
  };
  const pool=[], seen=new Set();
  const add=item=>{if(pool.length<limit && ordinary(item) && !seen.has(item.record.id)) {seen.add(item.record.id);pool.push(item);}};
  add(target);
  const priority=schedule.due.slice(0,Math.min(4,Math.ceil(limit*2/3)));
  for(const hint of priority) add(selectHistoryDebtTarget(db,hint));
  const scopes=schedule.fairRound.eligibleScopeIds?.slice(0,limit) || [null];
  const frontiers=scopes.map(scope=>readFairTargets(scope,limit));
  // One head per eligible scope first; additional rows let a single long scope
  // benefit too. Every read remains inside its current fixed sweep horizon.
  for(let depth=0;depth<limit && pool.length<limit;depth++) for(const rows of frontiers) add(rows[depth]);
  return pool;
}
