// @ts-check
import { createHash } from 'node:crypto';
import { patchJsonText, validateJsonObjectText } from '../../../dist/core/json-text-patch.js';
import { quoteSql } from '../../../dist/storage/sqlite/ingestion-store.js';
import { larkSenderNameIsUnknownSql, larkSenderNamespaceSql } from '../../../dist/storage/sqlite/lark-name-projection.js';
import { readRemoteAccountBinding } from '../../diagnostics/remote-account-binding.mjs';
import { readOnlySqliteJson } from '../../storage/sqlite/readonly-query.mjs';
import { personName, senderIdentity, senderLookupNamespace, senderNameFromSource, senderOpenId,
  senderAliasesByOpenId } from './sender-identity.mjs';
import { chatId, recordFromMessage } from './message-record.mjs';
import { recipientAccountKey } from './p2p-recipient.mjs';
import { nameRouteAdmission, nameRouteDescriptor } from './name-route-state.mjs';
import { titleMessageMatches } from './chat-title.mjs';
import { senderNameTarget } from './name-evidence.mjs';
import { senderNeedsAuthorityRepair } from './sender-authority-repair.mjs';
import { projectionAccount, senderProjection } from './message-projection-evidence.mjs';
import { evaluateMessageCompleteness } from './message-completeness.mjs';

const GLOBAL_SOURCES = new Set(['contact', 'self', 'application_api']);
const SOURCES = [...GLOBAL_SOURCES, 'chat_member', 'chat_bot_app_id'];
const LOCAL_FIELDS = ['sender_name', 'sender_name_source', 'sender_name_confidence',
  'sender_name_authority_source', 'sender_name_observed_at', 'sender_name_account_key'];
const SAME_RECORD = ['source_id', 'record_type', 'external_id', 'external_version', 'actor_id', 'container_id', 'raw_json'];
const INLINE_ROUTE_LIMIT = 400;
/** @typedef {import('./message-record.mjs').LocalRecord} LocalRecord */
/** @typedef {Record<string, any>} JsonObject */

function senderCleared(canonical, raw) {
  return [canonical.sender_name_state, raw.sender_name_state, raw.sender?.name_state,
    raw.raw_api?.sender_name_state, raw.raw_api?.sender?.name_state].includes('cleared');
}
function compatibleAccount(canonical, accountKey) {
  return [canonical.sender_name_account_key, canonical.chat_name_account_key,
    canonical.sender_name_verification?.account_key].every(value => value == null || value === accountKey);
}

/** Consume only the complete bounded donor set from the same message snapshot.
 * A donor's own adopted authority is required; inherited history cannot multiply
 * its authority. This returns ephemeral display evidence, never source bytes or
 * a new observation/account proof.
 * @param {JsonObject} row @param {JsonObject} canonical @param {JsonObject} raw
 * @param {string} accountKey @param {JsonObject[]} groups */
