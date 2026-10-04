#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createProbeRunner, boundedInteger, validateProbeWindow, writeProbeReport, probeVersion } from "../../src/development/probe-support.mjs";
import { nativeCursorCommand } from "../../src/development/cursor-native.mjs";
const execute = createProbeRunner();
const nativeObservations = [];
let api = "native";
function runLark(id, args, options = {}) {
  return api === "native" ? nativeCursorCommand(execute, nativeObservations, id, args, options) : execute(id, args, options);
}

const DEFAULT_PAGE_SIZE = "5";
const DEFAULT_CHAT_LIMIT = "1";
const DEFAULT_CHAT_PAGE_SIZE = "10";
const DEFAULT_CHAT_PAGES = "5";

function usage() {
  return `Usage: node tools/probes/cursors.mjs [options]

Options:
  --api native|convenience  Default: native; convenience requires an explicit comparison.
  --start <iso>          Required zoned start; window must be at most 24 hours.
  --end <iso>            Required zoned end, after start.
  --page-size <1..50>        Page size for message probes. Default: ${DEFAULT_PAGE_SIZE}.
  --chat-limit <1..5>       Non-muted chats to probe. Default: ${DEFAULT_CHAT_LIMIT}.
  --chat-page-size <1..100>   Chat-list page size. Default: ${DEFAULT_CHAT_PAGE_SIZE}.
  --chat-pages <1..5>       Max chat-list pages to scan. Default: ${DEFAULT_CHAT_PAGES}.
  --chat-types <types>   Chat types for received probe. Default: group.
  --output <path>        Create private detailed JSON; absent means no file.
  --help                 Show this help.

Default stdout is a safe summary. Private reports retain hashed IDs, timestamps,
page metadata, command statuses, ordering checks and potentially sensitive error
context. Each CLI call is limited to 10 seconds and 20 MiB, with no retries.
`;
}

function localIsoFromMs(ms) {
  return new Date(ms).toISOString();
}

function parsePositiveInt(value, name) {
  const text = String(value);
  const parsed = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const opts = {
    api: "native",
    start: "",
    end: "",
    pageSize: parsePositiveInt(DEFAULT_PAGE_SIZE, "page-size"),
    chatLimit: parsePositiveInt(DEFAULT_CHAT_LIMIT, "chat-limit"),
    chatPageSize: parsePositiveInt(DEFAULT_CHAT_PAGE_SIZE, "chat-page-size"),
    chatPages: parsePositiveInt(DEFAULT_CHAT_PAGES, "chat-pages"),
    chatTypes: "group",
    out: "",
  };

  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error("Duplicate probe option");
    seen.add(arg);
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--api") opts.api = next;
    else if (arg === "--start") opts.start = next;
    else if (arg === "--end") opts.end = next;
    else if (arg === "--page-size") opts.pageSize = boundedInteger(next, 50, "page size");
    else if (arg === "--chat-limit") opts.chatLimit = boundedInteger(next, 5, "chat limit");
    else if (arg === "--chat-page-size") opts.chatPageSize = boundedInteger(next, 100, "chat page size");
    else if (arg === "--chat-pages") opts.chatPages = boundedInteger(next, 5, "chat pages");
    else if (arg === "--chat-types") opts.chatTypes = next;
    else if (arg === "--output") opts.out = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }

  if (!["native", "convenience"].includes(opts.api)) throw new Error("Invalid API family");
  if (!/^(p2p|group)(,(p2p|group))?$/.test(opts.chatTypes)) throw new Error("Invalid chat types");
  validateProbeWindow(opts.start, opts.end);
  return opts;
}

