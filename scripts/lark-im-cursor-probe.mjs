#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_PAGE_SIZE = "5";
const DEFAULT_CHAT_LIMIT = "1";
const DEFAULT_CHAT_PAGE_SIZE = "10";
const DEFAULT_CHAT_PAGES = "5";
const ID_RE = /\b(oc|ou|om|omt|on)_[A-Za-z0-9]+\b/g;

function usage() {
  return `Usage: node scripts/lark-im-cursor-probe.mjs [options]

Options:
  --start <iso>          Probe window start. Default: today 00:00 local time.
  --end <iso>            Probe window end. Default: today 23:59 local time.
  --page-size <n>        Page size for message probes. Default: ${DEFAULT_PAGE_SIZE}.
  --chat-limit <n>       Non-muted chats to probe. Default: ${DEFAULT_CHAT_LIMIT}.
  --chat-page-size <n>   Chat-list page size. Default: ${DEFAULT_CHAT_PAGE_SIZE}.
  --chat-pages <n>       Max chat-list pages to scan. Default: ${DEFAULT_CHAT_PAGES}.
  --chat-types <types>   Chat types for received probe. Default: group.
  --out <path>           Write JSON report to this path.
  --help                 Show this help.

The report stores structural evidence only: hashed IDs, timestamps, page
metadata, command statuses, and ordering checks. It does not persist message
content, chat names, or contact names.
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

function localDay(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localIsoFromMs(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${localOffset(date)}`;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const now = new Date();
  const day = localDay(now);
  const offset = localOffset(now);
  const opts = {
    start: `${day}T00:00:00${offset}`,
    end: `${day}T23:59:59${offset}`,
    pageSize: parsePositiveInt(DEFAULT_PAGE_SIZE, "page-size"),
    chatLimit: parsePositiveInt(DEFAULT_CHAT_LIMIT, "chat-limit"),
    chatPageSize: parsePositiveInt(DEFAULT_CHAT_PAGE_SIZE, "chat-page-size"),
    chatPages: parsePositiveInt(DEFAULT_CHAT_PAGES, "chat-pages"),
    chatTypes: "group",
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--start") opts.start = next;
    else if (arg === "--end") opts.end = next;
    else if (arg === "--page-size") opts.pageSize = parsePositiveInt(next, "page-size");
    else if (arg === "--chat-limit") opts.chatLimit = parsePositiveInt(next, "chat-limit");
    else if (arg === "--chat-page-size") opts.chatPageSize = parsePositiveInt(next, "chat-page-size");
    else if (arg === "--chat-pages") opts.chatPages = parsePositiveInt(next, "chat-pages");
    else if (arg === "--chat-types") opts.chatTypes = next;
    else if (arg === "--out") opts.out = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  return opts;
}

function redactText(text) {
  return String(text || "")
    .replace(ID_RE, "$1_<redacted>")
    .slice(0, 2000);
}

function hashId(value) {
  if (!value) return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function commandLabel(cmd, args, redactedFlags = []) {
  const parts = [cmd, ...args];
  for (const flag of redactedFlags) {
    const index = parts.indexOf(flag);
    if (index >= 0 && index + 1 < parts.length) {
      parts[index + 1] = "<redacted>";
    }
  }
  return parts.join(" ");
}

function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return {
      _parse_error: error.message,
      _stdout_excerpt: redactText(trimmed),
    };
  }
}

function runCommand(id, cmd, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  return {
    id,
    command: commandLabel(cmd, args, options.redactedFlags || []),
    exit_code: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    ok: result.status === 0,
    started_at: startedAt,
    finished_at: finishedAt,
    stderr: redactText(result.stderr || ""),
    json: parseJson(result.stdout || ""),
  };
}

