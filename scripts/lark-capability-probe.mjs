#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_EVENT_TIMEOUT = "1s";
const DEFAULT_PAGE_SIZE = "5";
const READ_LIKE = /read|unread|last|cursor|badge/i;

function usage() {
  return `Usage: node scripts/lark-capability-probe.mjs [options]

Options:
  --start <iso>          Probe window start. Default: today 00:00 local time.
  --end <iso>            Probe window end. Default: today 23:59 local time.
  --out <path>           Write JSON report to this path.
  --event-timeout <dur>  Event consume timeout. Default: ${DEFAULT_EVENT_TIMEOUT}.
  --page-size <n>        Low-privacy field probe page size. Default: ${DEFAULT_PAGE_SIZE}.
  --no-live              Skip live user data probes; keep schema, dry-run, and event validation.
  --help                 Show this help.

The probe is intentionally low-privacy: it records field names, counts, auth
types, endpoints, and command statuses. It does not persist message content,
chat names, or contact names.
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

function parseArgs(argv) {
  const now = new Date();
  const day = localDay(now);
  const offset = localOffset(now);
  const opts = {
    start: `${day}T00:00:00${offset}`,
    end: `${day}T23:59:59${offset}`,
    eventTimeout: DEFAULT_EVENT_TIMEOUT,
    pageSize: DEFAULT_PAGE_SIZE,
    live: true,
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--no-live") {
      opts.live = false;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--start") opts.start = next;
    else if (arg === "--end") opts.end = next;
    else if (arg === "--out") opts.out = next;
    else if (arg === "--event-timeout") opts.eventTimeout = next;
    else if (arg === "--page-size") opts.pageSize = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  return opts;
}

function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return {
      _parse_error: error.message,
      _stdout_excerpt: trimmed.slice(0, 500),
    };
  }
}

function commandLabel(cmd, args, redactions = []) {
  const parts = [cmd, ...args];
  for (const redaction of redactions) {
    const index = parts.indexOf(redaction.flag);
    if (index >= 0 && index + 1 < parts.length) {
      parts[index + 1] = redaction.value;
    }
  }
  return parts.join(" ");
}

function runCommand(id, cmd, args, options = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const finishedAt = new Date().toISOString();
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const record = {
    id,
    command: commandLabel(cmd, args, options.redactions || []),
    exit_code: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    ok: result.status === 0,
    started_at: startedAt,
    finished_at: finishedAt,
    stderr: stderr.trim().slice(0, 2000),
  };
  if (options.parseJson) {
    record.json = parseJson(stdout);
  } else if (options.keepStdout) {
    record.stdout = stdout.trim().slice(0, 2000);
  } else if (stdout.trim()) {
    record.stdout_present = true;
  }
  return record;
}

function runLark(id, args, options = {}) {
  const bin = process.env.LARK_CLI || "lark-cli";
  return runCommand(id, bin, args, options);
}

function topLevelKeys(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.length > 0 ? topLevelKeys(value[0]) : [];
  if (typeof value === "object") return Object.keys(value).sort();
  return [];
}

function readLikeKeys(keys) {
  return keys.filter((key) => READ_LIKE.test(key)).sort();
}

function schemaSummary(schema) {
  if (!schema || typeof schema !== "object") return null;
  const props = schema.resolved_output_schema?.properties || {};
  const eventProps = props.event?.properties || null;
  return {
    key: schema.key,
    description: schema.description,
    auth_types: schema.auth_types || [],
    scopes: schema.scopes || [],
    required_console_events: schema.required_console_events || [],
    jq_root_path: schema.jq_root_path || null,
    output_property_keys: Object.keys(eventProps || props).sort(),
  };
}

function safeCount(json, path) {
  let current = json;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = current[key];
  }
  return Array.isArray(current) ? current.length : null;
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

function buildConclusions(commands, observations) {
  const receiveSchema = observations.event_schemas?.receive;
  const readSchema = observations.event_schemas?.message_read;
  const readUsersSchema = observations.read_users_schema;
  const receiveAuth = receiveSchema?.auth_types || [];
  const readAuth = readSchema?.auth_types || [];
  const readUsersTokens =
    readUsersSchema?.access_tokens || readUsersSchema?._meta?.access_tokens || [];

  const chatKeys = observations.field_probes?.chat_list?.first_keys || [];
  const feedKeys = observations.field_probes?.feed_shortcuts?.first_keys || [];
  const messageKeys = observations.field_probes?.messages_search?.first_keys || [];
  const allReadLikeKeys = {
    chat_list: readLikeKeys(chatKeys),
    feed_shortcuts: readLikeKeys(feedKeys),
    messages_search: readLikeKeys(messageKeys),
  };

  return {
    realtime_sync: {
      event_receive_auth_types: receiveAuth,
      event_receive_user_supported: commands.event_receive_user?.ok === true,
      event_receive_bot_probe_ok: commands.event_receive_bot?.ok === true,
      can_replace_user_polling:
        receiveAuth.includes("user") && commands.event_receive_user?.ok === true,
      recommendation:
        receiveAuth.includes("user")
          ? "Event receive may be a primary user-scope sync path; verify coverage and checkpoint/replay semantics before dropping polling."
          : "Keep user-scope query polling as the source of truth. The current receive event is not a user-scope all-chat event.",
    },
    authored_by_me: {
      self_open_id_available: Boolean(observations.self?.open_id_present),
      sender_filter_probe_ok: commands.messages_search_by_self?.ok === true,
      likely_path:
        observations.self?.open_id_present && commands.messages_search_by_self?.ok
          ? "contact +get-user -> im +messages-search --sender <self_open_id>"
          : "Not proven by this probe. Check missing scopes or contact self shape.",
    },
    read_state: {
      current_phase_model: "not used; Exocortex stores sent and received, not read",
      message_read_event_auth_types: readAuth,
      message_read_event_description: readSchema?.description || "",
      read_users_access_tokens: readUsersTokens,
      first_class_me_read_stream_proven: false,
      response_read_like_keys: allReadLikeKeys,
      low_privacy_probe_found_direct_read_fields: Object.values(allReadLikeKeys).some(
        (keys) => keys.length > 0,
      ),
      proxy_candidates: [
        {
          name: "non_muted_visible_chat",
          status: commands.chat_list_exclude_muted?.ok ? "probe_ok" : "not_proven",
          meaning:
            "Use non-muted chats as the source filter for received messages; do not call this read.",
        },
      ],
    },
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const commands = {};
  const observations = {
    probe_window: {
      start: opts.start,
      end: opts.end,
    },
  };

  commands.lark_version = runLark("lark_version", ["--version"], {
    keepStdout: true,
  });
  commands.doctor = runLark("doctor", ["doctor"], { parseJson: true });

  commands.event_list = runLark("event_list", ["event", "list", "--json"], {
    parseJson: true,
  });
  const eventList = Array.isArray(commands.event_list.json)
    ? commands.event_list.json
    : [];
  observations.im_events = eventList
    .filter((event) => typeof event.key === "string" && event.key.startsWith("im."))
    .map((event) => ({
      key: event.key,
      description: event.description,
      auth_types: event.auth_types || [],
      scopes: event.scopes || [],
      required_console_events: event.required_console_events || [],
    }));

  commands.event_schema_receive = runLark(
    "event_schema_receive",
    ["event", "schema", "im.message.receive_v1", "--json"],
    { parseJson: true },
  );
  commands.event_schema_message_read = runLark(
    "event_schema_message_read",
    ["event", "schema", "im.message.message_read_v1", "--json"],
    { parseJson: true },
  );
  observations.event_schemas = {
    receive: schemaSummary(commands.event_schema_receive.json),
    message_read: schemaSummary(commands.event_schema_message_read.json),
  };

  const safeEventJq =
    "{type,chat_type,message_type,has_message_id:(.message_id!=null),has_content:(.content!=null)}";
  commands.event_receive_user = runLark(
    "event_receive_user",
    [
      "event",
      "consume",
      "im.message.receive_v1",
      "--as",
      "user",
      "--timeout",
      opts.eventTimeout,
      "--max-events",
      "1",
      "--quiet",
      "--jq",
      safeEventJq,
    ],
    { parseJson: true },
  );
  commands.event_receive_bot = runLark(
    "event_receive_bot",
    [
      "event",
      "consume",
      "im.message.receive_v1",
      "--as",
      "bot",
      "--timeout",
      opts.eventTimeout,
      "--max-events",
      "1",
      "--quiet",
      "--jq",
      safeEventJq,
    ],
    { parseJson: true },
  );

  commands.read_users_schema = runLark(
    "read_users_schema",
    ["schema", "im.messages.read_users", "--format", "json"],
    { parseJson: true },
  );
  observations.read_users_schema = {
    description: commands.read_users_schema.json?.description || "",
    access_tokens: commands.read_users_schema.json?._meta?.access_tokens || [],
    scopes: commands.read_users_schema.json?._meta?.scopes || [],
    output_keys: topLevelKeys(commands.read_users_schema.json?.outputSchema?.properties),
  };

  commands.read_users_user_dry_run = runLark(
    "read_users_user_dry_run",
    [
      "im",
      "messages",
      "read_users",
      "--as",
      "user",
      "--dry-run",
      "--params",
      '{"message_id":"om_probe","user_id_type":"open_id"}',
    ],
    { parseJson: true },
  );
  commands.read_users_bot_dry_run = runLark(
    "read_users_bot_dry_run",
    [
      "im",
      "messages",
      "read_users",
      "--as",
      "bot",
      "--dry-run",
      "--params",
      '{"message_id":"om_probe","user_id_type":"open_id"}',
    ],
    { parseJson: true },
  );

  commands.messages_search_dry_run = runLark(
    "messages_search_dry_run",
    [
      "im",
      "+messages-search",
      "--as",
      "user",
      "--dry-run",
      "--start",
      opts.start,
      "--end",
      opts.end,
      "--page-size",
      "1",
    ],
    { parseJson: true },
  );
  commands.chat_list_dry_run = runLark(
    "chat_list_dry_run",
    [
      "im",
      "+chat-list",
      "--as",
      "user",
      "--types",
      "p2p,group",
      "--sort",
      "active_time",
      "--page-size",
      "1",
      "--dry-run",
    ],
    { parseJson: true },
  );

  observations.field_probes = {};
  if (opts.live) {
    commands.self_user = runLark(
      "self_user",
      [
        "contact",
        "+get-user",
        "--as",
        "user",
        "-q",
        "{open_id:(.data.user.open_id // .data.open_id // .user.open_id // .open_id // null), keys:(.data.user // .data // .user // . | keys)}",
      ],
      { parseJson: true },
    );
    const selfOpenId = getSelfOpenId(commands.self_user.json);
    observations.self = {
      open_id_present: Boolean(selfOpenId),
      open_id_prefix: selfOpenId ? `${selfOpenId.slice(0, 6)}...` : "",
      keys: commands.self_user.json?.keys || [],
    };

    commands.chat_list_fields = runLark(
      "chat_list_fields",
      [
        "im",
        "+chat-list",
        "--as",
        "user",
        "--types",
        "p2p,group",
        "--sort",
        "active_time",
        "--page-size",
        "1",
        "-q",
        "{count:(.data.chats|length), first_keys:(.data.chats[0] | keys // [])}",
      ],
      { parseJson: true },
    );
    observations.field_probes.chat_list = commands.chat_list_fields.json || null;

    commands.chat_list_exclude_muted = runLark(
      "chat_list_exclude_muted",
      [
        "im",
        "+chat-list",
        "--as",
        "user",
        "--types",
        "p2p,group",
        "--sort",
        "active_time",
        "--page-size",
        opts.pageSize,
        "--exclude-muted",
        "-q",
        "{count:(.data.chats|length), filter:(.data.filter // null), first_keys:(.data.chats[0] | keys // [])}",
      ],
      { parseJson: true },
    );
    observations.field_probes.chat_list_exclude_muted =
      commands.chat_list_exclude_muted.json || null;

    commands.feed_shortcut_fields = runLark(
      "feed_shortcut_fields",
      [
        "im",
        "+feed-shortcut-list",
        "--as",
        "user",
        "--no-detail",
        "-q",
        "{count:(.data.shortcuts|length), first_keys:(.data.shortcuts[0] | keys // [])}",
      ],
      { parseJson: true },
    );
    observations.field_probes.feed_shortcuts =
      commands.feed_shortcut_fields.json || null;

    commands.messages_search_fields = runLark(
      "messages_search_fields",
      [
        "im",
        "+messages-search",
        "--as",
        "user",
        "--start",
        opts.start,
        "--end",
        opts.end,
        "--page-size",
        "1",
        "--no-reactions",
        "-q",
        "{count:(.data.messages|length), first_keys:(.data.messages[0] | keys // []), sender_keys:(.data.messages[0].sender | keys // [])}",
      ],
      { parseJson: true },
    );
    observations.field_probes.messages_search =
      commands.messages_search_fields.json || null;

    if (selfOpenId) {
      commands.messages_search_by_self = runLark(
        "messages_search_by_self",
        [
          "im",
          "+messages-search",
          "--as",
          "user",
          "--sender",
          selfOpenId,
          "--start",
          opts.start,
          "--end",
          opts.end,
          "--page-size",
          "1",
          "--no-reactions",
          "-q",
          "{count:(.data.messages|length), first_keys:(.data.messages[0] | keys // []), sender_keys:(.data.messages[0].sender | keys // [])}",
        ],
        {
          parseJson: true,
          redactions: [{ flag: "--sender", value: "<self_open_id>" }],
        },
      );
      observations.field_probes.messages_search_by_self =
        commands.messages_search_by_self.json || null;
    }

    observations.live_counts = {
      chat_list_count: commands.chat_list_fields.json?.count ?? null,
      feed_shortcut_count: commands.feed_shortcut_fields.json?.count ?? null,
      messages_search_count: commands.messages_search_fields.json?.count ?? null,
      messages_search_by_self_count:
        commands.messages_search_by_self?.json?.count ?? null,
    };
  } else {
    observations.self = { open_id_present: false, skipped: "--no-live" };
  }

  const report = {
    generated_at: new Date().toISOString(),
    lark_cli_bin: process.env.LARK_CLI || "lark-cli",
    privacy_mode: "low",
    options: opts,
    observations,
    conclusions: buildConclusions(commands, observations),
    commands,
  };

  const defaultOut = `reports/lark-capabilities/lark-capability-probe-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  const outPath = resolve(opts.out || defaultOut);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`Wrote ${outPath}\n`);
  process.stdout.write(`${JSON.stringify(report.conclusions, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
