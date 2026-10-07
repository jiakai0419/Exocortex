// @ts-check

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fetchChatMessages, getSelfProfile } from "../adapters/lark-im/adapter.mjs";
import { chatId, chatScopeId } from "../adapters/lark-im/core.mjs";
import { prepareChatWindowRecords } from "../adapters/lark-im/sync-runner.mjs";
import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";
import { readRemoteAccountBinding, accountBindingAdmissionError } from "../diagnostics/remote-account-binding.mjs";
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

function validateReplayOptions(options) {
  const opts = { ...options, scopeIds: options.scopeIds || [], apply: options.apply === true, help: false };
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
  const fetchOpts = { pageSize: 50, chatPageSize: 100, chatTypes: "group,p2p", maxPages: 40, retries: 2, retryDelayMs: 1000 };
  const self = (deps.getSelfProfile || getSelfProfile)(fetchOpts);
  if (!self || typeof self.open_id !== "string" || !self.open_id.startsWith("ou_")) throw new ReplayInputError("self identity could not be verified");
  const admissionError = accountBindingAdmissionError(readRemoteAccountBinding({ db: dbPath, selfOpenId: self.open_id }));
  if (admissionError) throw new ReplayInputError(admissionError);
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


export { executeLarkImReplay, validateReplayOptions, parseReplayTime, safeReplayError, ReplayInputError };