function hashId(value) {
  if (!value) return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
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
  const id = (
    selfJson.open_id ||
    selfJson.user?.open_id ||
    selfJson.data?.open_id ||
    selfJson.data?.user?.open_id ||
    selfJson.data?.user_id?.open_id ||
    ""
  );
  return typeof id === "string" && id.length > 0 && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(id) ? id : "";
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

function boundarySkipReason(boundary, opts) {
  if (!boundary) return null;
  if (!Number.isFinite(boundary.create_time_ms)) return "invalid_boundary_time";
  if (boundary.create_time_ms < Date.parse(opts.start) || boundary.create_time_ms >= Date.parse(opts.end)) return "boundary_outside_window";
  return null;
}

function probeSentByMe(opts, selfOpenId) {
  if (!selfOpenId) {
    return { skipped: true, incomplete: true, reason: "self_open_id_unavailable" };
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

  const skipReason = boundarySkipReason(boundary, opts);
  /** @type {Record<string, any> | null} */
  let boundaryProbe = skipReason ? { skipped: true, incomplete: true, reason: skipReason } : null;
  if (boundary && !skipReason) {
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
    const receivedMessages = selfOpenId
      ? firstPage.messages.filter((message) => message.sender_id_hash !== hashId(selfOpenId))
      : firstPage.messages;
    const filteredFirstPage = {
      ...firstPage,
      count: receivedMessages.length,
      messages: receivedMessages,
      order: orderAnalysis(receivedMessages),
    };

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

    const skipReason = boundarySkipReason(boundary, opts);
    /** @type {Record<string, any> | null} */
    let boundaryProbe = skipReason ? { skipped: true, incomplete: true, reason: skipReason } : null;
    if (boundary && !skipReason) {
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
    interpretation: "These bounded observations describe this API family and CLI version only; they do not establish a production cursor or remote-completeness contract.",
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  api = opts.api;
  const version = runLark("version", ["--version"], { keepStdout: true });
  const self = runLark("self", ["contact", "+get-user", "--as", "user", "--format", "json"]);
  const selfOpenId = self.ok ? getSelfOpenId(self.json) : "";

  const report = {
    generated_at: new Date().toISOString(),
    api_family: api, api_version: api === "native" ? "im/v1" : "lark-cli-convenience",
    cli_version: version.ok ? probeVersion(version) : "unknown",
    discovery_family: "lark-cli-convenience",
    native_observations: nativeObservations,
    probe_window: {
      start: opts.start,
      end: opts.end,
    },
    options: {
      page_size: opts.pageSize,
      sent_page_size: api === "native" ? Math.min(opts.pageSize, 30) : opts.pageSize,
      chat_page_size_effective: api === "native" ? Math.min(opts.pageSize, 50) : opts.pageSize,
      chat_limit: opts.chatLimit,
      chat_page_size: opts.chatPageSize,
      chat_pages: opts.chatPages,
      chat_types: opts.chatTypes,
    },
    commands: {
      version,
      self: {
        ok: self.ok,
        command: self.command,
        exit_code: self.exit_code,
        signal: self.signal,
        execution_error: self.execution_error,
        failure_kind: self.failure_kind,
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

  const reportWritten = writeProbeReport(opts.out, report);
  const sent = report.probes.sent_by_me;
  const received = report.probes.received_from_unmuted_chats;
  const pages = [sent.first_page, sent.second_page, sent.start_boundary_probe?.page,
    ...received.chat_list.pages, ...received.chats.flatMap((chat) => [chat.first_page, chat.second_page, chat.start_boundary_probe?.page])].filter(Boolean);
  const failed = pages.filter((page) => page && !page.ok).length + (self.ok ? 0 : 1) + (version.ok ? 0 : 1);
  const incomplete = report.cli_version === "unknown" || sent.incomplete === true ||
    sent.start_boundary_probe?.incomplete === true || received.chats.some((chat) => chat.start_boundary_probe?.incomplete === true);
  process.stdout.write(`${JSON.stringify({ schema_version: 1, api_family: report.api_family,
    api_version: report.api_version, cli_version: report.cli_version, ok: failed === 0 && !incomplete,
    pages: pages.length, failed, incomplete, report_written: reportWritten })}\n`);
  process.exitCode = !version.ok ? 1 : failed || incomplete ? 2 : 0;
}

try {
  main();
} catch (error) {
  process.stderr.write("Cursor probe failed; verify arguments and output destination.\n");
  process.exit(1);
}
