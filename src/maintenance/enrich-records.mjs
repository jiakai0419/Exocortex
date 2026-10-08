// @ts-check
/** @typedef {Record<string, any>} JsonObject */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { quoteSql } from "../../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson as sqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { commitEnrichmentUpdates, publicEnrichmentError } from "./enrichment-commit.mjs";

import { larkSenderNameIsUnknownSql, larkSenderNamespaceSql, mergeLarkNameProjectionSql } from "../../dist/storage/sqlite/lark-name-projection.js";
import { createNameResolver, NAME_LOOKUP_RETRY_BUDGET_MS, uniqueAppIds } from "../adapters/lark-im/name-resolver.mjs";
import { displayNameFromUser, personName, senderAliasesByOpenId, senderIdentity, senderNameFromSource, senderOpenId } from "../adapters/lark-im/sender-identity.mjs";
import { classifyLarkFailure, createLarkCliRunner, createTransportState } from "../adapters/lark-im/transport.mjs";

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const executeLark = createLarkCliRunner({ timeoutMs: NAME_LOOKUP_RETRY_BUDGET_MS, state: createTransportState() });
function runLark(args, options = {}) {
  return executeLark(args, { retries: 0, retryDelayMs: 0, retryBudgetMs: NAME_LOOKUP_RETRY_BUDGET_MS, ...options });
}

function getSelfProfile(run = runLark) {
  const json = run(["contact", "+get-user", "--as", "user", "--format", "json"]);
  const openId =
    json?.open_id ||
    json?.user?.open_id ||
    json?.data?.open_id ||
    json?.data?.user?.open_id ||
    json?.data?.user_id?.open_id ||
    "";
  const name =
    displayNameFromUser(json) ||
    displayNameFromUser(json?.user) ||
    displayNameFromUser(json?.data) ||
    displayNameFromUser(json?.data?.user) ||
    "";
  return { open_id: openId, name };
}

function senderId(raw, row, canonical) {
  return canonical.sender_id || row.actor_id || senderIdentity(raw).id;
}

function senderName(raw, canonical) {
  const identity = senderIdentity(raw);
  const id = canonical.sender_id || identity.id;
  if (canonical.sender_name_state === "cleared") return "";
  const known = personName(canonical.sender_name, [id, ...identity.identifiers]);
  if (known) return known;
  if (identity.conflict || identity.id && id && identity.id !== id
    || canonical.sender_id_type && identity.type && canonical.sender_id_type !== identity.type) return "";
  return senderNameFromSource(raw);
}

function senderType(raw, canonical) {
  const sender = raw?.sender && typeof raw.sender === "object" ? raw.sender : {};
  return canonical.sender_type || sender.sender_type || sender.type || (String(sender.id || "").startsWith("cli_") ? "app" : "");
}

function chatId(raw, row, canonical, config) {
  return canonical.chat_id || row.container_id || raw?.chat_id || raw?.chat?.chat_id || config.chat_id || "";
}

function chatType(raw, canonical, config) {
  return canonical.chat_type || raw?.chat_type || raw?.chat?.chat_type || config.chat_type || "";
}

function chatName(raw, canonical, config) {
  return canonical.chat_name || raw?.chat_name || raw?.chat?.name || config.chat_name || "";
}

function chatPartner(raw, canonical) {
  return canonical.chat_partner || (raw?.chat_partner && typeof raw.chat_partner === "object" ? raw.chat_partner : null);
}

// The resolver owns request/response and matching rules. This workflow only
// adapts its private evidence to the existing safe and opt-in detailed report.
function recordLookupDiagnostic(diagnostics, event) {
  if (event.kind === "application") {
    if (event.status === "resolved") {
      diagnostics.app_lookup_successes += 1;
      diagnostics.app_lookup_results.push({ app_id: event.app_id, status: "resolved", name: event.name });
      return;
    }
    diagnostics.app_lookup_failures += 1;
    if (event.status === "missing_name") {
      diagnostics.app_lookup_other_failures += 1;
      diagnostics.app_lookup_results.push({ app_id: event.app_id, status: "missing_name" });
      return;
    }
    const info = classifyLarkFailure(event.error);
    const status = info.kind === "permission_denied" ? "permission_denied" : "failed";
    if (status === "permission_denied") diagnostics.app_lookup_permission_denied += 1;
    else diagnostics.app_lookup_other_failures += 1;
    const result = { app_id: event.app_id, status, code: info.code, message: info.message };
    diagnostics.app_lookup_results.push(result);
    diagnostics.app_lookup_errors.push(result);
  } else if (event.kind === "chat_bots") {
    diagnostics.app_fallback_chats_requested += 1;
    if (event.status === "ambiguous") {
      diagnostics.app_fallback_ambiguous += 1;
      diagnostics.app_fallback_errors.push({ chat_id: event.chat_id, pending_app_ids: event.pending_app_ids,
        bot_candidates: event.bot_candidates, status: "ambiguous" });
    } else if (event.status === "failed") {
      diagnostics.app_fallback_failures += 1;
      diagnostics.app_fallback_errors.push({ chat_id: event.chat_id, status: "failed",
        message: classifyLarkFailure(event.error).message });
    }
  }
}

