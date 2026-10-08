// This dependency graph must remain usable without dist, SQLite or credentials.
import { WORKER_DEFAULTS, WORKER_OPTION_SPECS } from "../runtime/worker/options.mjs";
import { SYNC_OPTION_SPECS } from "../adapters/lark-im/sync-options.mjs";
import { CliUsageError, createCommandContext } from "./context.mjs";
import { parseOptions } from "./parse-options.mjs";
import { terminalColumns, wrapLabelValue, wrapTextLine } from "../terminal/text-layout.mjs";
export { parseOptions } from "./parse-options.mjs";

const option = (flag, key, type, description, extra = {}) => ({ flag, key, type, description, ...extra });
const db = option("--db", "db", "path", "Database; default relative to installation root, explicit relative paths to cwd.", { default: WORKER_DEFAULTS.db });
const format = option("--format", "format", "enum", "Output format.", { default: "text", choices: ["text", "json"] });
const apply = option("--apply", "apply", "boolean", "Commit the planned change; otherwise preview.", { default: false });
const backupDir = option("--backup-dir", "backupDir", "path", "Private backup directory.", { default: "backups/private" });
const logDir = option("--log-dir", "logDir", "path", "Worker log directory.", { default: WORKER_DEFAULTS.logDir });
const bool = (flag, key, description) => option(flag, key, "boolean", description, { default: false });
const positive = (flag, key, value, description) => option(flag, key, "integer", description, { default: value, min: 1 });
const text = (flag, key, description, extra = {}) => option(flag, key, "string", description, extra);
const maintenanceBudget = [
  { ...positive("--max-cli-attempts", "maxCliAttempts", 12, "Hard command-wide lark-cli process-attempt cap, including pages and fallbacks; not an HTTP request count."), max: 1000 },
  { ...positive("--max-seconds", "maxSeconds", 30, "Command-wide remote-work deadline; stops without committing a budget-interrupted lookup."), max: 180 },
];
const maintenanceReview = [
  option('--review-out', 'reviewOut', 'path', 'Publish a private exact-target review file; dry-run only, with explicit request budgets.'),
  option('--review-in', 'reviewIn', 'path', 'Require this private review file for exact-target --apply; refetch and reject any drift.'),
  text('--review-sha256', 'reviewSha256', 'SHA-256 of the exact reviewed file bytes, including its final newline; required with --review-in.'),
];
const route = (id, summary, options, effects, privacy = "public-safe", modes = []) => ({
  id, path: id.split("."), group: id.split(".")[0], summary, options, effects, privacy, modes,
  example: `node bin/exocortex.mjs ${id.replaceAll(".", " ")}`,
});

export const GROUPS = Object.freeze([
  { id: "messages", summary: "Read private local messages." },
  { id: "status", summary: "Observe local service and sync state." },
  { id: "check", summary: "Verify local and explicitly requested evidence." },
  { id: "sync", summary: "Run one explicit synchronization pass." },
  { id: "service", summary: "Install and control the background service." },
  { id: "maintenance", summary: "Initialize, back up, preview and apply maintenance." },
]);

