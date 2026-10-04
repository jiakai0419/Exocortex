#!/usr/bin/env node

import { createProbeRunner, boundedInteger, validateProbeWindow, writeProbeReport, probeVersion } from "../../src/development/probe-support.mjs";
const runLark = createProbeRunner();

const DEFAULT_EVENT_TIMEOUT = "1s";
const DEFAULT_PAGE_SIZE = "5";
const READ_LIKE = /read|unread|last|cursor|badge/i;

function usage() {
  return `Usage: node tools/probes/capabilities.mjs [options]
  --mode metadata|sample|events  Default: metadata (no event commands or samples).
  --start <zoned-iso> --end <zoned-iso>  Required for sample; at most 24 hours.
  --page-size <1..20>           Default: 5. Samples never auto-page.
  --event-timeout <1s..5s>      Default: 1s. Events mode only; two sessions, one event each.
  --output <path>              Create a private detailed report; absent means no file.
  --help                      Show this help.
Every CLI call has a 10-second timeout, 20 MiB output limit and no retries.
Default stdout contains only safe counts and status; detailed reports are private.
`;
}

function parseArgs(argv) {
  const opts = { mode: "metadata", start: "2030-01-01T00:00:00Z", end: "2030-01-01T01:00:00Z",
    eventTimeout: DEFAULT_EVENT_TIMEOUT, pageSize: DEFAULT_PAGE_SIZE, out: "", live: false };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]; const value = argv[++i];
    if (seen.has(flag) || !value || value.startsWith("--")) throw new Error("Invalid probe arguments");
    seen.add(flag);
    if (flag === "--mode") opts.mode = value;
    else if (flag === "--start") opts.start = value;
    else if (flag === "--end") opts.end = value;
    else if (flag === "--page-size") opts.pageSize = String(boundedInteger(value, 20, "page size"));
    else if (flag === "--event-timeout") opts.eventTimeout = value;
    else if (flag === "--output") opts.out = value;
    else throw new Error("Unknown probe option");
  }
  if (!["metadata", "sample", "events"].includes(opts.mode)) throw new Error("Invalid probe mode");
  if (!/^[1-5]s$/.test(opts.eventTimeout)) throw new Error("Invalid event timeout");
  if (seen.has("--event-timeout") && opts.mode !== "events") throw new Error("Event timeout requires events mode");
  if (opts.mode === "sample" && (!seen.has("--start") || !seen.has("--end"))) throw new Error("Sample requires an explicit window");
  validateProbeWindow(opts.start, opts.end);
  opts.live = opts.mode === "sample";
  return opts;
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

  if (opts.mode === "events") {
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

  }

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
    observations.self = { open_id_present: false, skipped: opts.mode };
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

  const reportWritten = writeProbeReport(opts.out, report);
  const records = Object.values(commands);
  const failed = records.filter((command) => !command.ok).length;
  process.stdout.write(`${JSON.stringify({ schema_version: 1, mode: opts.mode,
    api_family: "lark-cli-capabilities", api_version: probeVersion(commands.lark_version),
    commands: records.length, failed, ok: failed === 0, report_written: reportWritten })}\n`);
  process.exitCode = failed ? 2 : 0;
}

try {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) process.stdout.write(usage());
  else main();
} catch (error) {
  process.stderr.write("Capability probe failed; verify arguments and output destination.\n");
  process.exit(1);
}