function isInvalidRenderedContent(value) {
  return /^\[Invalid .+ JSON\]$/.test(String(value || "").trim());
}

function normalizedBody(row, canonical, raw) {
  if ((canonical.deleted === true || raw.deleted === true) && isInvalidRenderedContent(row.body)) {
    return "[已撤回/已删除：飞书未返回原始富文本内容]";
  }
  return row.body;
}

function loadRows(dbPath, limit, recordIds) {
  if (recordIds && (!Array.isArray(recordIds) || recordIds.length < 1 || recordIds.length > 100
    || recordIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(recordIds).size !== recordIds.length)) {
    throw new Error("record selection requires one to 100 distinct positive integer IDs");
  }
  const rows = sqliteJson(
    dbPath,
    `SELECT
       r.id,
       r.external_id,
       r.external_version,
       r.content_hash,
       r.actor_id,
       r.container_id,
       r.body,
       r.canonical_json,
       r.raw_json,
       s.config_json AS scope_config_json
     FROM records r
     LEFT JOIN sync_scopes s ON s.id = r.first_seen_scope_id
     WHERE r.source_id = 'lark.im'
       AND r.record_type = 'lark.im.message'
       ${recordIds ? `AND r.id IN (${recordIds.join(',')})` : ''}
     ORDER BY r.occurred_at_ms DESC, r.id DESC
     ${recordIds ? '' : `LIMIT ${Number(limit)}`};`,
    "load records",
  );
  if (recordIds && rows.length !== recordIds.length) throw new Error("requested records are missing or are not Lark messages");
  return rows;
}

function loadKnownChatNames(dbPath) {
  const rows = sqliteJson(
    dbPath,
    `SELECT chat_id, chat_name
     FROM (
       SELECT
         json_extract(config_json, '$.chat_id') AS chat_id,
         json_extract(config_json, '$.chat_name') AS chat_name,
         0 AS priority
       FROM sync_scopes
       WHERE source_id = 'lark.im'
       UNION ALL
       SELECT
         json_extract(canonical_json, '$.chat_id') AS chat_id,
         json_extract(canonical_json, '$.chat_name') AS chat_name,
         1 AS priority
       FROM records
       WHERE source_id = 'lark.im'
         AND record_type = 'lark.im.message'
     )
     WHERE COALESCE(chat_id, '') <> ''
       AND COALESCE(chat_name, '') <> ''
     ORDER BY priority;`,
    "load known chat names",
  );
  const names = new Map();
  for (const row of rows) {
    if (!names.has(row.chat_id)) names.set(row.chat_id, row.chat_name);
  }
  return names;
}

function scalarDiagnostics(diagnostics) {
  return {
    contact_ids_requested: diagnostics.contact_ids_requested,
    contact_lookup_failures: diagnostics.contact_lookup_failures,
    app_ids_requested: diagnostics.app_ids_requested,
    app_lookup_successes: diagnostics.app_lookup_successes,
    app_lookup_failures: diagnostics.app_lookup_failures,
    app_lookup_permission_denied: diagnostics.app_lookup_permission_denied,
    app_lookup_other_failures: diagnostics.app_lookup_other_failures,
    app_fallback_chats_requested: diagnostics.app_fallback_chats_requested,
    app_fallback_names: diagnostics.app_fallback_names,
    app_fallback_failures: diagnostics.app_fallback_failures,
    app_fallback_ambiguous: diagnostics.app_fallback_ambiguous,
  };
}

