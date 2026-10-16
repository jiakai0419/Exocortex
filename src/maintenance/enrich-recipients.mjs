// @ts-check
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLarkImAdapter } from '../adapters/lark-im/adapter.mjs';
import { chatScopeId } from '../adapters/lark-im/core.mjs';
import { makeRecipientEvidence, parseP2pTarget, sentRecipientAccount } from '../adapters/lark-im/p2p-recipient.mjs';
import { captureLarkWriteAdmission } from '../diagnostics/lark-write-admission.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { patchTopLevelJsonMemberText, validateJsonObjectText } from '../../dist/core/json-text-patch.js';
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
  const admission = captureLarkWriteAdmission(db);
  const rows = readOnlySqliteJson(db, `SELECT ${REVIEW_RECORD_COLUMNS.join(',')} FROM records
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
  const scopes = readOnlySqliteJson(db, `SELECT id,source_id,enabled,config_json,updated_at FROM sync_scopes
    WHERE id IN (${scopeIds.map(quoteSql).join(',')}) ORDER BY id;`, 'read exact recipient scopes');
  if (scopes.length !== scopeIds.length) throw new Error('recipient chat scope unavailable');
  const targets = scopes.map(scope => {
    validateJsonObjectText(scope.config_json);
    const config = JSON.parse(scope.config_json);
    const matching = selected.filter(item => item.scopeId === scope.id);
    if (scope.source_id !== 'lark.im' || !object(config) || config.chat_type !== 'p2p'
      || config.chat_mode != null && config.chat_mode !== 'p2p'
      || !matching.length || matching.some(item => item.row.container_id !== config.chat_id)) {
      throw new Error('recipient target requires an exact same-source private chat scope');
    }
    return { scope, config };
  });
  admission.bindScopes(scopeIds);
  // The local basis is captured before current-profile lookup. Refinement must
  // verify that basis, never replace it with a new source-account reservation.
  admission.fence.requireVerified = true;
  const adapter = createLarkImAdapter({ run: deps.runLark });
  const before = adapter.getSelfProfile({ retries: 0 });
  if (before.open_id !== selected[0].account) throw new Error('recipient request account conflicts with target');
  admission.setSelf(before.open_id);
  /** @type {Array<{scope:JsonObject, config:JsonObject, target:{id_type:string,id:string}}>} */
  const resolved = [];
  let failed = 0;
  for (const { scope, config } of targets) {
    try {
      const response = deps.runLark(['api', 'POST', '/open-apis/im/v1/chats/batch_query', '--as', 'user',
        '--params', JSON.stringify({ user_id_type: 'open_id' }), '--data', JSON.stringify({ chat_ids: [config.chat_id] }),
        '--format', 'json'], { redactedFlags: ['--params', '--data'], retries: 0 });
      const target = parseP2pTarget(response, config.chat_id);
      if (target) resolved.push({ scope, config, target });
    } catch { failed += 1; }
    deps.assertReady?.();
  }
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
  for (const { scope, config, target } of resolved) {
    const evidence = makeRecipientEvidence(config.chat_id, before.open_id, target, names.get(target.id), observedAt);
    if (evidence.recipient.name) named += 1;
    // A failed name refresh cannot erase a previously verified name for this
    // exact relationship. Keep the original observation time with that value.
    const previous = config.p2p_recipient;
    const previousIsSame = object(previous) && previous.schema === evidence.schema && previous.source_id === evidence.source_id
      && previous.chat_id === evidence.chat_id && previous.account_key === evidence.account_key
      && previous.identity_source === evidence.identity_source && previous.recipient?.id_type === target.id_type
      && previous.recipient?.id === target.id && previous.name_source === 'contact'
      && typeof previous.observed_at === 'string' && Number.isFinite(Date.parse(previous.observed_at))
      && new Date(previous.observed_at).toISOString() === previous.observed_at && Date.parse(previous.observed_at) <= Date.parse(observedAt);
    if (!evidence.recipient.name && previousIsSame
      && makeRecipientEvidence(config.chat_id, before.open_id, target, previous.recipient.name, previous.observed_at).recipient.name) continue;
    const next = patchTopLevelJsonMemberText(scope.config_json, 'p2p_recipient', JSON.stringify(evidence));
    if (next === scope.config_json) continue;
    updates.push(`UPDATE sync_scopes SET config_json=${quoteSql(next)}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IS ${quoteSql(scope.id)} AND source_id='lark.im' AND enabled IS ${quoteSql(scope.enabled)}
        AND config_json IS ${quoteSql(scope.config_json)} AND updated_at IS ${quoteSql(scope.updated_at)};
      INSERT INTO __enrichment_effects(updated) VALUES(changes());`);
  }
  // Compare every original record column inside the write transaction, before
  // any scope update. Row deletion/replacement or an unrelated-column edit
  // invalidates the complete exact-target proposal, including unchanged rows.
  if (updates.length) updates[0] = `CREATE TEMP TABLE __recipient_target_fence(allowed INTEGER NOT NULL CHECK(allowed=1));
    ${rows.map(row => `INSERT INTO __recipient_target_fence SELECT CASE WHEN EXISTS(SELECT 1 FROM records WHERE
      ${REVIEW_RECORD_COLUMNS.map(column => `${column} IS ${quoteSql(row[column])}`).join(' AND ')}) THEN 1 ELSE 0 END;`).join('\n')}
    ${updates[0]}`;
  deps.assertReady?.();
  const { updated, skippedConflicts } = commitEnrichmentUpdates(db, updates, { dryRun: opts.dryRun,
    reason: 'lark-im-enrich-recipients', label: 'update recipient scopes', writeAdmission: admission.fence,
    admissionBeforeCommit: admission.assertCurrent, withCommit: deps.withCommit });
  return { ok: true, dry_run: opts.dryRun, requested_records: opts.recordIds.length, scanned: rows.length,
    chats: targets.length, resolved: resolved.length, named, unresolved: targets.length - resolved.length,
    planned: updates.length, updated, skipped_conflicts: skippedConflicts, failed,
    partial: resolved.length !== targets.length || named !== resolved.length || failed > 0 || skippedConflicts > 0 };
}

export { enrichRecipients };