function runLark(id, args, options = {}) {
  const bin = process.env.LARK_CLI || "lark-cli";
  return runCommand(id, bin, args, options);
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

function getEnvelope(json, collectionName) {
  const root = json && typeof json === "object" ? json : {};
  const data = root.data && typeof root.data === "object" ? root.data : {};
  return {
    items: firstArray(root[collectionName], data[collectionName], root.items, data.items, root.results, data.results),
    has_more: Boolean(root.has_more ?? data.has_more),
    page_token: root.page_token || data.page_token || "",
  };
}

function getSelfOpenId(selfJson) {
  if (!selfJson || typeof selfJson !== "object") return "";
  return (
    selfJson.open_id ||
    selfJson.user?.open_id ||
    selfJson.data?.open_id ||
    selfJson.data?.user?.open_id ||
    selfJson.data?.user_id?.open_id ||
    ""
  );
}

function senderId(message) {
  const sender = message?.sender;
  if (!sender || typeof sender !== "object") return "";
  return (
    sender.id ||
    sender.open_id ||
    sender.sender_id?.open_id ||
    sender.sender_id?.user_id ||
    sender.sender_id ||
    ""
  );
}

function chatId(message) {
  return message?.chat_id || message?.chat?.chat_id || message?.chat?.id || "";
}

function createTimeMs(message) {
  const value = message?.create_time ?? message?.created_at ?? message?.create_time_ms;
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return null;
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }
  const parsedDate = Date.parse(String(value));
  return Number.isFinite(parsedDate) ? parsedDate : null;
}

function createTimeRaw(message) {
  const value = message?.create_time ?? message?.created_at ?? message?.create_time_ms;
  return value === undefined ? null : value;
}

function messageId(message) {
  return message?.message_id || message?.id || "";
}

function summarizeMessages(messages) {
  return messages.map((message, index) => ({
    index,
    message_id_hash: hashId(messageId(message)),
    chat_id_hash: hashId(chatId(message)),
    sender_id_hash: hashId(senderId(message)),
    create_time_raw: createTimeRaw(message),
    create_time_ms: createTimeMs(message),
    msg_type: message?.msg_type || message?.message_type || null,
    has_thread: Boolean(message?.thread_id),
    deleted: typeof message?.deleted === "boolean" ? message.deleted : null,
    updated: typeof message?.updated === "boolean" ? message.updated : null,
  }));
}

function orderAnalysis(summaries) {
  const violations = [];
  const sameTimestampGroups = new Map();
  for (let i = 0; i < summaries.length; i += 1) {
    const current = summaries[i];
    if (current.create_time_ms !== null) {
      const key = String(current.create_time_ms);
      sameTimestampGroups.set(key, (sameTimestampGroups.get(key) || 0) + 1);
    }
    if (i === 0) continue;
    const previous = summaries[i - 1];
    if (
      previous.create_time_ms !== null &&
      current.create_time_ms !== null &&
      current.create_time_ms < previous.create_time_ms
    ) {
      violations.push({
        index: i,
        previous_create_time_ms: previous.create_time_ms,
        current_create_time_ms: current.create_time_ms,
      });
    }
  }
  return {
    monotonic_create_time_asc: violations.length === 0,
    create_time_desc_violations: violations,
    same_timestamp_group_count: Array.from(sameTimestampGroups.values()).filter((count) => count > 1).length,
    max_same_timestamp_group_size: Math.max(0, ...sameTimestampGroups.values()),
  };
}

function pageSummary(command, collectionName) {
  const envelope = getEnvelope(command.json, collectionName);
  const messages = summarizeMessages(envelope.items);
  return {
    ok: command.ok,
    command: command.command,
    exit_code: command.exit_code,
    stderr: command.stderr,
    count: messages.length,
    has_more: envelope.has_more,
    page_token_present: Boolean(envelope.page_token),
    messages,
    order: orderAnalysis(messages),
  };
}

function findBoundaryInPage(boundary, page) {
  if (!boundary?.message_id_hash) return null;
  return page.messages.some((message) => message.message_id_hash === boundary.message_id_hash);
}

