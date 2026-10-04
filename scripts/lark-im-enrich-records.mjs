#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { quoteSql } from "../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson as sqliteJson } from "../src/storage/sqlite/readonly-query.mjs";
import { commitEnrichmentUpdates, publicEnrichmentError } from "./lib/lark-im-enrichment.mjs";

import { larkSenderNameIsUnknownSql, larkSenderNamespaceSql, mergeLarkNameProjectionSql } from "../dist/storage/sqlite/lark-name-projection.js";
import { createNameResolver } from "../src/adapters/lark-im/name-resolver.mjs";
import { displayNameFromUser, personName, senderAliasesByOpenId, senderIdentity, senderNameFromSource, senderOpenId } from "../src/adapters/lark-im/sender-identity.mjs";
import { createLarkCliRunner, createTransportState } from "../src/adapters/lark-im/transport.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/lark-im-enrich-records.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --limit <n>       Max records to scan. Default: 1000
  --sender-only     Only repair missing names for the exact --sender-id.
  --sender-id <id>  Required with --sender-only. Explicit open ID; no prefix search.
                    Sender-only limit defaults to 50, maximum 100 eligible rows.
  --probe-apps      Re-check all app senders with the Application API.
  --dry-run         Report proposed changes without writing or acquiring locks.
  --unsafe-details  Include local IDs, names, and detailed lookup results in stdout.
  --help            Show this help.
`;
}

function parsePositiveInt(value, name) {
  const text = String(value);
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed)) throw new Error(`${name} must be positive integer`);
  return parsed;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, limit: 1000, probeApps: false, unsafeDetails: false, dryRun: false,
    senderOnly: false, senderId: "", limitSpecified: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--probe-apps") {
      opts.probeApps = true;
      continue;
    }
    if (arg === "--sender-only") { opts.senderOnly = true; continue; }
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--unsafe-details") {
      opts.unsafeDetails = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--limit") { opts.limit = parsePositiveInt(next, "limit"); opts.limitSpecified = true; }
    else if (arg === "--sender-id") opts.senderId = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (opts.senderOnly !== Boolean(opts.senderId)) throw new Error("--sender-only and --sender-id are required together");
  if (opts.senderOnly) {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(opts.senderId) || opts.senderId.length > 512)
      throw new Error("--sender-id must be an explicit open ID");
    if (opts.probeApps) throw new Error("--probe-apps cannot be used with --sender-only");
    if (!opts.limitSpecified) opts.limit = 50;
    if (opts.limit > 100) throw new Error("sender-only --limit must be at most 100");
  }
  return opts;
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runLark(args, options = {}) {
  const bin = process.env.LARK_CLI || "lark-cli";
  const budget = Number(options.retryBudgetMs) || 5000;
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024,
    timeout: Math.max(1, Math.min(5000, budget)), killSignal: "SIGKILL" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${bin} ${args.join(" ")} failed`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function getSelfProfile() {
  const json = runLark(["contact", "+get-user", "--as", "user", "--format", "json"]);
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

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function uniqueOpenIds(values) {
  return uniqueNonEmpty(values).filter((value) => value.startsWith("ou_"));
}

function uniqueAppIds(values) {
  return uniqueNonEmpty(values).filter((value) => value.startsWith("cli_"));
}

function parseLarkError(error) {
  const message = String(error?.message || error || "");
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart));
      const detail = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
      return {
        code: Number(detail?.code ?? parsed?.code) || null,
        type: detail?.type || parsed?.type || null,
        subtype: detail?.subtype || parsed?.subtype || null,
        message: detail?.message || detail?.msg || parsed?.msg || message,
      };
    } catch {
      // Fall through to text parsing below.
    }
  }
  const code = message.match(/\b(\d{5,})\b/)?.[1] || null;
  return {
    code: code ? Number(code) : null,
    type: null,
    subtype: null,
    message,
  };
}

function isPermissionDeniedLarkError(info) {
  return (
    info?.code === 210508 ||
    /insufficient permission|permission denied|permission level|no permission|unauthorized/i.test(
      String(info?.message || ""),
    )
  );
}

function botName(bot) {
  if (!bot || typeof bot !== "object") return "";
  return bot.bot_name || bot.name || bot.display_name || "";
}

function botAppId(bot) {
  if (!bot || typeof bot !== "object") return "";
  return bot.app_id || bot.application_id || bot.bot_app_id || bot.cli_id || "";
}