export const COMMANDS = Object.freeze([
  route("messages", "Read local messages newest message time first, including original private JSON. Cards are captured API snapshots and may differ from the current client state. JSON retains card rendering status and diagnostics.", [db, format,
    option("--direction", "direction", "enum", "Message direction.", { choices: ["all", "sent", "received"], default: "all" }),
    positive("--limit", "limit", 30, "Maximum messages."), text("--search", "search", "Search stored body with SQLite LIKE: % matches any sequence; _ matches one character. Input is wrapped in %; backslash is literal.", { default: "" }),
  ], ["local-read"], "private"),
  route("status", "Observe service, health, activity and freshness without live requests.", [db, format, logDir,
    bool("--detail", "detail", "Include safe sync progress details."),
    bool("--logs", "logs", "Include a private bounded tail of existing logs."),
    positive("--lines", "lines", 20, "Log tail length; requires --logs."),
  ], ["local-read"], "public-safe", [{ when: "--logs", privacy: "private" }]),
  route("check", "Collect database, sync and quality evidence and requested extensions.", [db, format,
    { ...logDir, description: "Worker log directory; requires --wait or --live --write-live-cache." }, backupDir,
    bool("--live", "live", "Read a bounded remote sample."),
    bool("--write-live-cache", "writeLiveCache", "Write the safe sample cache; requires --live."),
    bool("--unsafe-details", "unsafeDetails", "Include private sample details; requires --live."),
    positive("--chat-pages", "chatPages", 5, "Legacy compatibility bound; live sampling uses local discovered chats."),
    positive("--hot-chats", "hotChats", 5, "Maximum sampled chats, capped at five; requires --live."),
    { ...positive("--messages-per-chat", "messagesPerChat", 20, "Messages per page, capped at twenty and two pages per chat; requires --live."), max: 50 },
    text("--start", "start", "Sample start with timezone; requires --live."),
    text("--end", "end", "Sample end with timezone; requires --live."),
    text("--through", "through", "Verify coverage to this fixed timezone timestamp."),
    option("--backup", "backup", "path", "Independently verify this existing backup."),
    bool("--latest-backup", "latestBackup", "Verify the latest matching v2 backup."),
    bool("--wait", "wait", "Wait for a new complete worker cycle; no service changes."),
    positive("--timeout-seconds", "timeoutSeconds", 180, "Wait deadline; requires --wait."),
    positive("--poll-seconds", "pollSeconds", 5, "Local polling interval; requires --wait."),
  ], ["local-read"], "public-safe", [
    { when: "--live", effects: ["remote-read"] },
    { when: "--live --write-live-cache", effects: ["cache-write"] },
    { when: "--live --unsafe-details", privacy: "private" },
  ]),
  route("sync", "Run one bounded pass, preserving message and detail-debt contracts.", [
    ...SYNC_OPTION_SPECS, { ...format, default: "json", choices: ["json"], description: "Private single-pass JSON summary, including database path and possible business error details." },
  ], ["remote-read", "database-write", "activity-write"], "private"),
  ...["install", "start", "stop", "restart", "uninstall"].map((action) => route(`service.${action}`,
    ({ install: "Validate local runtime dependencies and install configuration without starting the worker.", start: "Ensure the configured service is running.",
      stop: "Stop the configured service.", restart: "Explicitly replace the running service instance.",
      uninstall: "Stop and remove the installed service configuration." })[action],
    action === "install" ? [...WORKER_OPTION_SPECS, format] : [format],
    action === "install" ? ["configuration-write"] : ["service-lifecycle"])),
  route("maintenance.init", "Initialize schema with its independent initialization lock.", [db, format], ["database-write", "permissions-write"]),
  route("maintenance.backup", "Create and verify a private backup before publishing it.", [db, format, backupDir,
    positive("--backup-keep-count", "backupKeepCount", 7, "Same-source backup count to retain."),
    positive("--backup-keep-days", "backupKeepDays", 30, "Same-source backup retention days."),
  ], ["backup-write", "same-source-backup-cleanup"]),
  route("maintenance.enrich", "Preview enrichment of one target; apply commits through its own CAS.", [db, format, apply,
    option("--target", "target", "enum", "Explicit enrichment target.", { choices: ["records", "scopes"], required: true }),
    option("--limit", "limit", "integer", "Records: 1000; scopes: 50; sender-only: 50 (maximum 100).", { min: 1 }),
    bool("--probe-apps", "probeApps", "Force application-name probes; records only."),
    bool("--unsafe-details", "unsafeDetails", "Include private lookup details; records only."),
    bool("--sender-only", "senderOnly", "Bounded lookup of one exact sender; requires --sender-id."),
    text("--sender-id", "senderId", "Exact sender for --sender-only."),
    option("--record-id", "recordIds", "integer", "One to 100 distinct stored record IDs; repeat this flag; requires --names-only and excludes --limit.", { repeat: true, min: 1 }),
    bool("--names-only", "namesOnly", "Fill missing sender names only for exact --record-id targets; excludes --sender-only and --probe-apps."),
    ...maintenanceBudget,
    ...maintenanceReview,
  ], ["local-read", "remote-read"], "public-safe", [
    { when: "--apply", effects: ["database-write"] }, { when: "--unsafe-details", privacy: "private" },
    { when: '--review-out', effects: ['private-review-file-write'] },
  ]),
  route("maintenance.repair", "Preview structural recovery; apply uses existing fences.", [db, format, apply], ["local-read"], "public-safe", [{ when: "--apply", effects: ["database-write"] }]),
  route("maintenance.replay", "Preview replay of explicit scopes and a fixed interval.", [
    { ...db, default: undefined, required: true }, format, apply,
    text("--scope-id", "scopeIds", "One to three distinct stored scopes; repeat this flag.", { repeat: true, required: true }),
    text("--start", "start", "Explicit replay start with timezone.", { required: true }),
    text("--end", "end", "Explicit replay end with timezone.", { required: true }),
    text("--message-id", "messageIds", "One to 100 distinct existing messages; repeat this flag; exact mode requires one scope.", { repeat: true }),
    ...maintenanceBudget,
    ...maintenanceReview,
  ], ["local-read", "remote-read"], "public-safe", [{ when: "--apply", effects: ["database-write"] }, { when: '--review-out', effects: ['private-review-file-write'] }]),
  route("maintenance.prune-runs", "Preview run-history retention; applying can remove coverage evidence.", [db, format, apply], ["local-read"], "public-safe", [{ when: "--apply", effects: ["database-write"] }]),
  route("maintenance.compact", "Preview database compaction; --apply permits the write.", [db, format, apply], ["local-read"], "public-safe", [{ when: "--apply", effects: ["database-write"] }]),
]);