function probeSentByMe(opts, selfOpenId) {
  if (!selfOpenId) {
    return { skipped: true, reason: "self_open_id_unavailable" };
  }

  const baseArgs = [
    "im",
    "+messages-search",
    "--as",
    "user",
    "--query",
    "",
    "--sender",
    selfOpenId,
    "--start",
    opts.start,
    "--end",
    opts.end,
    "--page-size",
    String(opts.pageSize),
    "--no-reactions",
    "--format",
    "json",
  ];
  const first = runLark("sent_search_page_1", baseArgs, {
    redactedFlags: ["--sender"],
  });
  const firstPage = pageSummary(first, "messages");

  let secondPage = null;
  const firstEnvelope = getEnvelope(first.json, "messages");
  if (first.ok && firstEnvelope.has_more && firstEnvelope.page_token) {
    const second = runLark(
      "sent_search_page_2",
      [...baseArgs, "--page-token", firstEnvelope.page_token],
      { redactedFlags: ["--sender", "--page-token"] },
    );
    secondPage = pageSummary(second, "messages");
  }

  let boundary = null;
  if (firstPage.messages.length > 0) {
    boundary = firstPage.messages[firstPage.messages.length - 1];
  }

  let boundaryProbe = null;
  if (boundary?.create_time_ms) {
    const startAtBoundary = localIsoFromMs(boundary.create_time_ms);
    const boundaryCommand = runLark(
      "sent_search_start_boundary",
      [
        "im",
        "+messages-search",
        "--as",
        "user",
        "--query",
        "",
        "--sender",
        selfOpenId,
        "--start",
        startAtBoundary,
        "--end",
        opts.end,
        "--page-size",
        String(opts.pageSize),
        "--no-reactions",
        "--format",
        "json",
      ],
      { redactedFlags: ["--sender"] },
    );
    const page = pageSummary(boundaryCommand, "messages");
    boundaryProbe = {
      start: startAtBoundary,
      boundary_message_id_hash: boundary.message_id_hash,
      boundary_returned: findBoundaryInPage(boundary, page),
      page,
    };
  }

  return {
    first_page: firstPage,
    second_page: secondPage,
    start_boundary_probe: boundaryProbe,
  };
}

function probeReceivedChats(opts, selfOpenId) {
  const chatPages = [];
  const chats = [];
  const seenChatIds = new Set();
  let pageToken = "";

  for (let pageIndex = 0; pageIndex < opts.chatPages; pageIndex += 1) {
    const args = [
      "im",
      "+chat-list",
      "--as",
      "user",
      "--exclude-muted",
      "--types",
      opts.chatTypes,
      "--sort",
      "active_time",
      "--page-size",
      String(opts.chatPageSize),
      "--format",
      "json",
    ];
    if (pageToken) args.push("--page-token", pageToken);

    const command = runLark(`non_muted_chat_list_page_${pageIndex + 1}`, args, {
      redactedFlags: ["--page-token"],
    });
    const envelope = getEnvelope(command.json, "chats");
    const pageChats = envelope.items
      .filter((chat) => chat?.chat_id)
      .map((chat) => ({
        chat_id: chat.chat_id,
        chat_id_hash: hashId(chat.chat_id),
        chat_mode: chat.chat_mode || null,
      }));
    chatPages.push({
      ok: command.ok,
      command: command.command,
      exit_code: command.exit_code,
      stderr: command.stderr,
      count: pageChats.length,
      has_more: envelope.has_more,
      page_token_present: Boolean(envelope.page_token),
      chats: pageChats.map(({ chat_id_hash, chat_mode }) => ({ chat_id_hash, chat_mode })),
    });

    for (const chat of pageChats) {
      if (seenChatIds.has(chat.chat_id)) continue;
      seenChatIds.add(chat.chat_id);
      chats.push({
        index: chats.length,
        ...chat,
      });
      if (chats.length >= opts.chatLimit) break;
    }

    if (!command.ok || chats.length >= opts.chatLimit || !envelope.has_more || !envelope.page_token) {
      break;
    }
    pageToken = envelope.page_token;
  }

  const chatResults = [];
  for (const chat of chats) {
    const baseArgs = [
      "im",
      "+chat-messages-list",
      "--as",
      "user",
      "--chat-id",
      chat.chat_id,
      "--start",
      opts.start,
      "--end",
      opts.end,
      "--order",
      "asc",
      "--page-size",
      String(opts.pageSize),
      "--no-reactions",
      "--format",
      "json",
    ];
    const first = runLark(`chat_${chat.index}_messages_page_1`, baseArgs, {
      redactedFlags: ["--chat-id"],
    });
    const firstPage = pageSummary(first, "messages");
    const filteredFirstPage = selfOpenId
      ? {
          ...firstPage,
          messages: firstPage.messages.filter((message) => message.sender_id_hash !== hashId(selfOpenId)),
        }
      : firstPage;

    let secondPage = null;
    const firstEnvelope = getEnvelope(first.json, "messages");
    if (first.ok && firstEnvelope.has_more && firstEnvelope.page_token) {
      const second = runLark(
        `chat_${chat.index}_messages_page_2`,
        [...baseArgs, "--page-token", firstEnvelope.page_token],
        { redactedFlags: ["--chat-id", "--page-token"] },
      );
      secondPage = pageSummary(second, "messages");
    }

    let boundary = null;
    if (firstPage.messages.length > 0) {
      boundary = firstPage.messages[firstPage.messages.length - 1];
    }

    let boundaryProbe = null;
    if (boundary?.create_time_ms) {
      const startAtBoundary = localIsoFromMs(boundary.create_time_ms);
      const boundaryCommand = runLark(
        `chat_${chat.index}_messages_start_boundary`,
        [
          "im",
          "+chat-messages-list",
          "--as",
          "user",
          "--chat-id",
          chat.chat_id,
          "--start",
          startAtBoundary,
          "--end",
          opts.end,
          "--order",
          "asc",
          "--page-size",
          String(opts.pageSize),
          "--no-reactions",
          "--format",
          "json",
        ],
        { redactedFlags: ["--chat-id"] },
      );
      const page = pageSummary(boundaryCommand, "messages");
      boundaryProbe = {
        start: startAtBoundary,
        boundary_message_id_hash: boundary.message_id_hash,
        boundary_returned: findBoundaryInPage(boundary, page),
        page,
      };
    }

    chatResults.push({
      chat_id_hash: chat.chat_id_hash,
      chat_mode: chat.chat_mode,
      first_page: firstPage,
      first_page_received_only: filteredFirstPage,
      second_page: secondPage,
      start_boundary_probe: boundaryProbe,
    });
  }

  return {
    chat_list: {
      ok: chatPages.every((page) => page.ok),
      count: chats.length,
      pages_scanned: chatPages.length,
      stopped_with_has_more: chatPages.at(-1)?.has_more === true && chats.length < opts.chatLimit,
      pages: chatPages,
      chats: chats.map(({ chat_id_hash, chat_mode }) => ({ chat_id_hash, chat_mode })),
    },
    chats: chatResults,
  };
}

