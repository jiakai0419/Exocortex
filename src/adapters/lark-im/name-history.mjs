// @ts-check
import { createHash } from 'node:crypto';
import { quoteSql } from '../../../dist/storage/sqlite/ingestion-store.js';
import { larkSenderNameIsUnknownSql, larkSenderNamespaceSql } from '../../../dist/storage/sqlite/lark-name-projection.js';
import { readRemoteAccountBinding } from '../../diagnostics/remote-account-binding.mjs';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { personName, senderIdentity } from './sender-identity.mjs';

const GLOBAL_SOURCES = new Set(['contact', 'self', 'application_api']);
const SOURCES = [...GLOBAL_SOURCES, 'chat_member', 'chat_bot_app_id'];
/** @typedef {import('./message-record.mjs').LocalRecord} LocalRecord */
/** @typedef {Record<string, any>} JsonObject */

/** Called only on newly normalized records from the admitted sync's current
 * people context. Raw payloads never supply this field. A hash binds an official
 * observation to the verified sync account without storing another profile ID.
 * This does not claim a cache hit is a fresh API call or modify name-only repair.
 * @param {LocalRecord[]} records @param {{open_id:string}} selfProfile */
function bindCurrentSenderNames(records, selfProfile) {
  if (!/^ou_[A-Za-z0-9_-]+$/.test(selfProfile.open_id)) return records;
  const accountKey = createHash('sha256').update(`lark.im\0${selfProfile.open_id}`).digest('hex');
  return records.map((record) => {
    try {
      const canonical = JSON.parse(record.canonical_json);
      const identity = senderIdentity(JSON.parse(record.raw_json));
      const source = canonical.sender_name_source;
      if (record.source_id !== 'lark.im' || record.record_type !== 'lark.im.message'
        || !identity.verified || identity.id !== record.actor_id || canonical.sender_id !== record.actor_id
        || canonical.sender_id_type !== identity.type || canonical.sender_name_confidence !== 'high'
        || canonical.sender_name_state === 'cleared' || canonical.msg_type === 'system'
        || !personName(canonical.sender_name, identity.identifiers)
        || !(identity.type === 'open_id' && ['contact', 'self', 'chat_member'].includes(source)
          || identity.type === 'app_id' && ['application_api', 'chat_bot_app_id'].includes(source))) return record;
      return { ...record, canonical_json: JSON.stringify({ ...canonical, sender_name_account_key: accountKey }) };
    } catch { return record; }
  });
}

/** Optional local fallback, never a new remote observation. The source's existing
 * account binding fences reuse; no process-wide/profile cache crosses databases.
 * Distinct conflicting names and explicit clears fail closed. Historical copies
 * cannot seed more copies, so a read cannot renew evidence indefinitely.
 * @param {string} dbPath @param {LocalRecord[]} records
 * @param {{open_id:string}} selfProfile @param {number} [budgetMs] @returns {LocalRecord[]} */