export function parseRouteOptions(routeId, argv, { context = createCommandContext() } = {}) {
  const definition = COMMANDS.find((entry) => entry.id === routeId);
  if (!definition) throw new CliUsageError("Unknown command route");
  const parsed = parseOptions(argv, definition.options, { context, allowAll: argv.includes("--help") || argv.includes("-h") });
  if (definition.path.length > 1) parsed.options.action = definition.path[1];
  return parsed;
}

export function parseInvocation(argv, { context = createCommandContext() } = {}) {
  const prefix = [];
  let index = 0;
  while (index < argv.length && !argv[index].startsWith("-")) prefix.push(argv[index++]);
  const routeId = prefix.join(".");
  const definition = COMMANDS.find((entry) => entry.path.length === prefix.length && entry.path.every((part, position) => part === prefix[position]));
  if (definition) return { route: routeId, definition, ...parseRouteOptions(routeId, argv.slice(index), { context }) };
  if (!prefix.length || prefix.length === 1 && GROUPS.some((group) => group.id === prefix[0])) {
    const parsed = parseOptions(argv.slice(index), [format], { context, allowAll: true });
    return { route: routeId, definition: null, ...parsed, help: true };
  }
  throw new CliUsageError("Unknown command; use --help to see supported routes");
}

export function commandCatalog({ route: routeId = "", all = true } = {}) {
  const commands = COMMANDS.filter((entry) => !routeId || entry.id === routeId || entry.group === routeId);
  return {
    schema_version: 1, executable: "node bin/exocortex.mjs", route_count: COMMANDS.length,
    groups: GROUPS.filter((group) => !routeId || commands.some((entry) => entry.group === group.id)),
    commands: commands.map((entry) => ({ ...entry, options: all ? entry.options : entry.options.map(({ flag, key, type }) => ({ flag, key, type })) })),
  };
}

/** @param {{route?:string, options?:Record<string,any>, all?:boolean}} [input]
 * @param {{columns?: number, stream?: {columns?: number}}} [layout] */
export function renderHelp({ route: routeId = "", options = { format: "text" }, all = false } = {}, layout = {}) {
  const catalog = commandCatalog({ route: routeId, all });
  if (options.format === "json") return `${JSON.stringify(catalog, null, 2)}\n`;
  const lines = [routeId ? `Usage: node bin/exocortex.mjs ${routeId.replaceAll(".", " ")} [options]` : "Exocortex", ""];
  if (!routeId && !all) {
    lines.push("  messages       Read local messages (private)", "  status         Observe local state (read-only)", "  --help         Show help", "",
      "  check --help", "  sync --help", "  service --help", "  maintenance --help", "", "Use --help --all for all routes and options.");
  } else {
    for (const entry of catalog.commands) {
      lines.push(`  ${entry.id.replaceAll(".", " ")}  ${entry.summary}`, `    Effects: ${entry.effects.join(", ")}; output: ${entry.privacy}`);
      for (const mode of entry.modes) lines.push(`    ${mode.when}: ${mode.effects?.join(", ") || mode.privacy}`);
      if (all || routeId === entry.id) for (const spec of COMMANDS.find((candidate) => candidate.id === entry.id)?.options || []) {
        const value = spec.type === "boolean" ? "" : ` <${spec.choices?.join("|") || spec.type}>`;
        const suffix = spec.default !== undefined ? ` Default: ${spec.default}.` : spec.required ? " Required." : "";
        lines.push(`    ${spec.flag}${value}  ${spec.description}${suffix}`);
      }
      lines.push("");
    }
  }
  lines.push("  --help, -h     Show help without loading command dependencies.", "  --format json  Machine-readable help.");
  const columns = terminalColumns(layout.stream, layout.columns);
  return `${lines.flatMap((line) => {
    if (!line) return [""];
    const labeled = /^( *)(\S.*?)( {2,})(\S.*)$/.exec(line);
    if (labeled) return wrapLabelValue(labeled[2], labeled[4], columns, { indent: labeled[1].length, gap: labeled[3] });
    const named = /^( *)([^:]+:) (.+)$/.exec(line);
    if (named) return wrapLabelValue(named[2], named[3], columns, { indent: named[1].length, gap: " " });
    const indent = /^ */.exec(line)?.[0] || "";
    return wrapTextLine(line.slice(indent.length), columns - indent.length).map((part) => `${indent}${part}`);
  }).join("\n")}\n`;
}