function buildConclusions(report) {
  const sent = report.probes.sent_by_me;
  const receivedChats = report.probes.received_from_unmuted_chats?.chats || [];

  const orderedChatSamples = receivedChats.filter(
    (chat) => chat.first_page.ok && chat.first_page.count > 1,
  );
  const chatOrderingKnown =
    orderedChatSamples.length > 0
      ? orderedChatSamples.every((chat) => chat.first_page.order.monotonic_create_time_asc)
      : null;
  const chatBoundaryReturned = receivedChats
    .map((chat) => chat.start_boundary_probe?.boundary_returned)
    .filter((value) => value !== null && value !== undefined);

  return {
    sent_search_ordered_by_create_time_asc:
      sent?.first_page?.count > 1 ? sent.first_page.order.monotonic_create_time_asc : null,
    sent_search_start_time_appears_inclusive:
      sent?.start_boundary_probe?.boundary_returned ?? null,
    chat_messages_ordered_by_create_time_asc: chatOrderingKnown,
    chat_messages_start_time_appears_inclusive:
      chatBoundaryReturned.length > 0 ? chatBoundaryReturned.every(Boolean) : null,
    cursor_design_hints: {
      sent_by_me:
        "Do not treat messages-search response order as cursor order unless the probe proves it. Read a bounded time window to completion, sort locally, then advance.",
      received_per_chat:
        "Use per-chat scopes with chat-messages-list --order asc. If start is inclusive, query from cursor timestamp and locally filter records strictly greater than {created_at_ms, message_id}.",
      all_scopes: "Idempotent writes and atomic cursor commits remain mandatory.",
    },
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const self = runLark("self", ["contact", "+get-user", "--as", "user", "--format", "json"]);
  const selfOpenId = getSelfOpenId(self.json);

  const report = {
    generated_at: new Date().toISOString(),
    probe_window: {
      start: opts.start,
      end: opts.end,
    },
    options: {
      page_size: opts.pageSize,
      chat_limit: opts.chatLimit,
      chat_page_size: opts.chatPageSize,
      chat_pages: opts.chatPages,
      chat_types: opts.chatTypes,
    },
    commands: {
      self: {
        ok: self.ok,
        command: self.command,
        exit_code: self.exit_code,
        stderr: self.stderr,
        open_id_present: Boolean(selfOpenId),
        open_id_hash: hashId(selfOpenId),
      },
    },
    probes: {
      sent_by_me: probeSentByMe(opts, selfOpenId),
      received_from_unmuted_chats: probeReceivedChats(opts, selfOpenId),
    },
  };
  report.conclusions = buildConclusions(report);

  const outputPath =
    opts.out ||
    resolve(
      "reports/lark-capabilities",
      `lark-im-cursor-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        report_path: outputPath,
        conclusions: report.conclusions,
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
