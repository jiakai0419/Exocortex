// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fetchChatMessages, getSelfProfile } from "../adapters/lark-im/adapter.mjs";
import { chatId, chatScopeId } from "../adapters/lark-im/core.mjs";
import { prepareChatWindowRecords } from "../adapters/lark-im/sync-runner.mjs";
import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";
import {
  commitBoundedReplayRecords,
  normalizeBoundedReplayRecords,
  quoteSql,
  validateInitialSyncStartMs,
} from "../../dist/storage/sqlite/ingestion-store.js";

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{id:string,source_id:string,enabled:number,config_json:string,config:JsonObject}} ReplayScope */
/** @typedef {{db:string,scopeIds:string[],start:string,end:string,startMs:number,endMs:number,apply:boolean,help:boolean}} ReplayOptions */
/** @typedef {{fetchChatMessages?:typeof fetchChatMessages,getSelfProfile?:typeof getSelfProfile,
 * commitBoundedReplayRecords?:typeof commitBoundedReplayRecords,now?:()=>number}} ReplayDeps */

class ReplayInputError extends Error {}

function usage() {
  return `Usage: node scripts/lark-im-replay.mjs --db <path> --scope-id <id> --start <iso> --end <iso> [--apply]

Replay only 1–3 explicitly selected, previously sampled received-chat scopes.
Both times require a timezone; start must be at or after the stored baseline.
The fixed end must not be in the future. Complete pagination is required.

Options:
  --db <path>       Existing, migrated SQLite database; required.
  --scope-id <id>   Selected received-chat scope; repeat up to 3 times.
  --start <iso>     Explicit inclusive replay start; no default.
  --end <iso>       Explicit authorized target; no moving-now default.
  --dry-run        Read-only preview, including remote reads. This is the default.
  --apply          Commit records and separate repair audit entries.
  --help           Show this help.

Replay never resets cursors or writes normal sync_runs. Existing records only
update for a strictly higher numeric version; ambiguous versions are preserved.
Re-run the same command after interruption. Each complete scope commits atomically.
`;
}

/** @param {string} value @param {string} flag */
function parseReplayTime(value, flag) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) throw new ReplayInputError(`${flag} requires an ISO timestamp with an explicit timezone`);
  const [, local, fraction = "", zone, sign, hours = "0", minutes = "0"] = match;
  const parsed = Date.parse(value);
  if (Number(hours) > 23 || Number(minutes) > 59 || !Number.isSafeInteger(parsed)) {
    throw new ReplayInputError(`${flag} is invalid`);
  }
  const offset = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
  if (new Date(parsed + offset).toISOString() !== `${local}.${fraction.padEnd(3, "0")}Z`) {
    throw new ReplayInputError(`${flag} is not a valid calendar timestamp`);
  }
  try { return validateInitialSyncStartMs(parsed); }
  catch { throw new ReplayInputError(`${flag} is outside the supported millisecond range`); }
}

/** @param {string[]} argv @returns {ReplayOptions} */
function parseArgs(argv) {
  const opts = { db: "", scopeIds: /** @type {string[]} */ ([]), start: "", end: "", startMs: 0, endMs: 0, apply: false, help: false };
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...opts, help: true };
    if (arg === "--apply") { opts.apply = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (!["--db", "--scope-id", "--start", "--end"].includes(arg)) throw new ReplayInputError("unknown replay option");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new ReplayInputError(`${arg} requires a value`);
    if (arg === "--db") opts.db = value;
    else if (arg === "--scope-id") opts.scopeIds.push(value);
    else if (arg === "--start") opts.start = value;
    else opts.end = value;
  }
  if (opts.apply && dryRun) throw new ReplayInputError("use either --apply or --dry-run");
  if (!opts.db || !opts.start || !opts.end) throw new ReplayInputError("--db, --start and --end are required");
  if (opts.scopeIds.length < 1 || opts.scopeIds.length > 3 || new Set(opts.scopeIds).size !== opts.scopeIds.length) {
    throw new ReplayInputError("select 1 to 3 distinct scope IDs");
  }
  opts.startMs = parseReplayTime(opts.start, "--start");
  opts.endMs = parseReplayTime(opts.end, "--end");
  if (opts.endMs <= opts.startMs) throw new ReplayInputError("--end must be after --start");
  return opts;
}

/** @param {unknown} error */
function safeReplayError(error) {
  if (error instanceof ReplayInputError) return error.message;
  return publicDiagnosticError(error, "bounded replay failed; no partial scope commit was accepted").message;
}