function prepareUpdates(dbPath, rows, proposals, senderOnly = false) {
  const merged = proposals.length === 0 ? [] : sqliteJson(dbPath, `
    WITH proposals AS (
      SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.old') AS old,
        json_extract(value, '$.next') AS next, json_extract(value, '$.actor') AS actor,
        json_extract(value, '$.container') AS container, json_extract(value, '$.body') AS body,
        json_extract(value, '$.raw') AS raw
      FROM json_each(${quoteSql(JSON.stringify(proposals))})
    )
    SELECT id, body, ${mergeLarkNameProjectionSql('p.old', 'p.next', 'p.actor', 'p.actor',
      'p.container', 'p.container', 'p.raw', 'p.raw')} AS canonical_json
    FROM proposals p;`, 'merge name projections');
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const projections = new Map(rows.map((row) => [row.id, row.canonical]));
  const updates = [];
  for (const result of merged) {
    const row = rowsById.get(result.id);
    projections.set(result.id, parseMaybeJson(result.canonical_json) || {});
    if (result.canonical_json === row.canonical_json && result.body === row.body) continue;
    updates.push(`UPDATE records
       SET canonical_json = ${quoteSql(result.canonical_json)},
           ${senderOnly ? '' : `body = ${quoteSql(result.body)},`}
           updated_at = ${quoteSql(new Date().toISOString())}
       WHERE id = ${Number(row.id)}
         AND source_id = 'lark.im' AND record_type = 'lark.im.message'
         AND external_id IS ${quoteSql(row.external_id)}
         AND external_version IS ${quoteSql(row.external_version)}
         AND content_hash IS ${quoteSql(row.content_hash)}
         AND actor_id IS ${quoteSql(row.actor_id)}
         AND container_id IS ${quoteSql(row.container_id)}
         AND raw_json IS ${quoteSql(row.raw_json)}
         AND canonical_json IS ${quoteSql(row.canonical_json)}
         AND body IS ${quoteSql(row.body)};
       INSERT INTO __enrichment_effects (updated) VALUES (changes());`);
  }
  return { updates, projections };
}

function commitUpdates(dbPath, updates, dryRun) {
  return commitEnrichmentUpdates(dbPath, updates, {
    dryRun, reason: "lark-im-enrich-records", label: "update records",
  });
}

function nativeRow(raw) {
  return raw?.raw_api && typeof raw.raw_api === 'object' ? raw.raw_api : raw;
}

function rowOpenId(row) {
  const id = senderOpenId(row.raw);
  return id && id === row.actor_id && (!row.canonical.sender_id || row.canonical.sender_id === id)
    && (!row.canonical.sender_id_type || row.canonical.sender_id_type === 'open_id') ? id : '';
}