function readLocalSenderProjectionEvidence(row, canonical, raw, accountKey, groups) {
  const owner = projectionAccount(row, canonical, raw), target = senderNameTarget(row);
  if (!target || owner.state !== 'verified' || owner.account_key !== accountKey
    || !senderNeedsAuthorityRepair(target, accountKey)) return null;
  const matching = Array.isArray(groups) ? groups.filter(group => group.actor_id === row.actor_id) : [];
  if (matching.length !== 1 || matching[0].complete !== true || !Array.isArray(matching[0].rows)
    || matching[0].rows.length > 1000) return null;
  const accepted = [];
  for (const donor of matching[0].rows) {
    if (donor.source_id !== 'lark.im' || donor.record_type !== 'lark.im.message'
      || donor.actor_id !== row.actor_id || donor.id === row.id) continue;
    let value, source;
    try {
      validateJsonObjectText(donor.canonical_json); validateJsonObjectText(donor.raw_json);
      value = JSON.parse(donor.canonical_json); source = JSON.parse(donor.raw_json);
    } catch { return null; }
    if (!compatibleAccount(value, accountKey)) continue;
    const identity = senderIdentity(source), namespace = senderLookupNamespace(source);
    if (!identity.verified || identity.conflict || identity.type !== target.namespace || namespace !== target.namespace
      || identity.id !== row.actor_id || value.sender_id !== row.actor_id
      || value.sender_id_type != null && value.sender_id_type !== namespace
      || !titleMessageMatches(donor, value, source)) continue;
    if (donor.content_hash !== createHash('sha256').update(donor.raw_json).digest('hex')) continue;
    const authority = value.sender_name_source;
    const diagnostic = value.sender_name_verification;
    const blockedAuthority = diagnostic?.status === 'conflict' ? diagnostic.source || authority : authority;
    const sameChat = donor.container_id === row.container_id;
    const bound = value.sender_name_account_key === accountKey;
    if ((senderCleared(value, source) || diagnostic?.status === 'conflict')
      && (sameChat || bound && GLOBAL_SOURCES.has(blockedAuthority))) return null;
    if (!bound || value.sender_name_confidence !== 'high'
      || !(namespace === 'open_id' ? ['contact', 'self', 'chat_member']
        : ['application_api', 'chat_bot_app_id']).includes(authority)
      || !GLOBAL_SOURCES.has(authority) && !sameChat) continue;
    const name = personName(value.sender_name, [...identity.identifiers, ...target.identity.identifiers]);
    if (!name) continue;
    const checked = evaluateMessageCompleteness({row:donor,canonical:value,raw:source,evidence:{
      prepared:true,sender:senderProjection(donor,value,source,null),account:projectionAccount(donor,value,source),
    }}).requirements.find(item=>item.field==='sender');
    if (checked?.state !== 'satisfied') continue;
    const observedAt = value.sender_name_observed_at, observedMs = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
    accepted.push({ name, authority, observed_at: Number.isSafeInteger(observedMs) && observedMs >= 0
      && observedMs <= Date.now() && new Date(observedMs).toISOString() === observedAt ? observedAt : undefined });
  }
  if (!accepted.length || new Set(accepted.map(value => value.name)).size !== 1) return null;
  const preferred = accepted.find(value => GLOBAL_SOURCES.has(value.authority)) || accepted[0];
  return { id: target.identity.id, id_type: target.namespace, name: preferred.name,
    source: 'local_history', authority_source: preferred.authority, confidence: 'high', account_key: accountKey,
    observed_at: preferred.observed_at };
}

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
      const native = JSON.parse(record.raw_json), identity = senderIdentity(native);
      const source = canonical.sender_name_source;
      if (record.source_id !== 'lark.im' || record.record_type !== 'lark.im.message'
        || !identity.verified || senderLookupNamespace(native) !== identity.type
        || identity.id !== record.actor_id || canonical.sender_id !== record.actor_id
        || canonical.sender_id_type !== identity.type || canonical.sender_name_confidence !== 'high'
        || canonical.sender_name_state === 'cleared' || canonical.msg_type === 'system'
        || !personName(canonical.sender_name, identity.identifiers)
        || !(identity.type === 'open_id' && ['contact', 'self', 'chat_member'].includes(source)
          || identity.type === 'app_id' && ['application_api', 'chat_bot_app_id'].includes(source))) return record;
      return { ...record, canonical_json: patchJsonText(record.canonical_json,
        [{ path: ['sender_name_account_key'], value: JSON.stringify(accountKey) }], [['sender_name_account_key']]) };
    } catch { return record; }
  });
}

/** Read only the finite batch's exact negative route metadata. The caller owns
 * current account admission; these rows cannot authorize a name or recover a
 * blocked route. Unavailable metadata defers optional work without a lookup
 * observation, while the resolver still consumes positive caches first.
 * @param {string} dbPath @param {JsonObject[]} messages @param {{open_id:string}} selfProfile
 * @param {JsonObject} [scopeConfig] @param {JsonObject} [opts]
 * @param {{query?:typeof readOnlySqliteJson,now?:()=>number,monotonicNow?:()=>number}} [deps] */
