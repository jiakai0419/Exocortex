#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { block, compact as compactText, kv, list, renderError, section, statusBadge, subtitle, title } from "./lib/terminal.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";
const DEFAULT_CHAT_PAGES = 5;
const DEFAULT_HOT_CHATS = 20;
const DEFAULT_MESSAGES_PER_CHAT = 5;

function usage() {
  return `Usage: node scripts/lark-im-lag-check.mjs [options]

Options:
  --db <path>                SQLite database path. Default: ${DEFAULT_DB}
  --chat-pages <n>           Hot chat-list pages to probe. Default: ${DEFAULT_CHAT_PAGES}
  --hot-chats <n>            Max non-muted hot chats to inspect. Default: ${DEFAULT_HOT_CHATS}
  --messages-per-chat <n>    Recent messages per hot chat. Default: ${DEFAULT_MESSAGES_PER_CHAT}
  --start <iso>              Probe start time. Default: today 00:00 local time.
  --end <iso>                Probe end time. Default: now.
  --format <fmt>             text | json. Default: text
  --help                     Show this help.
`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function localOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function localIsoFromMs(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${localOffset(date)}`;
}

function defaultStartIso() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T00:00:00${localOffset(now)}`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    chatPages: DEFAULT_CHAT_PAGES,
    hotChats: DEFAULT_HOT_CHATS,
    messagesPerChat: DEFAULT_MESSAGES_PER_CHAT,
    start: defaultStartIso(),
    end: localIsoFromMs(Date.now()),
    format: "text",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--chat-pages") opts.chatPages = parsePositiveInt(next, "chat-pages");
    else if (arg === "--hot-chats") opts.hotChats = parsePositiveInt(next, "hot-chats");
    else if (arg === "--messages-per-chat") opts.messagesPerChat = parsePositiveInt(next, "messages-per-chat");
    else if (arg === "--start") opts.start = next;
    else if (arg === "--end") opts.end = next;
    else if (arg === "--format") opts.format = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  opts.startMs = parseLarkTimeMs(opts.start);
  opts.endMs = parseLarkTimeMs(opts.end);
  if (!Number.isFinite(opts.startMs)) throw new Error(`invalid --start: ${opts.start}`);
  if (!Number.isFinite(opts.endMs)) throw new Error(`invalid --end: ${opts.end}`);
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

function runLark(args) {
  const bin = process.env.LARK_CLI || "lark-cli";
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) {
    const error = new Error(result.stderr.trim() || `${bin} ${args.join(" ")} failed`);
    error.exitCode = result.status;
    throw error;
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function envelope(json, collectionName) {
  const root = json && typeof json === "object" ? json : {};
  const data = root.data && typeof root.data === "object" ? root.data : {};
  return {
    items: firstArray(root[collectionName], data[collectionName], root.items, data.items, root.results, data.results),
    has_more: Boolean(root.has_more ?? data.has_more),
    page_token: root.page_token || data.page_token || "",
  };
}

function parseLarkTimeMs(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const parsed = Number.parseInt(String(value), 10);
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }
  const simple = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (simple && !/[zZ]|[+-]\d{2}:\d{2}$/.test(String(value))) {
    const [, year, month, day, hour, minute, second = "0"] = simple;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
  }
  return Date.parse(String(value));
}

function messageId(message) {
  return message?.message_id || message?.id || "";
}

function senderId(message) {
  const sender = message?.sender && typeof message.sender === "object" ? message.sender : {};
  return sender.id || sender.open_id || sender.sender_id?.open_id || sender.sender_id || "";
}

function senderName(message) {
  const sender = message?.sender && typeof message.sender === "object" ? message.sender : {};
  if (sender.name || sender.display_name) return sender.name || sender.display_name;
  if (String(sender.id || "").startsWith("cli_")) return `应用 ${String(sender.id).slice(0, 8)}...`;
  return sender.id ? `${String(sender.id).slice(0, 8)}...` : "unknown";
}

function bodyFromContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    return JSON.stringify(content);
  }
  return String(content);
}