function runSenderOnly(dbPath, opts, runLark, assertReady) {
  // All selection guards precede LIMIT, so recent unrelated rows cannot hide
  // an eligible historical sender. An extra row reports the bounded coverage.
  const candidates = sqliteJson(dbPath, `
    SELECT r.* FROM records r
    WHERE source_id = 'lark.im' AND record_type = 'lark.im.message'
      AND actor_id = ${quoteSql(opts.senderId)}
      AND json_valid(canonical_json) AND json_valid(raw_json)
      AND json_extract(canonical_json, '$.sender_id') = actor_id
      AND COALESCE(json_extract(canonical_json, '$.msg_type'), '') <> 'system'
      AND COALESCE(json_extract(raw_json, '$.msg_type'), '') <> 'system'
      AND COALESCE(json_extract(raw_json, '$.raw_api.msg_type'), '') <> 'system'
      AND COALESCE(json_extract(canonical_json, '$.sender_type'), '') <> 'app'
      AND COALESCE(json_extract(canonical_json, '$.sender_name_state'), '') <> 'cleared'
      AND ${larkSenderNameIsUnknownSql('r.canonical_json', 'r.raw_json', 'r.actor_id')}
      AND ${larkSenderNamespaceSql('r.canonical_json', 'r.raw_json', 'r.actor_id', false)} = 'typed:open_id'
      AND COALESCE(json_extract(raw_json, '$.sender.sender_type'), '') <> 'app'
      AND COALESCE(json_extract(raw_json, '$.raw_api.sender.sender_type'), '') <> 'app'
    ORDER BY occurred_at_ms ASC, id ASC LIMIT ${opts.limit + 1};`, 'load sender candidates');
  const hasMore = candidates.length > opts.limit;
  /** @type {JsonObject[]} */
  const rows = candidates.slice(0, opts.limit).map((row) => ({
    ...row, canonical: parseMaybeJson(row.canonical_json) || {}, raw: nativeRow(parseMaybeJson(row.raw_json) || {}),
  }));
  if (rows.some((row) => senderOpenId(row.raw) !== opts.senderId)) throw new Error('sender candidate identity validation failed');
  const remote = { calls: 0, member_pages: 0, member_chats: 0, failures: 0,
    budget_exhausted: false, page_limit_reached: false, chat_limit_reached: false };
  const deadline = Date.now() + 30_000;
  const transport = runLark;
  const memberChats = new Set();
  const run = (args, options = {}) => {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) { remote.budget_exhausted = true; throw new Error('sender lookup budget exhausted'); }
    if (args[0] === 'im' && args[1] === 'chat.members') {
      const cid = JSON.parse(args[args.indexOf('--params') + 1]).chat_id;
      if (remote.member_pages >= 5) { remote.page_limit_reached = true; throw new Error('sender member page limit'); }
      if (!memberChats.has(cid) && memberChats.size >= 3) {
        remote.chat_limit_reached = true; throw new Error('sender member chat limit');
      }
      memberChats.add(cid);
      remote.member_chats = memberChats.size;
      remote.member_pages += 1;
    }
    remote.calls += 1;
    try {
      return transport(args, { ...options, retries: 0, timeoutMs: Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, remaining),
        retryBudgetMs: Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, remaining) });
    } catch (error) {
      remote.failures += 1;
      if (Date.now() >= deadline) remote.budget_exhausted = true;
      throw error;
    }
  };
  const resolver = createNameResolver({ run });
  const aliases = senderAliasesByOpenId(rows.map((row) => row.raw));
  const lookupOpts = { retries: 0, retryDelayMs: 0 };
  const directName = (row) => senderNameFromSource(row.raw);
  const needsLookup = rows.some((row) => !directName(row));
  const contacts = needsLookup ? resolver.resolveContactNames([opts.senderId], lookupOpts, new Map(), aliases) : new Map();
  const members = new Map();
  if (needsLookup && !contacts.has(opts.senderId)) {
    const chats = [...new Set(rows.filter((row) => !directName(row)
      && row.container_id && row.canonical.chat_id === row.container_id && row.raw.chat_id === row.container_id
      && (row.canonical.chat_type || row.raw.chat_type) !== 'p2p').map((row) => row.container_id))];
    remote.chat_limit_reached = chats.length > 3;
    for (const cid of chats.slice(0, 3)) {
      if (remote.budget_exhausted || remote.page_limit_reached) break;
      const names = resolver.resolveChatMemberNames(cid, [opts.senderId], lookupOpts, aliases);
      if (names.has(opts.senderId)) members.set(cid, names.get(opts.senderId));
    }
  }
  const proposals = [];
  for (const row of rows) {
    const direct = directName(row);
    const member = members.get(row.container_id);
    const name = direct || member || contacts.get(opts.senderId);
    if (!name) continue;
    const next = { ...row.canonical, sender_id_type: 'open_id', sender_name: name,
      sender_name_source: direct ? 'message_sender' : member ? 'chat_member' : 'contact', sender_name_confidence: 'high' };
    proposals.push({ id: row.id, old: row.canonical_json, next: JSON.stringify(next),
      actor: row.actor_id, container: row.container_id, body: row.body, raw: row.raw_json });
  }
  const { updates } = prepareUpdates(dbPath, rows, proposals, true);
  assertReady?.();
  const { updated, skippedConflicts } = commitUpdates(dbPath, updates, opts.dryRun);
  const unresolved = rows.length - proposals.length;
  return {
    ok: true, mode: 'sender-only', dry_run: opts.dryRun, scanned: rows.length,
    planned: updates.length, updated, skipped_conflicts: skippedConflicts,
    unchanged: rows.length - updates.length, resolved: proposals.length, unresolved,
    has_more_candidates: hasMore, remote,
    partial: unresolved > 0 || hasMore || skippedConflicts > 0,
  };
}

/** Exact selection does not authorize repairing identities, authoritative clears,
 * system senders or known names. App sender evidence may omit id_type, as in
 * native app messages, but may never contradict an explicit person namespace. */