function prepareInlineNameOptions(dbPath, messages, selfProfile, scopeConfig = {}, opts = {}, deps = {}) {
  const now = deps.now || Date.now, monotonic = deps.monotonicNow || (() => performance.now());
  const start = now(), started = monotonic();
  const requested = opts.nameLookupDeadlineMs === undefined ? start + 5000 : opts.nameLookupDeadlineMs;
  const budget = Number.isFinite(requested) && Number.isSafeInteger(start) && Number.isFinite(started)
    ? Math.max(0, Math.min(5000, requested - start)) : 0;
  const accountKey = recipientAccountKey(selfProfile?.open_id);
  const routeId = (operation, actor, namespace, chat) => JSON.stringify([operation, actor, namespace, chat]);
  /** @type {Map<string, JsonObject>} */ const routes = new Map();
  /** @type {Map<string, JsonObject|null>} */ const rows = new Map();
  let available = false;
  const remaining = () => {
    const elapsed = monotonic() - started;
    return Number.isFinite(elapsed) && elapsed >= 0 ? Math.max(0, budget - elapsed) : 0;
  };
  const add = (message, chat, partner = false) => {
    const identity = senderIdentity(message), namespace = senderLookupNamespace(message);
    if (!identity.verified || identity.conflict || namespace !== identity.type
      || !['open_id', 'app_id'].includes(namespace) || partner && namespace !== 'open_id') return;
    for (const operation of namespace === 'app_id' ? ['application_info', 'chat_bots']
      : partner ? ['contact_search'] : ['contact_search', 'chat_members']) {
      const route = nameRouteDescriptor({ source_id: 'lark.im', account_key: accountKey,
        kind: 'sender', actor_id: identity.id, namespace, chat_id: chat }, operation);
      if (!route) continue;
      const selector = ['contact_search', 'application_info'].includes(operation) ? '' : chat;
      const id = routeId(operation, identity.id, namespace, selector);
      if (routes.has(id) || routes.size < INLINE_ROUTE_LIMIT) routes.set(id, route);
    }
  };
  try {
    if (accountKey && Array.isArray(messages) && budget > 0) {
      for (const message of messages) {
        const chat = chatId(message) || scopeConfig.chat_id || '';
        add(message, chat);
        if (partnerNeedsLookup(message)) add({ sender: message.chat_partner }, chat, true);
      }
      if (routes.size) {
        const timeoutMs = Math.floor(Math.min(1500, remaining()));
        if (timeoutMs > 0) {
          const keys = [...new Set([...routes.values()].map(route => route.route_key))];
          const result = (deps.query || readOnlySqliteJson)(dbPath, `SELECT * FROM lark_im_name_routes
            WHERE source_id='lark.im' AND account_key=${quoteSql(accountKey)}
              AND route_key IN (${keys.map(quoteSql).join(',')})
            ORDER BY route_key LIMIT ${keys.length + 1};`, 'read inline name route admission', { timeoutMs });
          if (!Array.isArray(result) || result.length > keys.length) throw new Error('invalid_inline_name_routes');
          for (const row of result) {
            if (!row || !keys.includes(row.route_key)) throw new Error('invalid_inline_name_route');
            // A duplicate row is unavailable, never a last-writer-wins grant.
            rows.set(row.route_key, rows.has(row.route_key) ? null : row);
          }
          available = true;
        }
      }
    }
  } catch { /* Optional failure must not become a request/permission observation. */ }
  const deadline = Number.isSafeInteger(start) ? Math.min(Number.isFinite(requested) ? requested : start,
    now() + Math.floor(remaining())) : 0;
  return { ...opts, nameLookupDeadlineMs: deadline,
    nameRouteAdmission: target => {
      const route = target && routes.get(routeId(target.operation, target.actor_id, target.namespace, target.chat_id));
      if (!available || !route || remaining() <= 0
        || rows.has(route.route_key) && rows.get(route.route_key) === null) return false;
      if (!nameRouteAdmission(route, rows.get(route.route_key) || null, now()).allowed) return false;
      if (opts.nameRouteAdmission === undefined) return true;
      try { return opts.nameRouteAdmission(target) === true; } catch { return false; }
    } };
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
  const accountKey = createHash('sha256').update(`lark.im\0${selfProfile.open_id}`).digest('hex');
  const pending = records.map((record) => {
    try {
      const canonical = JSON.parse(record.canonical_json);
      const native = JSON.parse(record.raw_json), identity = senderIdentity(native);
      if (record.source_id !== 'lark.im' || record.record_type !== 'lark.im.message'
        || !identity.verified || senderLookupNamespace(native) !== identity.type
        || identity.id !== record.actor_id || canonical.sender_id !== record.actor_id
        || canonical.sender_id_type !== identity.type || !record.container_id
        || canonical.chat_id !== record.container_id || canonical.msg_type === 'system'
        || senderCleared(canonical, native) || !compatibleAccount(canonical, accountKey)
        || canonical.sender_name_verification?.status === 'conflict'
        || identity.type === 'open_id' && canonical.sender_type === 'app'
        || !senderNeedsAuthorityRepair(senderNameTarget(record), accountKey)) return null;
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
        CASE WHEN json_extract(canonical_json, '$.sender_name_state')='cleared'
          OR json_extract(raw_json, '$.sender_name_state')='cleared'
          OR json_extract(raw_json, '$.sender.name_state')='cleared'
          OR json_extract(raw_json, '$.raw_api.sender_name_state')='cleared'
          OR json_extract(raw_json, '$.raw_api.sender.name_state')='cleared'
          THEN 'cleared' END AS state,
        json_extract(canonical_json, '$.sender_name_verification.status') AS verification_status,
        json_extract(canonical_json, '$.sender_name_verification.source') AS verification_source,
        json_extract(canonical_json, '$.sender_name_account_key') AS account_key,
        json_extract(canonical_json, '$.sender_name_observed_at') AS observed_at,
        ${larkSenderNamespaceSql('canonical_json', 'raw_json', 'actor_id', false)} AS namespace,
        ${larkSenderNameIsUnknownSql('canonical_json', 'raw_json', 'actor_id')} AS unknown
      FROM records WHERE source_id='lark.im' AND record_type='lark.im.message'
        AND actor_id IN (${actors.map(quoteSql).join(',')})
        AND (json_type(canonical_json, '$.sender_name_account_key') IS NULL
          OR json_extract(canonical_json, '$.sender_name_account_key')=${quoteSql(binding.account_key)})
        AND (json_extract(canonical_json, '$.chat_name_account_key') IS NULL
          OR json_extract(canonical_json, '$.chat_name_account_key')=${quoteSql(binding.account_key)})
        AND (json_extract(canonical_json, '$.sender_name_verification.account_key') IS NULL
          OR json_extract(canonical_json, '$.sender_name_verification.account_key')=${quoteSql(binding.account_key)})
        ${wholeSource ? '' : `AND (json_extract(canonical_json, '$.sender_name_account_key')=${quoteSql(binding.account_key)}
          OR direction='sent' AND actor_id=${quoteSql(selfProfile.open_id)})`}
        AND json_valid(canonical_json) AND json_valid(raw_json)
        AND json_extract(canonical_json, '$.sender_id') IS actor_id
        AND json_extract(canonical_json, '$.chat_id') IS container_id
        AND COALESCE(json_extract(canonical_json, '$.msg_type'), '') <> 'system'
        AND (json_extract(canonical_json, '$.sender_name_source') IN (${SOURCES.map(quoteSql).join(',')})
          OR state='cleared' OR verification_status='conflict')
    ) SELECT DISTINCT actor_id, namespace,
      CASE WHEN (CASE WHEN verification_status='conflict' THEN COALESCE(verification_source, source)
        ELSE source END) IN (${[...GLOBAL_SOURCES].map(quoteSql).join(',')}) THEN NULL ELSE container_id END AS chat,
      name, source, state, verification_status, observed_at, account_key FROM candidates WHERE namespace IS NOT NULL
        AND (state='cleared' OR verification_status='conflict' OR NOT unknown AND confidence='high' AND typeof(name)='text'
          AND account_key=${quoteSql(binding.account_key)}
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
      if (!evidence.length || evidence.some((row) => row.state === 'cleared'
        || row.verification_status === 'conflict' || !personName(row.name, identifiers))) continue;
      const names = new Set(evidence.map((row) => row.name));
      if (names.size !== 1) continue;
      // Prefer a global official result when both global and scoped evidence agree.
      const authority = evidence.find((row) => GLOBAL_SOURCES.has(row.source)) || evidence[0];
      const fields = { sender_name: authority.name, sender_name_source: 'local_history', sender_name_confidence: 'high',
        sender_name_authority_source: authority.source, sender_name_observed_at: authority.observed_at || undefined,
        sender_name_account_key: authority.account_key };
      replacements.set(record, { ...record, canonical_json: patchJsonText(record.canonical_json,
        Object.entries(fields).map(([key, value]) => ({ path: [key], value: value === undefined ? undefined : JSON.stringify(value) })),
        Object.keys(fields).map(key => [key])) });
    }
    return records.map((record) => replacements.get(record) || record);
  } catch { return records; }
}

/** The existing resolver also prepares explicit personal chat partners. A
 * sender cache hit must not remove that independent work from its input. */
function partnerNeedsLookup(message) {
  const partner = message?.chat_partner;
  if (!partner || typeof partner !== 'object' || Array.isArray(partner) || partner.name_state === 'cleared') return false;
  const wrapped = { sender: partner }, id = senderOpenId(wrapped);
  return senderLookupNamespace(wrapped) === 'open_id' && /^ou_[A-Za-z0-9_-]+$/.test(id)
    && id.length <= 512 && !senderNameFromSource(wrapped);
}

/** Keep the resolver's complete alias/conflict view for every identity that
 * another message will query. This only retains
 * original inputs; it never adds a request beyond the pre-existing full batch. */
function localLookupMessages(messages, plans) {
  const selected = new Set(messages.flatMap((message, index) => !plans[index] || partnerNeedsLookup(message) ? [index] : []));
  let changed = true;
  while (changed) {
    changed = false;
    const identities = new Set();
    for (const index of selected) {
      const message = messages[index], identity = senderIdentity(message), namespace = senderLookupNamespace(message);
      if (namespace && identity.id && !senderNameFromSource(message)) {
        identities.add(JSON.stringify([namespace, identity.id]));
      }
      if (partnerNeedsLookup(message)) identities.add(JSON.stringify(['open_id', senderOpenId({ sender: message.chat_partner })]));
    }
    for (let index = 0; index < messages.length; index++) {
      const plan = plans[index];
      if (selected.has(index) || !plan) continue;
      if (identities.has(JSON.stringify([plan.namespace, plan.before.actor_id]))) {
        selected.add(index); changed = true;
      }
    }
  }
  return messages.filter((message, index) => selected.has(index));
}

function contextConflicts(context, record, namespace) {
  const observations = context?.sender_name_observations;
  if (!(observations instanceof Map)) return false;
  for (const [key, observation] of observations) {
    if (observation?.status !== 'conflict') continue;
    try {
      const [chat, actor, type] = JSON.parse(key);
      if (actor === record.actor_id && type === namespace
        && (chat === record.container_id || GLOBAL_SOURCES.has(observation.source))) return true;
    } catch { /* Resolver-owned malformed keys cannot identify this sender. */ }
  }
  return false;
}

/** Read trustworthy local sender evidence before optional remote lookups. The
 * plan never edits source messages or feeds a borrowed name into raw sender
 * fields. Its final patch uses the same exact record and original provenance.
 * Callers retain their existing transaction/account guards around adoption.
 * @param {string} dbPath @param {JsonObject[]} messages @param {string} scopeId
 * @param {'sent'|'received'} direction @param {{open_id:string}} selfProfile
 * @param {JsonObject} [scopeConfig]
 * @param {typeof reuseKnownSenderNames} [reuse]
 * @param {{remainingMs:number}} [localBudget] Shared across a batch of detail work.
 */
function prepareLocalSenderNames(dbPath, messages, scopeId, direction, selfProfile, scopeConfig = {}, reuse = reuseKnownSenderNames,
  localBudget = { remainingMs: 4500 }) {
  const boundedReuse = records => {
    const remaining = Math.max(0, Math.min(4500, Number.isFinite(localBudget.remainingMs) ? localBudget.remainingMs : 0));
    if (!remaining) return records;
    const started = performance.now();
    try { return reuse(dbPath, records, selfProfile, remaining); }
    finally { localBudget.remainingMs = Math.max(0, remaining - Math.max(0, performance.now() - started)); }
  };
  // Match the resolver's alias union: explicit, pending personal partners may
  // reveal an ID echo for a sender even when that sender lacks the alias.
  const batch = Array.isArray(messages) ? messages : [];
  const aliases = senderAliasesByOpenId([...batch,
    ...batch.filter(partnerNeedsLookup).map(message => ({ sender: message.chat_partner }))]);
  const reuseWithContext = (records, context) => {
    const allowed = records.filter(record => {
      try { return !contextConflicts(context, record, senderIdentity(JSON.parse(record.raw_json)).type); }
      catch { return false; }
    });
    const refreshed = boundedReuse(allowed);
    if (!Array.isArray(refreshed) || refreshed.length !== allowed.length) return records;
    const replacements = new Map();
    for (const [index, previous] of allowed.entries()) {
      const next = refreshed[index];
      if (next === previous || SAME_RECORD.some(key => next[key] !== previous[key])) continue;
      try {
        const identity = senderIdentity(JSON.parse(previous.raw_json)), canonical = JSON.parse(next.canonical_json);
        if (identity.verified && canonical.sender_name_source === 'local_history' && canonical.sender_name_confidence === 'high'
          && personName(canonical.sender_name, [...identity.identifiers, ...(aliases.get(identity.id) || [])])) replacements.set(previous, next);
      } catch { /* Malformed optional enrichment never replaces the admitted record. */ }
    }
    return records.map(record => replacements.get(record) || record);
  };
  const fallback = { lookupMessages: messages,
    apply: (records, context = {}) => reuseWithContext(records, context) };
  if (!Array.isArray(messages) || messages.length > 100) return fallback;
  let before, local;
  try {
    before = messages.map(message => recordFromMessage(message, scopeId, direction, { self: selfProfile }, scopeConfig));
    local = boundedReuse(before);
  } catch { return fallback; }
  if (!Array.isArray(local) || local.length !== before.length) return fallback;
  const plans = local.map((record, index) => {
    if (record === before[index] || SAME_RECORD.some(key => record[key] !== before[index][key])) return null;
    try {
      const canonical = JSON.parse(record.canonical_json), identity = senderIdentity(messages[index]);
      if (canonical.sender_name_source !== 'local_history' || canonical.sender_name_confidence !== 'high'
        || !identity.verified || !personName(canonical.sender_name,
          [...identity.identifiers, ...(aliases.get(identity.id) || [])])) return null;
      return { before: before[index], canonical, namespace: identity.type };
    } catch { return null; }
  });
  const accepted = plans.filter(plan => plan !== null);
  const lookupMessages = localLookupMessages(messages, plans);
  const accountKey = createHash('sha256').update(`lark.im\0${selfProfile.open_id}`).digest('hex');
  return { lookupMessages, apply: (records, context = {}) => {
    // Another lookup may have run between preflight and adoption. Re-read the
    // existing authoritative history so a newly committed clear/conflict or
    // account change cannot be hidden by the earlier local snapshot. Remote
    // duration does not consume this separate, bounded local-query allowance.
    if (lookupMessages.length) {
      return reuseWithContext(records, context);
    }
    return records.map(record => {
    const matching = accepted.filter(plan => SAME_RECORD.every(key => plan.before[key] === record[key]));
    if (!matching.length || new Set(matching.map(plan => plan.canonical.sender_name)).size !== 1) return record;
    try {
      const canonical = JSON.parse(record.canonical_json), raw = JSON.parse(record.raw_json), identity = senderIdentity(raw);
      if (!identity.verified || senderLookupNamespace(raw) !== identity.type
        || identity.id !== record.actor_id || canonical.sender_id !== record.actor_id
        || canonical.sender_id_type !== identity.type || canonical.chat_id !== record.container_id
        || senderCleared(canonical, raw) || !compatibleAccount(canonical, accountKey)
        || canonical.sender_name_verification?.status === 'conflict'
        || contextConflicts(context, record, identity.type)
        || !senderNeedsAuthorityRepair(senderNameTarget(record), accountKey)) return record;
      const donor = matching.find(plan => plan.namespace === identity.type)?.canonical;
      if (!donor || !personName(donor.sender_name, identity.identifiers)) return record;
      return { ...record, canonical_json: patchJsonText(record.canonical_json,
        LOCAL_FIELDS.map(key => ({ path: [key], value: donor[key] === undefined ? undefined : JSON.stringify(donor[key]) })),
        LOCAL_FIELDS.map(key => [key])) };
    } catch { return record; }
    });
  } };
}

export { bindCurrentSenderNames, reuseKnownSenderNames, prepareLocalSenderNames, prepareInlineNameOptions,
  readLocalSenderProjectionEvidence };