function reuseKnownSenderNames(dbPath, records, selfProfile, budgetMs = 4500) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return records;
  const deadline = Date.now() + Math.min(4500, budgetMs);
  const pending = records.map((record) => {
    try {
      const canonical = JSON.parse(record.canonical_json);
      const identity = senderIdentity(JSON.parse(record.raw_json));
      if (record.source_id !== 'lark.im' || record.record_type !== 'lark.im.message'
        || !identity.verified || !['open_id', 'app_id'].includes(identity.type || '')
        || identity.id !== record.actor_id || canonical.sender_id !== record.actor_id
        || canonical.sender_id_type !== identity.type || !record.container_id
        || canonical.chat_id !== record.container_id || canonical.msg_type === 'system'
        || canonical.sender_name_state === 'cleared'
        || identity.type === 'open_id' && canonical.sender_type === 'app'
        || personName(canonical.sender_name, identity.identifiers)) return null;
      return { record, canonical, namespace: `typed:${identity.type}`, identifiers: identity.identifiers };
    } catch { return null; }
  }).filter((item) => item !== null);
  if (!pending.length) return records;
  const actors = [...new Set(pending.map(({ record }) => record.actor_id))];
  // Optional enrichment yields to ingestion, including pathological histories.
  if (actors.length > 100) return records;
  const query = (/** @type {string} */ db, /** @type {string} */ sql, /** @type {string} */ label) => {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) throw new Error('optional sender history budget exhausted');
    return readOnlySqliteJson(db, sql, label, { timeoutMs: Math.min(1500, remaining) });
  };
  try {
    const binding = readRemoteAccountBinding({ db: dbPath, selfOpenId: selfProfile.open_id }, { query });
    if (binding.state !== 'verified' || !('account_key' in binding)) return records;
    // A legacy single sent actor proves only that actor's sent projection,
    // not ownership of all received history in an older or combined database.
    const wholeSource = binding.evidence === 'initialized_empty_database';
    if (!wholeSource && binding.evidence !== 'single_sent_actor') return records;
    const rows = query(dbPath, `WITH candidates AS MATERIALIZED (
      SELECT actor_id, container_id,
        json_extract(canonical_json, '$.sender_name') AS name,
        json_extract(canonical_json, '$.sender_name_source') AS source,
        json_extract(canonical_json, '$.sender_name_confidence') AS confidence,
        json_extract(canonical_json, '$.sender_name_state') AS state,
        ${larkSenderNamespaceSql('canonical_json', 'raw_json', 'actor_id', false)} AS namespace,
        ${larkSenderNameIsUnknownSql('canonical_json', 'raw_json', 'actor_id')} AS unknown
      FROM records WHERE source_id='lark.im' AND record_type='lark.im.message'
        AND actor_id IN (${actors.map(quoteSql).join(',')})
        AND (json_type(canonical_json, '$.sender_name_account_key') IS NULL
          OR json_extract(canonical_json, '$.sender_name_account_key')=${quoteSql(binding.account_key)})
        ${wholeSource ? '' : `AND (json_extract(canonical_json, '$.sender_name_account_key')=${quoteSql(binding.account_key)}
          OR direction='sent' AND actor_id=${quoteSql(selfProfile.open_id)})`}
        AND json_valid(canonical_json) AND json_valid(raw_json)
        AND json_extract(canonical_json, '$.sender_id') IS actor_id
        AND json_extract(canonical_json, '$.chat_id') IS container_id
        AND COALESCE(json_extract(canonical_json, '$.msg_type'), '') <> 'system'
        AND (json_extract(canonical_json, '$.sender_name_source') IN (${SOURCES.map(quoteSql).join(',')})
          OR json_extract(canonical_json, '$.sender_name_state')='cleared')
    ) SELECT DISTINCT actor_id, namespace,
      CASE WHEN source IN (${[...GLOBAL_SOURCES].map(quoteSql).join(',')}) THEN NULL ELSE container_id END AS chat,
      name, source, state FROM candidates WHERE namespace IS NOT NULL
        AND (state='cleared' OR NOT unknown AND confidence='high' AND typeof(name)='text'
          AND (namespace='typed:open_id' AND source IN ('contact','self','chat_member')
            OR namespace='typed:app_id' AND source IN ('application_api','chat_bot_app_id')))
      LIMIT 1001;`, 'read authoritative sender history');
    if (rows.length > 1000) return records;
    const after = readRemoteAccountBinding({ db: dbPath, selfOpenId: selfProfile.open_id }, { query });
    if (after.state !== 'verified' || !('account_key' in after) || after.evidence !== binding.evidence
      || after.database_key !== binding.database_key
      || after.account_key !== binding.account_key) return records;
    const replacements = new Map();
    for (const { record, canonical, namespace, identifiers } of pending) {
      const evidence = rows.filter((row) => row.actor_id === record.actor_id && row.namespace === namespace
        && (row.chat === null || row.chat === record.container_id));
      if (!evidence.length || evidence.some((row) => row.state === 'cleared' || !personName(row.name, identifiers))) continue;
      const names = new Set(evidence.map((row) => row.name));
      if (names.size !== 1) continue;
      // Prefer a global official result when both global and scoped evidence agree.
      const authority = evidence.find((row) => GLOBAL_SOURCES.has(row.source)) || evidence[0];
      replacements.set(record, { ...record, canonical_json: JSON.stringify({ ...canonical,
        sender_name: authority.name, sender_name_source: 'local_history', sender_name_confidence: 'high',
        sender_name_authority_source: authority.source }) });
    }
    return records.map((record) => replacements.get(record) || record);
  } catch { return records; }
}

export { bindCurrentSenderNames, reuseKnownSenderNames };
