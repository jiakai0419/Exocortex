#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/lark-im-enrich-records.mjs [options]

Options:
  --db <path>       SQLite database path. Default: ${DEFAULT_DB}
  --limit <n>       Max records to scan. Default: 1000
  --probe-apps      Re-check all app senders with the Application API.
  --unsafe-details  Include local IDs, names, and detailed lookup results in stdout.
  --help            Show this help.
`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, limit: 1000, probeApps: false, unsafeDetails: false };
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
    if (arg === "--unsafe-details") {
      opts.unsafeDetails = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--limit") opts.limit = parsePositiveInt(next, "limit");
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  return opts;
}

function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function sqliteExec(dbPath, sql, label) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: `.timeout 5000\nPRAGMA foreign_keys = ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function runLark(args) {
  const bin = process.env.LARK_CLI || "lark-cli";
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${bin} ${args.join(" ")} failed`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function displayNameFromUser(user) {
  if (!user || typeof user !== "object") return "";
  return user.localized_name || user.name || user.display_name || user.en_name || user.open_id || "";
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
  const sender = raw?.sender && typeof raw.sender === "object" ? raw.sender : {};
  return canonical.sender_id || row.actor_id || sender.id || sender.open_id || "";
}

function senderName(raw, canonical) {
  const sender = raw?.sender && typeof raw.sender === "object" ? raw.sender : {};
  return canonical.sender_name || sender.name || sender.display_name || "";
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

function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

function resolveContactNames(openIds, seed = new Map(), diagnostics = null) {
  const names = new Map(seed);
  const unresolved = uniqueOpenIds(openIds).filter((id) => !names.has(id));
  if (diagnostics) diagnostics.contact_ids_requested = unresolved.length;
  for (const ids of chunk(unresolved, 100)) {
    try {
      const json = runLark([
        "contact",
        "+search-user",
        "--user-ids",
        ids.join(","),
        "--as",
        "user",
        "--format",
        "json",
      ]);
      for (const user of firstArray(json?.users, json?.data?.users)) {
        const name = displayNameFromUser(user);
        if (user?.open_id && name) names.set(user.open_id, name);
      }
    } catch (error) {
      if (diagnostics) diagnostics.contact_lookup_failures += 1;
      if (diagnostics) diagnostics.contact_lookup_errors.push(String(error.message || error).slice(0, 500));
    }
  }
  return names;
}

function resolveChatMemberNames(chatIdValue, openIds) {
  const targetIds = new Set(uniqueOpenIds(openIds));
  const names = new Map();
  let pageToken = "";
  for (let page = 0; page < 50 && targetIds.size > 0; page += 1) {
    const params = { chat_id: chatIdValue, member_id_type: "open_id", page_size: 100 };
    if (pageToken) params.page_token = pageToken;
    try {
      const json = runLark([
        "im",
        "chat.members",
        "get",
        "--as",
        "user",
        "--params",
        JSON.stringify(params),
        "--format",
        "json",
      ]);
      for (const item of firstArray(json?.items, json?.data?.items)) {
        if (targetIds.has(item?.member_id) && item?.name) {
          names.set(item.member_id, item.name);
          targetIds.delete(item.member_id);
        }
      }
      const hasMore = Boolean(json?.has_more ?? json?.data?.has_more);
      pageToken = json?.page_token || json?.data?.page_token || "";
      if (!hasMore || !pageToken) break;
    } catch {
      break;
    }
  }
  return names;
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);

  const rows = loadRows(dbPath, opts.limit).map((row) => ({
    ...row,
    canonical: parseMaybeJson(row.canonical_json) || {},
    raw: parseMaybeJson(row.raw_json) || {},
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
    if (sid && !sname && !isAppSender) contactIds.push(sid);
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
    if (cid && ctype !== "p2p" && sid && !sname && !isAppSender) {
      if (!groupUnresolved.has(cid)) groupUnresolved.set(cid, new Set());
      groupUnresolved.get(cid).add(sid);
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
  const contactNames = resolveContactNames(contactIds, seed, diagnostics);
  const memberNames = new Map();
  for (const [cid, ids] of groupUnresolved.entries()) {
    const names = resolveChatMemberNames(cid, [...ids].filter((id) => !contactNames.has(id)));
    for (const [id, name] of names.entries()) memberNames.set(`${cid}:${id}`, name);
  }
  const appNames = resolveApplicationNames(appIds, diagnostics);
  const appFallbackNames = resolveChatBotAppFallbackNames(appIdsByChat, appNames, diagnostics);
  const appProbeResultsById = new Map(diagnostics.app_lookup_results.map((result) => [result.app_id, result]));

  let updated = 0;
  const updates = [];
  for (const row of rows) {
    const next = { ...row.canonical };
    const cid = chatId(row.raw, row, row.canonical, row.config);
    const ctype = chatType(row.raw, row.canonical, row.config);
    const cname = chatName(row.raw, row.canonical, row.config) || knownChatNames.get(cid) || "";
    const sid = senderId(row.raw, row, row.canonical);
    const isAppSender = senderType(row.raw, row.canonical) === "app" || String(sid || "").startsWith("cli_");
    const existingSenderName = senderName(row.raw, row.canonical);
    const appName = appNames.get(sid);
    const appFallback = appFallbackNames.get(`${cid}:${sid}`);
    const appFallbackName = appFallback?.name || "";
    const preferredAppName = appName || (opts.probeApps ? appFallbackName : "");
    const sname =
      preferredAppName ||
      existingSenderName ||
      appName ||
      appFallbackName ||
      memberNames.get(`${cid}:${sid}`) ||
      contactNames.get(sid) ||
      null;
    const partner = chatPartner(row.raw, row.canonical);
    const partnerId = partner?.open_id || partner?.id || partner?.user_id || null;
    const partnerName = partner?.name || partner?.display_name || contactNames.get(partnerId) || null;

    next.sender_id = next.sender_id || sid || null;
    next.sender_name = sname;
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
    }
    if (!next.sender_type && String(sid || "").startsWith("cli_")) next.sender_type = "app";
    next.chat_id = next.chat_id || cid || null;
    next.chat_type = next.chat_type || ctype || null;
    next.chat_name = next.chat_name || cname || null;
    if (partnerId || next.chat_partner) {
      next.chat_partner = {
        ...(next.chat_partner && typeof next.chat_partner === "object" ? next.chat_partner : {}),
        open_id: partnerId,
        name: partnerName,
      };
    }
    if (typeof row.raw.deleted === "boolean" && typeof next.deleted !== "boolean") next.deleted = row.raw.deleted;

    const body = normalizedBody(row, next, row.raw);
    const canonicalJson = JSON.stringify(next);
    if (canonicalJson !== row.canonical_json || body !== row.body) {
      updates.push(
        `UPDATE records
         SET canonical_json = ${quoteSql(canonicalJson)},
             body = ${quoteSql(body)},
             updated_at = ${quoteSql(new Date().toISOString())}
         WHERE id = ${Number(row.id)};`,
      );
      updated += 1;
    }
  }

  if (updates.length > 0) sqliteExec(dbPath, `BEGIN;\n${updates.join("\n")}\nCOMMIT;`, "update records");
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
    scanned: rows.length,
    updated,
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
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