/** @param {ReplayOptions} opts @param {ReplayDeps} [deps] */
function executeLarkImReplay(opts, deps = {}) {
  const dbPath = resolve(opts.db);
  if (opts.endMs > (deps.now || Date.now)()) throw new ReplayInputError("--end must not be in the future");
  const source = readOnlySqliteJson(dbPath, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", "read replay source")[0];
  if (!source || source.enabled !== 1) throw new ReplayInputError("replay source is missing or disabled");
  let baseline;
  try { baseline = validateInitialSyncStartMs(JSON.parse(source.config_json).initial_sync_start_ms); }
  catch { throw new ReplayInputError("replay requires a valid persisted initial baseline"); }
  if (opts.startMs < baseline) throw new ReplayInputError("replay start precedes the persisted initial baseline");
  const auditExists = readOnlySqliteJson(dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='bounded_replay_runs';", "read replay audit schema").length === 1;
  if (opts.apply && !auditExists) throw new ReplayInputError("replay audit schema unavailable; migrate the existing database first");
  const scopeRows = readOnlySqliteJson(dbPath,
    `SELECT id,source_id,enabled,config_json FROM sync_scopes WHERE id IN (${opts.scopeIds.map(quoteSql).join(",")});`, "read selected replay scopes");
  const scopes = opts.scopeIds.map((id) => {
    const row = scopeRows.find((scope) => scope.id === id);
    if (!row || row.source_id !== "lark.im" || row.enabled !== 1) throw new ReplayInputError("selected replay scope is missing or disabled");
    let config;
    try { config = JSON.parse(row.config_json); }
    catch { throw new ReplayInputError("selected replay scope has invalid configuration"); }
    if (!config || typeof config.chat_id !== "string" || !config.chat_id || id !== chatScopeId(config.chat_id)) {
      throw new ReplayInputError("selected replay scope has inconsistent chat identity");
    }
    if (config.unsupported_reason) throw new ReplayInputError("selected replay scope is unsupported");
    return /** @type {ReplayScope} */ ({ ...row, config });
  });
  // Existing sent records are only an identity consistency check. An actual
  // profile read supplies the self identity; names or IDs are never guessed.
  const priorSelfIds = readOnlySqliteJson(dbPath,
    "SELECT DISTINCT actor_id FROM records WHERE source_id='lark.im' AND direction='sent' AND actor_id LIKE 'ou_%' LIMIT 2;",
    "read replay identity evidence");
  const fetchOpts = { pageSize: 50, chatPageSize: 100, chatTypes: "group,p2p", maxPages: 40, retries: 2, retryDelayMs: 1000 };
  const self = (deps.getSelfProfile || getSelfProfile)(fetchOpts);
  if (!self || typeof self.open_id !== "string" || !self.open_id.startsWith("ou_")) throw new ReplayInputError("self identity could not be verified");
  if (priorSelfIds.some((row) => row.actor_id !== self.open_id)) throw new ReplayInputError("self identity conflicts with this database");
  const selfHash = createHash("sha256").update(self.open_id).digest("hex");
  const planId = createHash("sha256").update(JSON.stringify({ kind: "bounded_replay/v1", scopes: [...opts.scopeIds].sort(),
    baseline, start: opts.startMs, end: opts.endMs, self: selfHash })).digest("hex");
  const attemptId = randomUUID();
  const summary = {
    ok: true, dry_run: !opts.apply, plan_id: planId, attempt_id: attemptId,
    initial_sync_start_ms: baseline, window_start_ms: opts.startMs, window_end_ms: opts.endMs,
    selected_scopes: scopes.length, audit_schema_ready: auditExists, cursor_policy: "unchanged",
    scopes: /** @type {JsonObject[]} */ ([]),
  };
  for (const [index, scope] of scopes.entries()) {
    try {
      // The adapter returns only after every page is valid and complete.
      // Deliberately do not use normal sync's cursor window or bisection.
      const fetched = (deps.fetchChatMessages || fetchChatMessages)(scope.config.chat_id, opts.startMs, opts.endMs, fetchOpts);
      if (!Array.isArray(fetched.messages) || !Number.isSafeInteger(fetched.pages) || fetched.pages < 1 ||
          fetched.pages > fetchOpts.maxPages || fetched.messages.length > 10_000 || /** @type {JsonObject} */ (fetched).has_more === true) {
        throw new ReplayInputError("replay fetch was incomplete or exceeded the bounded limit");
      }
      if (fetched.messages.some((message) => chatId(message) && chatId(message) !== scope.config.chat_id)) {
        throw new ReplayInputError("replay response contains a different chat");
      }
      const prepared = prepareChatWindowRecords(fetched.messages, scope.id, null, opts.startMs, opts.endMs,
        self.open_id, { self }, scope.config)
        .filter((record) => record.occurred_at_ms >= opts.startMs && record.occurred_at_ms <= opts.endMs);
      const records = normalizeBoundedReplayRecords(/** @type {any} */ (prepared), "lark.im");
      const result = { index: index + 1, pages: fetched.pages, fetched: fetched.messages.length, candidates: records.length };
      if (opts.apply) {
        const effects = (deps.commitBoundedReplayRecords || commitBoundedReplayRecords)(dbPath, {
          scope: /** @type {any} */ (scope), initialSyncStartMs: baseline, startMs: opts.startMs, endMs: opts.endMs,
          planId, attemptId, selfIdHash: selfHash, pages: fetched.pages, fetchedCount: fetched.messages.length, records,
        });
        summary.scopes.push({ ...result, ...effects });
      } else {
        const existing = records.length === 0 ? 0 : readOnlySqliteJson(dbPath,
          `SELECT count(*) AS count FROM records WHERE source_id='lark.im' AND external_id IN (${records.map((record) => quoteSql(record.external_id)).join(",")});`,
          "preview replay candidates")[0].count;
        summary.scopes.push({ ...result, missing_candidates: records.length - Number(existing), existing_candidates: Number(existing) });
      }
    } catch (error) {
      summary.ok = false;
      summary.scopes.push({ index: index + 1, ok: false, error: safeReplayError(error) });
      break;
    }
  }
  return summary;
}

/** @param {string[]} argv @param {{stdout?:{write:(text:string)=>unknown},stderr?:{write:(text:string)=>unknown},deps?:ReplayDeps}} [io] */
function runLarkImReplayCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv);
    if (opts.help) { stdout.write(usage()); return 0; }
    const result = executeLarkImReplay(opts, io.deps);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`${safeReplayError(error)}\n`);
    return 1;
  }
}

export { executeLarkImReplay, parseArgs, parseReplayTime, runLarkImReplayCli, usage };