function namesOnlyExclusion(row) {
  const canonical = row.canonical;
  const raw = row.raw;
  const identity = senderIdentity(raw);
  if (canonical.msg_type === 'system' || raw.msg_type === 'system') return 'system_message';
  if (canonical.sender_name_state === 'cleared') return 'explicitly_cleared';
  if (personName(canonical.sender_name, [row.actor_id, ...identity.identifiers])) return 'known_name';
  if (!identity.id || identity.conflict || identity.id !== row.actor_id || canonical.sender_id !== row.actor_id
    || !row.container_id || canonical.chat_id !== row.container_id || raw.chat_id !== row.container_id
    || canonical.sender_id_type && identity.type && canonical.sender_id_type !== identity.type) return 'unverified_identity';
  const app = raw.sender?.sender_type === 'app' || raw.sender?.type === 'app' || identity.type === 'app_id';
  if (app) {
    return /^cli_[A-Za-z0-9_-]+$/.test(identity.id)
      && (!identity.type || identity.type === 'app_id')
      && (!canonical.sender_id_type || canonical.sender_id_type === 'app_id')
      && (!canonical.sender_type || canonical.sender_type === 'app') ? null : 'unverified_identity';
  }
  return rowOpenId(row) && canonical.sender_type !== 'app' ? null : 'unverified_identity';
}