function resolveApplicationNames(appIds, diagnostics = null) {
  const ids = uniqueAppIds(appIds);
  const names = new Map();
  if (diagnostics) diagnostics.app_ids_requested = ids.length;
  for (const appId of ids) {
    try {
      const json = runLark([
        "api",
        "GET",
        `/open-apis/application/v6/applications/${appId}`,
        "--as",
        "bot",
        "--params",
        JSON.stringify({ lang: "zh_cn" }),
        "--format",
        "json",
      ]);
      const app = json?.data?.app || json?.app;
      const name = app?.app_name || firstArray(app?.i18n).find((item) => item?.i18n_key === "zh_cn")?.name || "";
      if (name) {
        names.set(appId, name);
        if (diagnostics) {
          diagnostics.app_lookup_successes += 1;
          diagnostics.app_lookup_results.push({ app_id: appId, status: "resolved", name });
        }
      } else if (diagnostics) {
        diagnostics.app_lookup_failures += 1;
        diagnostics.app_lookup_other_failures += 1;
        diagnostics.app_lookup_results.push({ app_id: appId, status: "missing_name" });
      }
    } catch (error) {
      if (diagnostics) {
        const info = parseLarkError(error);
        const status = isPermissionDeniedLarkError(info) ? "permission_denied" : "failed";
        diagnostics.app_lookup_failures += 1;
        if (status === "permission_denied") diagnostics.app_lookup_permission_denied += 1;
        else diagnostics.app_lookup_other_failures += 1;
        const result = {
          app_id: appId,
          status,
          code: info.code,
          message: String(info.message || "").slice(0, 300),
        };
        diagnostics.app_lookup_results.push(result);
        diagnostics.app_lookup_errors.push(result);
      }
    }
  }
  return names;
}