function compact(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function isRestrictedModeError(error) {
  const message = String(error?.message || error || "");
  return /"code"\s*:\s*231203|Restricted Mode|don't allow copying or forwarding messages/i.test(message);
}

function getSelfOpenId() {
  const json = runLark(["contact", "+get-user", "--as", "user", "--format", "json"]);
  return (
    json?.open_id ||
    json?.user?.open_id ||
    json?.data?.open_id ||
    json?.data?.user?.open_id ||
    json?.data?.user_id?.open_id ||
    ""
  );
}

function fetchHotChats(opts) {
  const chats = [];
  const seen = new Set();
  let pageToken = "";
  for (let page = 0; page < opts.chatPages && chats.length < opts.hotChats; page += 1) {
    const args = [
      "im",
      "+chat-list",
      "--as",
      "user",
      "--exclude-muted",
      "--types",
      "group",
      "--sort",
      "active_time",
      "--page-size",
      "100",
      "--format",
      "json",
    ];
    if (pageToken) args.push("--page-token", pageToken);
    const json = runLark(args);
    const pageData = envelope(json, "chats");
    for (const chat of pageData.items) {
      if (!chat?.chat_id || seen.has(chat.chat_id)) continue;
      seen.add(chat.chat_id);
      chats.push({
        chat_id: chat.chat_id,
        chat_name: chat.name || chat.i18n_names?.zh_cn || chat.i18n_names?.en_us || chat.chat_id,
        chat_type: chat.chat_mode || "group",
      });
      if (chats.length >= opts.hotChats) break;
    }
    pageToken = pageData.page_token;
    if (!pageData.has_more || !pageToken) break;
  }
  return chats;
}

function fetchRecentChatMessages(chat, opts) {
  const args = [
    "im",
    "+chat-messages-list",
    "--as",
    "user",
    "--chat-id",
    chat.chat_id,
    "--start",
    localIsoFromMs(opts.startMs),
    "--end",
    localIsoFromMs(opts.endMs),
    "--order",
    "desc",
    "--page-size",
    String(Math.min(50, opts.messagesPerChat)),
    "--no-reactions",
    "--format",
    "json",
  ];
  const json = runLark(args);
  return envelope(json, "messages").items;
}

function loadExistingRecords(dbPath, messageIds) {
  if (messageIds.length === 0) return new Map();
  const rows = sqliteJson(
    dbPath,
    `SELECT external_id, occurred_at_ms
     FROM records
     WHERE source_id = 'lark.im'
       AND external_id IN (${messageIds.map((id) => quoteSql(id)).join(", ")});`,
    "load existing records",
  );
  return new Map(rows.map((row) => [row.external_id, row]));
}

function localLatest(dbPath) {
  const rows = sqliteJson(
    dbPath,
    `SELECT external_id, direction, occurred_at_ms, occurred_at, json_extract(canonical_json, '$.chat_name') AS chat_name
     FROM records
     WHERE source_id = 'lark.im'
       AND record_type = 'lark.im.message'
     ORDER BY occurred_at_ms DESC, external_id DESC
     LIMIT 1;`,
    "local latest",
  );
  return rows[0] || null;
}

function collect(dbPath, opts) {
  const selfOpenId = getSelfOpenId();
  if (!selfOpenId) throw new Error("could not resolve current Lark user open_id");

  const chats = fetchHotChats(opts);
  const remoteMessages = [];
  const probeErrors = [];
  const unsupportedChats = [];

  for (const chat of chats) {
    try {
      const messages = fetchRecentChatMessages(chat, opts);
      for (const message of messages) {
        const id = messageId(message);
        const createdMs = parseLarkTimeMs(message?.create_time ?? message?.created_at ?? message?.create_time_ms);
        if (!id || !Number.isFinite(createdMs)) continue;
        if (senderId(message) === selfOpenId) continue;
        remoteMessages.push({
          message_id: id,
          chat_id: chat.chat_id,
          chat_name: message.chat_name || chat.chat_name,
          chat_type: message.chat_type || chat.chat_type,
          sender_id: senderId(message),
          sender_name: senderName(message),
          msg_type: message.msg_type || message.message_type || "unknown",
          create_time: message.create_time || new Date(createdMs).toISOString(),
          created_at_ms: createdMs,
          body: bodyFromContent(message.content),
        });
      }
    } catch (error) {
      if (isRestrictedModeError(error)) {
        unsupportedChats.push({ chat_id: chat.chat_id, chat_name: chat.chat_name, reason: "restricted_mode" });
      } else {
        probeErrors.push({ chat_id: chat.chat_id, chat_name: chat.chat_name, error: String(error.message || error).slice(0, 500) });
      }
    }
  }

  remoteMessages.sort((a, b) => b.created_at_ms - a.created_at_ms || b.message_id.localeCompare(a.message_id));
  const existing = loadExistingRecords(dbPath, [...new Set(remoteMessages.map((message) => message.message_id))]);
  const missing = remoteMessages.filter((message) => !existing.has(message.message_id));
  const latestRemote = remoteMessages[0] || null;
  const latestLocal = localLatest(dbPath);
  const latestRemoteIsLocal = latestRemote ? existing.has(latestRemote.message_id) : null;
  const lagMs =
    latestRemote && latestLocal?.occurred_at_ms
      ? Math.max(0, Number(latestRemote.created_at_ms) - Number(latestLocal.occurred_at_ms))
      : null;

  let status = "healthy";
  if (probeErrors.length > 0) status = "needs_attention";
  else if (missing.length > 0) status = "delayed";
  else if (latestRemoteIsLocal === false) status = "delayed";

  return {
    ok: status === "healthy",
    status,
    checked_at: new Date().toISOString(),
    window: {
      start: localIsoFromMs(opts.startMs),
      end: localIsoFromMs(opts.endMs),
    },
    probe: {
      hot_chats_requested: opts.hotChats,
      hot_chats_found: chats.length,
      messages_per_chat: opts.messagesPerChat,
      remote_messages_checked: remoteMessages.length,
      unsupported_chats: unsupportedChats.length,
      probe_errors: probeErrors.length,
    },
    latest_remote: latestRemote
      ? {
          message_id: latestRemote.message_id,
          created_at: new Date(latestRemote.created_at_ms).toISOString(),
          chat_name: latestRemote.chat_name,
          sender_name: latestRemote.sender_name,
          body: compact(latestRemote.body),
          exists_locally: existing.has(latestRemote.message_id),
        }
      : null,
    latest_local: latestLocal
      ? {
          message_id: latestLocal.external_id,
          created_at: latestLocal.occurred_at,
          chat_name: latestLocal.chat_name,
          direction: latestLocal.direction,
        }
      : null,
    lag_ms: lagMs,
    missing_count: missing.length,
    missing: missing.slice(0, 10).map((message) => ({
      message_id: message.message_id,
      created_at: new Date(message.created_at_ms).toISOString(),
      chat_name: message.chat_name,
      sender_name: message.sender_name,
      body: compact(message.body),
    })),
    unsupported_chats: unsupportedChats.slice(0, 10),
    probe_errors: probeErrors.slice(0, 10),
  };
}

function render(report) {
  const lines = [
    `${title("Lark IM lag check")} ${statusBadge(report.status)}`,
    subtitle(`${report.window.start} to ${report.window.end}`),
    "",
    section("Summary"),
    kv([
      ["Hot chats", `${report.probe.hot_chats_found}/${report.probe.hot_chats_requested}`],
      ["Remote messages checked", report.probe.remote_messages_checked],
      ["Missing remote messages", report.missing_count],
      ["Latest remote-local lag", report.lag_ms === null ? "unknown" : `${Math.round(report.lag_ms / 1000)}s`],
      ["Probe errors", report.probe.probe_errors],
      ["Unsupported chats", report.probe.unsupported_chats],
    ]),
  ];
  if (report.latest_remote) {
    lines.push("");
    lines.push(section("Latest remote"));
    lines.push(
      kv([
        ["Created", report.latest_remote.created_at],
        ["Chat", report.latest_remote.chat_name],
        ["Sender", report.latest_remote.sender_name],
        ["Exists locally", report.latest_remote.exists_locally],
      ]),
    );
    if (report.latest_remote.body) lines.push(`  ${compactText(report.latest_remote.body, 180)}`);
  }
  if (report.latest_local) {
    lines.push("");
    lines.push(section("Latest local"));
    lines.push(
      kv([
        ["Created", report.latest_local.created_at],
        ["Chat", report.latest_local.chat_name || ""],
        ["Direction", report.latest_local.direction],
      ]),
    );
  }
  if (report.missing.length > 0) {
    lines.push("");
    lines.push(section("Missing"));
    lines.push(
      list(
        report.missing.map(
          (message) =>
            `${message.created_at} ${message.chat_name} / ${message.sender_name}: ${compactText(message.body, 140)}`,
        ),
      ),
    );
  }
  if (report.unsupported_chats.length > 0) {
    lines.push("");
    lines.push(section("Unsupported chats"));
    lines.push(list(report.unsupported_chats.map((chat) => `${chat.chat_name}: ${chat.reason}`)));
  }
  if (report.probe_errors.length > 0) {
    lines.push("");
    lines.push(section("Probe errors"));
    lines.push(list(report.probe_errors.map((error) => `${error.chat_name}: ${compactText(error.error, 180)}`)));
  }
  return `${block(lines)}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const report = collect(dbPath, opts);
  if (opts.format === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(render(report));
  if (!report.ok) process.exit(2);
}

try {
  main();
} catch (error) {
  process.stderr.write(renderError(error));
  process.exit(1);
}
