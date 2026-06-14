#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { block, compact, key, renderError, section, statusBadge, subtitle, title } from "./lib/terminal.mjs";

const DEFAULT_DB = "data/exocortex.sqlite";

function usage() {
  return `Usage: node scripts/messages.mjs [options]

Options:
  --db <path>             SQLite database path. Default: ${DEFAULT_DB}
  --direction <value>     all | sent | received. Default: all
  --limit <n>             Number of messages. Default: 30
  --search <text>         Filter message body by keyword.
  --format <fmt>          text | json. Default: text
  --help                  Show this help.
`;
}

function parseArgs(argv) {
  const opts = { db: DEFAULT_DB, direction: "all", limit: 30, search: "", format: "text" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--db") opts.db = next;
    else if (arg === "--direction") opts.direction = next;
    else if (arg === "--limit") opts.limit = parsePositiveInt(next, "limit");
    else if (arg === "--search") opts.search = next;
    else if (arg === "--format") opts.format = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["all", "sent", "received"].includes(opts.direction)) {
    throw new Error("--direction must be all, sent, or received");
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  return opts;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-json", dbPath], {
    input: `.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function buildWhere(opts) {
  const clauses = [];
  if (opts.direction !== "all") clauses.push(`direction = ${quoteSql(opts.direction)}`);
  if (opts.search) clauses.push(`body LIKE ${quoteSql(`%${opts.search}%`)}`);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function loadMessages(dbPath, opts) {
  return sqliteJson(
    dbPath,
    `SELECT
       r.id,
       r.direction,
       r.record_type,
       r.occurred_at,
       r.occurred_at_ms,
       r.actor_id,
       r.container_id,
       r.external_id,
       r.body,
       r.canonical_json,
       r.raw_json,
       s.config_json AS scope_config_json
     FROM records r
     LEFT JOIN sync_scopes s ON s.id = r.first_seen_scope_id
     ${buildWhere(opts)}
     ORDER BY r.occurred_at_ms DESC, r.external_id DESC
     LIMIT ${Number(opts.limit)};`,
    "read messages",
  ).map((row) => enrichRow(row));
}

function parseMaybeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function shortId(value, length = 8) {
  return value ? `${String(value).slice(0, length)}...` : "unknown";
}

function nameOrId(name, id) {
  if (!name && String(id || "").startsWith("cli_")) return `应用 ${shortId(id, 8)}`;
  return name || shortId(id, 8);
}

function senderLabel(name, id, senderType) {
  const display = nameOrId(name, id);
  return senderType === "app" ? `应用：${display.replace(/^应用\s+/, "")}` : display;
}

function messageTypeLabel(type) {
  if (!type) return "unknown";
  const labels = {
    interactive: "卡片",
    post: "富文本",
    text: "文本",
    image: "图片",
  };
  return labels[type] || type;
}

function isInvalidRenderedContent(value) {
  return /^\[Invalid .+ JSON\]$/.test(String(value || "").trim());
}

function displayBody(body, canonical, raw) {
  if ((canonical.deleted === true || raw.deleted === true) && isInvalidRenderedContent(body)) {
    return "[已撤回/已删除：飞书未返回原始富文本内容]";
  }
  return body;
}

function enrichRow(row) {
  const canonical = parseMaybeJson(row.canonical_json) || {};
  const raw = parseMaybeJson(row.raw_json) || {};
  const config = parseMaybeJson(row.scope_config_json) || {};
  const sender = raw.sender && typeof raw.sender === "object" ? raw.sender : {};
  const chatPartner =
    canonical.chat_partner || (raw.chat_partner && typeof raw.chat_partner === "object" ? raw.chat_partner : null);
  const chatType =
    canonical.chat_type ||
    raw.chat_type ||
    raw.chat?.chat_type ||
    config.chat_type ||
    (config.chat_id ? "group" : "unknown");
  const chatName = canonical.chat_name || raw.chat_name || raw.chat?.name || config.chat_name || null;
  const chatId = canonical.chat_id || row.container_id || config.chat_id || raw.chat_id || null;
  const senderId = canonical.sender_id || row.actor_id || sender.id || sender.open_id || null;
  const senderName = canonical.sender_name || sender.name || sender.display_name || null;
  const senderType = canonical.sender_type || (String(senderId || "").startsWith("cli_") ? "app" : null);
  const messageType = canonical.msg_type || raw.msg_type || raw.message_type || null;
  const partnerId = chatPartner?.open_id || chatPartner?.id || chatPartner?.user_id || null;
  const partnerName = chatPartner?.name || chatPartner?.display_name || null;
  const isP2p = chatType === "p2p";
  const isGroupLike = !isP2p;
  return {
    ...row,
    canonical,
    raw,
    scope_config: config,
    display: {
      external_id: shortId(row.external_id, 8),
      scene: isP2p ? "私聊" : chatType === "topic" ? "话题群" : "群聊",
      sender: senderLabel(senderName, senderId, senderType),
      sender_type: senderType || "unknown",
      message_type: messageTypeLabel(messageType),
      recipient:
        isP2p
          ? row.direction === "sent"
            ? nameOrId(partnerName, partnerId)
            : "我"
          : null,
      chat: isGroupLike ? nameOrId(chatName, chatId) : null,
      body: displayBody(row.body, canonical, raw),
    },
  };
}

function renderText(messages) {
  if (messages.length === 0) return "No messages.\n";
  const lines = [];
  lines.push(title(`Messages (${messages.length})`));
  lines.push(subtitle("Latest synced messages first."));
  lines.push("");
  for (const message of messages) {
    const time = message.occurred_at
      ? new Date(message.occurred_at).toLocaleString()
      : "unknown time";
    lines.push(
      `${statusBadge(message.direction)} ${time}  ${subtitle(message.display.external_id)}  ${section(message.display.scene)}`,
    );
    lines.push(`  ${key("发送人")}  ${message.display.sender}`);
    if (message.display.recipient) lines.push(`  ${key("接收人")}  ${message.display.recipient}`);
    if (message.display.chat) lines.push(`  ${key("群")}      ${message.display.chat}`);
    lines.push(`  ${key("类型")}    ${message.display.sender_type} / ${message.display.message_type}`);
    lines.push(`  ${key("消息")}    ${compact(message.display.body)}`);
    lines.push("");
  }
  return `${block(lines)}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolve(opts.db);
  if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const messages = loadMessages(dbPath, opts);
  if (opts.format === "json") process.stdout.write(`${JSON.stringify(messages, null, 2)}\n`);
  else process.stdout.write(renderText(messages));
}

try {
  main();
} catch (error) {
  process.stderr.write(renderError(error));
  process.exit(1);
}