function resolveChatBotAppFallbackNames(appIdsByChat, officialApps, diagnostics = null) {
  const names = new Map();
  for (const [cid, ids] of appIdsByChat.entries()) {
    const pendingIds = uniqueAppIds([...ids]).filter((id) => !officialApps.has(id));
    if (pendingIds.length === 0) continue;
    if (diagnostics) diagnostics.app_fallback_chats_requested += 1;
    try {
      const json = runLark([
        "im",
        "chat.members",
        "bots",
        "--as",
        "user",
        "--params",
        JSON.stringify({ chat_id: cid }),
        "--format",
        "json",
      ]);
      const bots = firstArray(json?.items, json?.data?.items).filter((bot) => botName(bot));
      const directMatches = new Set();
      for (const bot of bots) {
        const appId = botAppId(bot);
        if (pendingIds.includes(appId)) {
          directMatches.add(appId);
          names.set(`${cid}:${appId}`, {
            name: botName(bot),
            source: "chat_bot_app_id",
            confidence: "high",
          });
        }
      }

      const remainingIds = pendingIds.filter((id) => !directMatches.has(id));
      const remainingBots = bots.filter((bot) => !directMatches.has(botAppId(bot)));
      if (remainingIds.length === 1 && remainingBots.length === 1) {
        names.set(`${cid}:${remainingIds[0]}`, {
          name: botName(remainingBots[0]),
          source: "chat_bot_unique",
          confidence: "medium",
        });
      } else if (remainingIds.length > 0 && remainingBots.length > 0 && diagnostics) {
        diagnostics.app_fallback_ambiguous += 1;
        diagnostics.app_fallback_errors.push({
          chat_id: cid,
          pending_app_ids: remainingIds.length,
          bot_candidates: remainingBots.length,
          status: "ambiguous",
        });
      }
    } catch (error) {
      if (diagnostics) {
        diagnostics.app_fallback_failures += 1;
        diagnostics.app_fallback_errors.push({
          chat_id: cid,
          status: "failed",
          message: String(error.message || error).slice(0, 300),
        });
      }
    }
  }
  if (diagnostics) diagnostics.app_fallback_names = names.size;
  return names;
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

function loadRows(dbPath, limit) {
  return sqliteJson(
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
     ORDER BY r.occurred_at_ms DESC, r.id DESC
     LIMIT ${Number(limit)};`,
    "load records",
  );
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
  const updates = [];
  for (const result of merged) {
    const row = rowsById.get(result.id);
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
  return updates;
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

function runSenderOnly(dbPath, opts) {
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
  const rows = candidates.slice(0, opts.limit).map((row) => ({
    ...row, canonical: parseMaybeJson(row.canonical_json) || {}, raw: nativeRow(parseMaybeJson(row.raw_json) || {}),
  }));
  if (rows.some((row) => senderOpenId(row.raw) !== opts.senderId)) throw new Error('sender candidate identity validation failed');
  const remote = { calls: 0, member_pages: 0, member_chats: 0, failures: 0,
    budget_exhausted: false, page_limit_reached: false, chat_limit_reached: false };
  const deadline = Date.now() + 30_000;
  const transport = createLarkCliRunner({ timeoutMs: 5000, state: createTransportState() });
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
      return transport(args, { ...options, retries: 0, timeoutMs: Math.min(5000, remaining),
        retryBudgetMs: Math.min(5000, remaining) });
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
  const updates = prepareUpdates(dbPath, rows, proposals, true);
  const { updated, skippedConflicts } = commitUpdates(dbPath, updates, opts.dryRun);
  const unresolved = rows.length - proposals.length;
  process.stdout.write(`${JSON.stringify({
    ok: true, mode: 'sender-only', dry_run: opts.dryRun, scanned: rows.length,
    planned: updates.length, updated, skipped_conflicts: skippedConflicts,
    unchanged: rows.length - updates.length, resolved: proposals.length, unresolved,
    has_more_candidates: hasMore, remote,
  }, null, 2)}\n`);
  if (unresolved > 0 || hasMore || skippedConflicts > 0) process.exitCode = 1;
}

function main(opts) {
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  if (opts.senderOnly) return runSenderOnly(dbPath, opts);

  const rows = loadRows(dbPath, opts.limit).map((row) => ({
    ...row,
    canonical: parseMaybeJson(row.canonical_json) || {},
    raw: nativeRow(parseMaybeJson(row.raw_json) || {}),
    config: parseMaybeJson(row.scope_config_json) || {},
  }));
  const knownChatNames = loadKnownChatNames(dbPath);

  const self = getSelfProfile();
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
    if (partnerId && !partnerName) contactIds.push(partnerId);

    const ctype = chatType(row.raw, row.canonical, row.config);
    if (cid && ctype !== "p2p" && openId && !sname && !isAppSender) {
      if (!groupUnresolved.has(cid)) groupUnresolved.set(cid, new Set());
      groupUnresolved.get(cid).add(openId);
    }
  }

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
  // Request construction, response validation and seed priority have one
  // implementation shared with ingestion and the bounded sender-only mode.
  const resolver = createNameResolver({ run(args, options) {
    const contact = args[0] === "contact" && args[1] === "+search-user";
    if (contact) diagnostics.contact_ids_requested += args[args.indexOf("--user-ids") + 1].split(",").length;
    try { return runLark(args, options); } catch (error) {
      if (contact) {
        diagnostics.contact_lookup_failures += 1;
        diagnostics.contact_lookup_errors.push(String(error.message || error).slice(0, 500));
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
  const appNames = resolveApplicationNames(appIds, diagnostics);
  const appFallbackNames = resolveChatBotAppFallbackNames(appIdsByChat, appNames, diagnostics);
  const appProbeResultsById = new Map(diagnostics.app_lookup_results.map((result) => [result.app_id, result]));

  const proposals = [];
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
    const sname =
      preferredAppName ||
      existingSenderName ||
      appName ||
      appFallbackName ||
      memberName ||
      contactName ||
      null;
    const partner = chatPartner(row.raw, row.canonical);
    const partnerId = partner?.open_id || partner?.id || partner?.user_id || null;
    const partnerName = partner?.name || partner?.display_name || contactNames.get(partnerId) || null;

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
      next.sender_name_source = appFallback.source || "chat_bot_unique";
      next.sender_name_confidence = appFallback.confidence || "medium";
    } else if (!existingSenderName && memberName) {
      next.sender_name_source = "chat_member";
      next.sender_name_confidence = "high";
    } else if (!existingSenderName && contactName) {
      next.sender_name_source = "contact";
      next.sender_name_confidence = "high";
    }
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

    const body = normalizedBody(row, next, row.raw);
    const proposedJson = JSON.stringify(next);
    if (proposedJson !== row.canonical_json || body !== row.body) {
      proposals.push({ id: row.id, old: row.canonical_json, next: proposedJson,
        actor: row.actor_id, container: row.container_id, body, raw: row.raw_json });
    }
  }

  const updates = prepareUpdates(dbPath, rows, proposals);
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
  const output = {
    ok: true,
    dry_run: opts.dryRun,
    scanned: rows.length,
    planned: updates.length,
    updated,
    skipped_conflicts: skippedConflicts,
    unchanged: rows.length - updates.length,
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
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

try {
  const opts = parseArgs(process.argv.slice(2));
  try {
    main(opts);
  } catch (error) {
    throw publicEnrichmentError(error, "record enrichment failed");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
