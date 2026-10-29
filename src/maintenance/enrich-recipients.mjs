// @ts-check
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLarkImAdapter } from '../adapters/lark-im/adapter.mjs';
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { makeRecipientEvidence, parseP2pTarget, readRecipientEvidence, recipientAccountKey, sentRecipientAccount } from '../adapters/lark-im/p2p-recipient.mjs';
import { captureLarkWriteAdmission } from '../diagnostics/lark-write-admission.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { validateJsonObjectText } from '../../dist/core/json-text-patch.js';
import { quoteSql, REVIEW_RECORD_COLUMNS } from '../../dist/storage/sqlite/ingestion-store.js';
import { commitEnrichmentUpdates } from './enrichment-commit.mjs';

/** @typedef {Record<string, any>} JsonObject */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An exact sent message authorizes one account-bound chat relationship. This
 * workflow never changes message columns, creates scopes or binds legacy history.
 * Network work finishes before the existing short, fenced maintenance commit.
 * @param {JsonObject} opts @param {JsonObject} [deps] */
function enrichRecipients(opts, deps = {}) {
  if (typeof deps.runLark !== 'function') throw new Error('recipient maintenance requires its bounded request session');
  if (!Array.isArray(opts.recordIds) || opts.recordIds.length < 1 || opts.recordIds.length > 20
    || opts.recordIds.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(opts.recordIds).size !== opts.recordIds.length) throw new Error('recipient selection requires 1 to 20 unique record IDs');
  const db = resolve(opts.db);
  if (!existsSync(db)) throw new Error('database not found');
  // Automatic recovery supplies its enclosing bounded reader. Explicit
  // maintenance retains the existing default when no reader is injected.
  const query = deps.readOnlyQuery || readOnlySqliteJson;
  const admission = captureLarkWriteAdmission(db, {}, { query });
  const rows = query(db, `SELECT ${REVIEW_RECORD_COLUMNS.join(',')} FROM records
    WHERE id IN (${opts.recordIds.map(quoteSql).join(',')}) ORDER BY id;`, 'read exact recipient targets');
  if (rows.length !== opts.recordIds.length) throw new Error('recipient target unavailable');
  const selected = rows.map(row => {
    const canonical = JSON.parse(row.canonical_json || '{}'), raw = JSON.parse(row.raw_json);
    const account = sentRecipientAccount(row, canonical, raw);
    const native = object(raw?.raw_api) ? raw.raw_api : raw;
    const conflictingType = [canonical, raw, raw?.chat, native, native?.chat]
      .some(value => ['group', 'topic'].includes(value?.chat_type) || ['group', 'topic'].includes(value?.chat_mode));
    if (!account || !Number.isSafeInteger(row.id)
      || conflictingType || Object.values(row).some(value => typeof value === 'string' && value.includes('\0'))
      || row.occurred_at_ms !== null && !Number.isSafeInteger(row.occurred_at_ms)) throw new Error('recipient target identity unavailable');
    return { row, account, scopeId: chatScopeId(row.container_id) };
  });
  if (new Set(selected.map(item => item.account)).size !== 1) throw new Error('recipient target accounts conflict');
  const scopeIds = [...new Set(selected.map(item => item.scopeId))];
  const scopes = query(db, `SELECT id,source_id,enabled,config_json,updated_at FROM sync_scopes
    WHERE id IN (${scopeIds.map(quoteSql).join(',')}) ORDER BY id;`, 'read exact recipient scopes');
  const accountKey = recipientAccountKey(selected[0].account);
  const states = query(db, `SELECT source_id,account_key,chat_id,evidence_json FROM lark_im_recipient_state
    WHERE source_id='lark.im' AND account_key=${quoteSql(accountKey)}
      AND chat_id IN (${[...new Set(selected.map(item => item.row.container_id))].map(quoteSql).join(',')});`, 'read exact recipient relationship state');
  const targets = scopeIds.map(scopeId => {
    const scope = scopes.find(value => value.id === scopeId);
    const matching = selected.filter(item => item.scopeId === scopeId);
    const chatId = matching[0].row.container_id;
    /** @type {JsonObject} */
    let config = { chat_id: chatId };
    if (scope) {
      validateJsonObjectText(scope.config_json);
      config = JSON.parse(scope.config_json);
      if (scope.source_id !== 'lark.im' || !object(config)
        || [config.chat_type, config.chat_mode].some(value => value != null && !['p2p', 'unknown'].includes(value))
        || matching.some(item => item.row.container_id !== config.chat_id)) {
        throw new Error('recipient target requires a compatible exact same-source chat scope when present');
      }
    }
    const state = states.find(value => value.chat_id === chatId);
    if (typeof state?.evidence_json === 'string' && state.evidence_json.includes('\0')) {
      throw new Error('recipient relationship evidence unavailable');
    }
    // Malformed/ambiguous cache data is not an identity observation. It may be
    // replaced by this request's explicit official relationship, but cannot
    // donate an old name or establish a contradictory peer.
    let previous = config.p2p_recipient;
    if (state?.evidence_json != null) {
      previous = undefined;
      try { validateJsonObjectText(state.evidence_json); previous = JSON.parse(state.evidence_json); } catch {}
    }
    return { scopeId, scope, config: { chat_id: chatId, p2p_recipient: previous }, state };
  });
  admission.bindScopes(scopes.map(scope => scope.id));
  // The local basis is captured before current-profile lookup. Refinement must
  // verify that basis, never replace it with a new source-account reservation.
  admission.fence.requireVerified = true;
  const adapter = createLarkImAdapter({ run: deps.runLark });
  const before = adapter.getSelfProfile({ retries: 0 });
  if (before.open_id !== selected[0].account) throw new Error('recipient request account conflicts with target');
  admission.setSelf(before.open_id);
  /** @type {Array<{scopeId:string, scope:JsonObject|undefined, config:JsonObject, state:JsonObject|undefined, target:{id_type:string,id:string}}>} */
  const resolved = [];
  let failed = 0;
  const outcomes = new Map(targets.map(({ config }) => [config.chat_id, 'unresolved']));
  try {
    const response = deps.runLark(['api', 'POST', '/open-apis/im/v1/chats/batch_query', '--as', 'user',
      '--params', JSON.stringify({ user_id_type: 'open_id' }), '--data', JSON.stringify({ chat_ids: targets.map(({ config }) => config.chat_id) }),
      '--format', 'json'], { redactedFlags: ['--params', '--data'], retries: 0 });
    for (const item of targets) {
      const target = parseP2pTarget(response, item.config.chat_id);
      if (target) resolved.push({ ...item, target });
    }
  } catch {
    failed = targets.length;
    for (const { config } of targets) outcomes.set(config.chat_id, 'failed');
  }
  deps.assertReady?.();
  const lookupOptions = { retries: 0, forceRefresh: true };
  const names = adapter.resolveContactNames(resolved.map(item => item.target.id), lookupOptions);
  deps.assertReady?.();
  const after = adapter.getSelfProfile({ retries: 0 });
  if (after.open_id !== before.open_id) throw new Error('recipient request account changed');
  admission.setSelf(after.open_id);
  admission.assertCurrent();
  const observedAt = new Date((deps.now || Date.now)()).toISOString();
  /** @type {string[]} */
  const updates = [];
  let named = 0;
  for (const { config, state, target } of resolved) {
    let evidence = makeRecipientEvidence(config.chat_id, before.open_id, target, names.get(target.id), observedAt);
    // A failed name refresh cannot erase a previously verified name for this
    // exact relationship. Keep the original observation time with that value.
    const previous = config.p2p_recipient;
    const saved = readRecipientEvidence(config, before.open_id, { includeConflicted: true, nowMs: Date.parse(observedAt) });
    if (object(previous) && previous.account_key && previous.account_key !== recipientAccountKey(before.open_id)) {
      outcomes.set(config.chat_id, 'conflict');
      continue;
    }
    const changedTarget = saved && (saved.id !== target.id || saved.type !== target.id_type);
    // An immutable chat returning a different valid peer is contradictory,
    // unlike an unavailable lookup. Require two successive later observations
    // of the same candidate before recovering from this conflict.
    const confirmedConflict = saved?.conflicted && saved.conflict.recipient.id === target.id
      && Date.parse(saved.conflict.observed_at) < Date.parse(observedAt);
    if ((changedTarget || saved?.conflicted) && !confirmedConflict) {
      evidence = { ...previous, conflict: { schema: 'lark_p2p_recipient_conflict/v1',
        identity_source: evidence.identity_source, recipient: target, observed_at: observedAt } };
      outcomes.set(config.chat_id, 'conflict');
    } else {
      const previousIsSame = saved && saved.id === target.id && saved.type === target.id_type;
      if (!evidence.recipient.name && previousIsSame && saved.name) {
        // Preserve the name and its original observation time on failed lookup;
        // resolving a relationship conflict only removes its tombstone.
        evidence = { ...previous };
        delete evidence.conflict;
      }
      if (evidence.recipient.name) named += 1;
      outcomes.set(config.chat_id, evidence.recipient.name ? 'resolved' : 'name_missing');
      // A repeated successful observation does not change unrelated history
      // contexts merely to refresh a timestamp.
      if (state?.evidence_json != null && !saved?.conflicted && previousIsSame && saved.name === (evidence.recipient.name || '')) continue;
    }
    const next = JSON.stringify(evidence);
    if (next === state?.evidence_json) continue;
    const key = `source_id='lark.im' AND account_key=${quoteSql(accountKey)} AND chat_id=${quoteSql(config.chat_id)}`;
    updates.push(`${state ? `UPDATE lark_im_recipient_state SET evidence_json=${quoteSql(next)}
      WHERE ${key} AND evidence_json IS ${quoteSql(state.evidence_json)}`
      : `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json)
        SELECT 'lark.im',${quoteSql(accountKey)},${quoteSql(config.chat_id)},${quoteSql(next)}
        WHERE NOT EXISTS(SELECT 1 FROM lark_im_recipient_state WHERE ${key})`};
      INSERT INTO __enrichment_effects(updated) VALUES(changes());`);
  }
  // Compare every original record column inside the write transaction, before
  // any relationship update. Row deletion/replacement or an unrelated-column edit
  // invalidates the complete exact-target proposal, including unchanged rows.
  if (updates.length) updates[0] = `CREATE TEMP TABLE __recipient_target_fence(allowed INTEGER NOT NULL CHECK(allowed=1));
    ${rows.map(row => `INSERT INTO __recipient_target_fence SELECT CASE WHEN EXISTS(SELECT 1 FROM records WHERE
      ${REVIEW_RECORD_COLUMNS.map(column => `${column} IS ${quoteSql(row[column])}`).join(' AND ')}) THEN 1 ELSE 0 END;`).join('\n')}
    ${targets.map(({ scopeId, scope, config, state }) => {
      const stateKey = `source_id='lark.im' AND account_key=${quoteSql(accountKey)} AND chat_id=${quoteSql(config.chat_id)}`;
      return `INSERT INTO __recipient_target_fence SELECT CASE WHEN ${scope
        ? `EXISTS(SELECT 1 FROM sync_scopes WHERE id IS ${quoteSql(scopeId)} AND source_id IS ${quoteSql(scope.source_id)}
          AND enabled IS ${quoteSql(scope.enabled)} AND config_json IS ${quoteSql(scope.config_json)} AND updated_at IS ${quoteSql(scope.updated_at)})`
        : `NOT EXISTS(SELECT 1 FROM sync_scopes WHERE id IS ${quoteSql(scopeId)})`}
        AND ${state ? `EXISTS(SELECT 1 FROM lark_im_recipient_state WHERE ${stateKey} AND evidence_json IS ${quoteSql(state.evidence_json)})`
          : `NOT EXISTS(SELECT 1 FROM lark_im_recipient_state WHERE ${stateKey})`} THEN 1 ELSE 0 END;`;
    }).join('\n')}
    ${updates[0]}`;
  deps.assertReady?.();
  const { updated, skippedConflicts } = commitEnrichmentUpdates(db, updates, { dryRun: opts.dryRun,
    reason: 'lark-im-enrich-recipients', label: 'update recipient relationships', writeAdmission: admission.fence,
    admissionBeforeCommit: admission.assertCurrent, withCommit: deps.withCommit });
  for (const [chat_id, outcome] of outcomes) deps.onRecipientResult?.({ chat_id, outcome });
  return { ok: true, dry_run: opts.dryRun, requested_records: opts.recordIds.length, scanned: rows.length,
    chats: targets.length, resolved: resolved.length, named, unresolved: targets.length - resolved.length,
    planned: updates.length, updated, skipped_conflicts: skippedConflicts, failed,
    partial: resolved.length !== targets.length || named !== resolved.length || failed > 0 || skippedConflicts > 0 };
}

export { enrichRecipients };