/** @param {JsonObject} opts @param {JsonObject} [deps] */
function enrichRecords(opts, deps = {}) {
  const run = deps.runLark || runLark;
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  if (opts.senderOnly) return runSenderOnly(dbPath, opts, run, deps.assertReady);
  if (opts.namesOnly && !opts.recordIds?.length) throw new Error("names-only enrichment requires exact records");
  if (opts.recordIds?.length && !opts.namesOnly) throw new Error("exact records require names-only enrichment");

  /** @type {JsonObject[]} */
  const selected = loadRows(dbPath, opts.limit, opts.namesOnly ? opts.recordIds : undefined).map((row) => ({
    ...row,
    canonical: parseMaybeJson(row.canonical_json) || {},
    raw: nativeRow(parseMaybeJson(row.raw_json) || {}),
    config: parseMaybeJson(row.scope_config_json) || {},
  }));
  const exclusions = { system_message: 0, explicitly_cleared: 0, known_name: 0, unverified_identity: 0 };
  const rows = opts.namesOnly ? selected.filter((row) => {
    const reason = namesOnlyExclusion(row);
    if (reason) exclusions[reason]++;
    return !reason;
  }) : selected;
  const knownChatNames = opts.namesOnly ? new Map() : loadKnownChatNames(dbPath);

  const self = opts.namesOnly ? { open_id: '', name: '' } : getSelfProfile(run);
  const seed = new Map();
  if (self.open_id && self.name) seed.set(self.open_id, self.name);

  const contactIds = [];
  const groupUnresolved = new Map();
  const appIds = [];
  const appIdsByChat = new Map();
  const appStats = new Map();
  for (const row of rows) {
    const sid = senderId(row.raw, row, row.canonical);
    const sname = senderName(row.raw, row.canonical);
    const isAppSender = senderType(row.raw, row.canonical) === "app" || String(sid || "").startsWith("cli_");
    const cid = chatId(row.raw, row, row.canonical, row.config);
    const openId = rowOpenId(row);
    if (openId && !sname && !isAppSender) contactIds.push(openId);
    if (sid && isAppSender) {
      if (!appStats.has(sid)) appStats.set(sid, { app_id: sid, records: 0, existing_names: new Set() });
      const stat = appStats.get(sid);
      stat.records += 1;
      if (sname) stat.existing_names.add(sname);
    }
    if (sid && isAppSender && (opts.probeApps || !sname)) {
      appIds.push(sid);
      if (cid) {
        if (!appIdsByChat.has(cid)) appIdsByChat.set(cid, new Set());
        appIdsByChat.get(cid).add(sid);
      }
    }

    const partner = chatPartner(row.raw, row.canonical);
    const partnerId = partner?.open_id || partner?.id || partner?.user_id || "";
    const partnerName = partner?.name || partner?.display_name || "";
    if (!opts.namesOnly && partnerId && !partnerName) contactIds.push(partnerId);

    const ctype = chatType(row.raw, row.canonical, row.config);
    if (cid && ctype !== "p2p" && openId && !sname && !isAppSender) {
      if (!groupUnresolved.has(cid)) groupUnresolved.set(cid, new Set());
      groupUnresolved.get(cid).add(openId);
    }
  }

  /** @type {JsonObject} */
  const diagnostics = {
    contact_ids_requested: 0,
    contact_lookup_failures: 0,
    contact_lookup_errors: [],
    app_ids_requested: 0,
    app_lookup_successes: 0,
    app_lookup_failures: 0,
    app_lookup_permission_denied: 0,
    app_lookup_other_failures: 0,
    app_lookup_errors: [],
    app_lookup_results: [],
    app_fallback_chats_requested: 0,
    app_fallback_names: 0,
    app_fallback_failures: 0,
    app_fallback_ambiguous: 0,
    app_fallback_errors: [],
  };
  // Keep failures scoped to the targets actually requested. An unsuccessful
  // intermediate lookup is not partial when a known name or fallback wins.
  const failedContactIds = new Set();
  const failedMemberChats = new Set();
  const failedAppIds = new Set();
  const failedBotChats = new Set();
  // Request construction, response validation and seed priority have one
  // implementation shared with ingestion and the bounded sender-only mode.
  const resolver = createNameResolver({ onLookup(event) {
    if (opts.namesOnly && event.kind === 'application' && event.status === 'resolved'
      && !personName(event.name, [event.app_id])) event = { ...event, status: 'missing_name' };
    recordLookupDiagnostic(diagnostics, event);
    if (event.status !== "failed") return;
    if (event.kind === "application") failedAppIds.add(event.app_id);
    if (event.kind === "chat_bots") failedBotChats.add(event.chat_id);
  }, run(args, options) {
    const contact = args[0] === "contact" && args[1] === "+search-user";
    if (contact) diagnostics.contact_ids_requested += args[args.indexOf("--user-ids") + 1].split(",").length;
    try { return run(args, options); } catch (error) {
      if (contact) {
        diagnostics.contact_lookup_failures += 1;
        diagnostics.contact_lookup_errors.push(String(error instanceof Error ? error.message : error).slice(0, 500));
        for (const id of args[args.indexOf("--user-ids") + 1].split(",")) failedContactIds.add(id);
      } else if (args[0] === "im" && args[1] === "chat.members" && args[2] === "get") {
        failedMemberChats.add(JSON.parse(args[args.indexOf("--params") + 1]).chat_id);
      }
      throw error;
    }
  } });
  const lookupOpts = { retries: 0, retryDelayMs: 0 };
  const aliases = senderAliasesByOpenId(rows.map((row) => row.raw));
  const contactNames = resolver.resolveContactNames(contactIds, lookupOpts, seed, aliases);
  const memberNames = new Map();
  for (const [cid, ids] of groupUnresolved.entries()) {
    const names = resolver.resolveChatMemberNames(cid, [...ids].filter((id) => !contactNames.has(id)), lookupOpts, aliases);
    for (const [id, name] of names.entries()) memberNames.set(`${cid}:${id}`, name);
  }
  diagnostics.app_ids_requested = uniqueAppIds(appIds).length;
  const appNames = resolver.resolveApplicationNames(appIds, { ...lookupOpts, forceRefresh: opts.probeApps });
  if (opts.namesOnly) {
    for (const [id, name] of appNames) {
      const display = personName(name, [id]);
      if (display) appNames.set(id, display); else appNames.delete(id);
    }
  }
  const appFallbackNames = resolver.resolveChatBotAppFallbackNames(appIdsByChat, appNames, lookupOpts);
  if (opts.namesOnly) {
    // Exact records are only a subset of a chat. Apparent uniqueness among
    // selected app IDs cannot prove that an unbound bot belongs to that app.
    for (const [key, value] of appFallbackNames) {
      if (value.source !== 'chat_bot_app_id') appFallbackNames.delete(key);
    }
  }
  diagnostics.app_fallback_names = appFallbackNames.size;
  const appProbeResultsById = new Map(diagnostics.app_lookup_results.map((result) => [result.app_id, result]));

  const proposals = [];
  const failedTargets = [];
  for (const row of rows) {
    const next = { ...row.canonical };
    const cid = chatId(row.raw, row, row.canonical, row.config);
    const ctype = chatType(row.raw, row.canonical, row.config);
    const cname = chatName(row.raw, row.canonical, row.config) || knownChatNames.get(cid) || "";
    const sid = senderId(row.raw, row, row.canonical);
    const isAppSender = senderType(row.raw, row.canonical) === "app" || String(sid || "").startsWith("cli_");
    const existingSenderName = senderName(row.raw, row.canonical);
    const openId = rowOpenId(row);
    const memberName = openId ? memberNames.get(`${cid}:${openId}`) : null;
    const contactName = openId ? contactNames.get(openId) : null;
    const appName = appNames.get(sid);
    const appFallback = appFallbackNames.get(`${cid}:${sid}`);
    const appFallbackName = appFallback?.name || "";
    const preferredAppName = appName || (opts.probeApps ? appFallbackName : "");
    let sname =
      preferredAppName ||
      existingSenderName ||
      appName ||
      appFallbackName ||
      memberName ||
      contactName ||
      null;
    if (opts.namesOnly) {
      sname = personName(sname, senderIdentity(row.raw).identifiers) || null;
      // Failed/empty/echoed names never create a new unknown status, clear or
      // provenance change. The unresolved count below keeps the gap visible.
      if (!sname) continue;
    }
    const partner = chatPartner(row.raw, row.canonical);
    const partnerId = partner?.open_id || partner?.id || partner?.user_id || null;
    const partnerName = partner?.name || partner?.display_name || contactNames.get(partnerId) || null;
    const senderLookupFailed = isAppSender
      ? String(sid).startsWith("cli_") && (failedAppIds.has(sid) || failedBotChats.has(cid) && appIdsByChat.get(cid)?.has(sid))
      : openId && (failedContactIds.has(openId) || failedMemberChats.has(cid) && groupUnresolved.get(cid)?.has(openId));
    if (senderLookupFailed) failedTargets.push({ row, kind: "sender", key: JSON.stringify(["sender", cid, openId || sid]) });
    if (failedContactIds.has(partnerId)) failedTargets.push({ row, kind: "partner", key: JSON.stringify(["partner", partnerId]) });

    next.sender_id = next.sender_id || sid || null;
    next.sender_name = sname;
    if (openId && sname && !existingSenderName) next.sender_id_type = "open_id";
    // This scan supplies a fresh resolved name or unknown, never a new clear.
    delete next.sender_name_state;
    if (sname) {
      if (next.sender_name_resolution_status === "unresolved_app_sender") delete next.sender_name_resolution_status;
      if (next.sender_name_resolution_reason) delete next.sender_name_resolution_reason;
    } else if (isAppSender && sid) {
      const probeStatus = appProbeResultsById.get(sid)?.status || "not_probed";
      next.sender_name_resolution_status = "unresolved_app_sender";
      next.sender_name_resolution_reason =
        probeStatus === "permission_denied" ? "application_api_permission_denied_no_safe_fallback" : "no_safe_fallback";
    }
    if (appName) {
      next.sender_name_source = "application_api";
      next.sender_name_confidence = "high";
    } else if (appFallbackName && (opts.probeApps || !existingSenderName)) {
      next.sender_name_source = appFallback?.source || "chat_bot_unique";
      next.sender_name_confidence = appFallback?.confidence || "medium";
    } else if (!existingSenderName && memberName) {
      next.sender_name_source = "chat_member";
      next.sender_name_confidence = "high";
    } else if (!existingSenderName && contactName) {
      next.sender_name_source = "contact";
      next.sender_name_confidence = "high";
    } else if (opts.namesOnly && existingSenderName) {
      next.sender_name_source = "message_sender";
      next.sender_name_confidence = "high";
    }
    if (!opts.namesOnly) {
      if (!next.sender_type && String(sid || "").startsWith("cli_")) next.sender_type = "app";
      next.chat_id = next.chat_id || cid || null;
      next.chat_type = next.chat_type || ctype || null;
      next.chat_name = next.chat_name || cname || null;
      if (!row.canonical.chat_name) {
        // All chat-name inputs here come from persisted snapshots. Mark them so
        // the shared merge can distinguish enrichment from a fresh source name.
        delete next.chat_name_state;
        if (cname) next.chat_name_source = "local_history";
      }
      if (partnerId || next.chat_partner) {
        next.chat_partner = {
          ...(next.chat_partner && typeof next.chat_partner === "object" ? next.chat_partner : {}),
          open_id: partnerId,
          name: partnerName,
        };
        delete next.chat_partner.name_state;
      }
      if (typeof row.raw.deleted === "boolean" && typeof next.deleted !== "boolean") next.deleted = row.raw.deleted;
    }

    const body = opts.namesOnly ? row.body : normalizedBody(row, next, row.raw);
    const proposedJson = JSON.stringify(next);
    if (proposedJson !== row.canonical_json || body !== row.body) {
      proposals.push({ id: row.id, old: row.canonical_json, next: proposedJson,
        actor: row.actor_id, container: row.container_id, body, raw: row.raw_json });
    }
  }

  const { updates, projections } = prepareUpdates(dbPath, rows, proposals, opts.namesOnly);
  const unresolved = opts.namesOnly ? rows.filter((row) => !personName(projections.get(row.id)?.sender_name,
    [row.actor_id, ...senderIdentity(row.raw).identifiers])).length : 0;
  const unresolvedNameTargets = new Set();
  if (opts.namesOnly) for (const row of rows) {
    if (!personName(projections.get(row.id)?.sender_name, [row.actor_id, ...senderIdentity(row.raw).identifiers])) {
      unresolvedNameTargets.add(JSON.stringify(['sender', row.container_id, row.actor_id]));
    }
  }
  for (const target of failedTargets) {
    const canonical = projections.get(target.row.id) || {};
    const unresolved = target.kind === "sender"
      ? canonical.sender_name_state !== "cleared" && !senderName(target.row.raw, canonical)
      : canonical.chat_partner?.name_state !== "cleared" && !canonical.chat_partner?.name && !canonical.chat_partner?.display_name;
    if (unresolved) unresolvedNameTargets.add(target.key);
  }
  deps.assertReady?.();
  const { updated, skippedConflicts } = commitUpdates(dbPath, updates, opts.dryRun);
  const appFallbacksById = new Map();
  for (const [key, fallback] of appFallbackNames.entries()) {
    const separatorIndex = key.lastIndexOf(":");
    const cid = separatorIndex >= 0 ? key.slice(0, separatorIndex) : "";
    const appId = separatorIndex >= 0 ? key.slice(separatorIndex + 1) : key;
    if (!appFallbacksById.has(appId)) appFallbacksById.set(appId, []);
    appFallbacksById.get(appId).push({
      chat_id: cid,
      name: fallback.name,
      source: fallback.source,
      confidence: fallback.confidence,
    });
  }
  const appResults = [...appStats.values()]
    .sort((left, right) => right.records - left.records || left.app_id.localeCompare(right.app_id))
    .map((stat) => ({
      app_id: stat.app_id,
      records: stat.records,
      existing_names: [...stat.existing_names].sort(),
      fallbacks: appFallbacksById.get(stat.app_id) || [],
      ...(appProbeResultsById.get(stat.app_id) || {
        status: opts.probeApps ? "not_requested" : "not_probed",
      }),
    }));
  /** @type {JsonObject} */
  const output = {
    ok: true,
    dry_run: opts.dryRun,
    scanned: selected.length,
    planned: updates.length,
    updated,
    skipped_conflicts: skippedConflicts,
    unresolved_name_targets: unresolvedNameTargets.size,
    partial: unresolvedNameTargets.size > 0 || Boolean(opts.namesOnly && (unresolved > 0 || exclusions.unverified_identity > 0 || skippedConflicts > 0)),
    unchanged: selected.length - updates.length,
    ...(opts.namesOnly ? { mode: 'names-only', requested_records: selected.length, eligible_records: rows.length,
      resolved: rows.length - unresolved, unresolved, exclusions } : {}),
    contact_names: contactNames.size,
    group_member_names: memberNames.size,
    app_names: appNames.size,
    app_records: [...appStats.values()].reduce((sum, stat) => sum + stat.records, 0),
    app_distinct_ids: appStats.size,
    app_probe: {
      enabled: opts.probeApps,
      requested: diagnostics.app_ids_requested,
      resolved: diagnostics.app_lookup_successes,
      permission_denied: diagnostics.app_lookup_permission_denied,
      other_failures: diagnostics.app_lookup_other_failures,
      fallback_names: diagnostics.app_fallback_names,
      fallback_ambiguous: diagnostics.app_fallback_ambiguous,
      fallback_failures: diagnostics.app_fallback_failures,
    },
    ...scalarDiagnostics(diagnostics),
  };
  if (opts.unsafeDetails) {
    output.app_probe.results = appResults;
    output.unsafe_details = {
      contact_lookup_errors: diagnostics.contact_lookup_errors,
      app_lookup_errors: diagnostics.app_lookup_errors,
      app_lookup_results: diagnostics.app_lookup_results,
      app_fallback_errors: diagnostics.app_fallback_errors,
    };
  }
  return output;
}

export { enrichRecords };
