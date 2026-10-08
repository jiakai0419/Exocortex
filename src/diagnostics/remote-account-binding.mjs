// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readStableJsonFile } from "./private-json-file.mjs";
import { dirname, resolve } from "node:path";
import { activityDatabaseKey } from "./lark-im-activity-evidence.mjs";
import { INITIAL_ACCOUNT_KIND, reserveInitialLarkAccount, recoverStaleSyncState } from "../../dist/storage/sqlite/ingestion-store.js";
import { readOnlySqliteJson } from "../storage/sqlite/readonly-query.mjs";

const KIND = "lark_im_remote_account_binding/v1";
const INITIAL_ACCOUNT_SQL = `(SELECT config_json FROM sources WHERE id='lark.im')`;
const INITIAL_ACCOUNT_COLUMNS = `json_type(${INITIAL_ACCOUNT_SQL}, '$.initial_account_binding') AS initial_account_type,
  json_extract(${INITIAL_ACCOUNT_SQL}, '$.initial_account_binding') AS initial_account_json,`;
const SQL = `SELECT
  ${INITIAL_ACCOUNT_COLUMNS}
  (SELECT COUNT(*) FROM records WHERE source_id = 'lark.im') AS records,
  (SELECT COUNT(*) FROM sync_runs WHERE source_id = 'lark.im') AS runs,
  (SELECT COUNT(*) FROM sync_scopes WHERE source_id = 'lark.im' AND cursor_json IS NOT NULL) AS cursors,
  COUNT(*) AS sent_records, COUNT(DISTINCT actor_id) AS sent_actors, MIN(actor_id) AS sent_actor,
  COALESCE(SUM(CASE WHEN actor_id IS NULL OR actor_id NOT GLOB 'ou_?*' THEN 1 ELSE 0 END), 0) AS invalid_actors,
  COALESCE(SUM(CASE WHEN canonical_json IS NOT NULL AND (
    (json_extract(canonical_json, '$.sender_id') IS NOT NULL AND json_extract(canonical_json, '$.sender_id') IS NOT actor_id)
    OR (json_extract(canonical_json, '$.sender_id_type') IS NOT NULL AND json_extract(canonical_json, '$.sender_id_type') <> 'open_id')
  ) THEN 1 ELSE 0 END), 0) AS identity_conflicts
FROM records WHERE source_id = 'lark.im' AND direction = 'sent';`;
const EMPTY_SQL = `SELECT
  ${INITIAL_ACCOUNT_COLUMNS}
  EXISTS(SELECT 1 FROM records WHERE source_id = 'lark.im') AS records,
  EXISTS(SELECT 1 FROM sync_runs WHERE source_id = 'lark.im') AS runs,
  EXISTS(SELECT 1 FROM sync_scopes WHERE source_id = 'lark.im' AND cursor_json IS NOT NULL) AS cursors,
  0 AS sent_records, 0 AS sent_actors, NULL AS sent_actor, 0 AS invalid_actors, 0 AS identity_conflicts;`;

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{query?: typeof readOnlySqliteJson, databaseKey?: typeof activityDatabaseKey, now?: () => number}} BindingDeps */
/** @param {string} value */
function accountKey(value) { return createHash("sha256").update(`lark.im\0${value}`).digest("hex"); }
/** @param {unknown} value */
function validOpenId(value) { return typeof value === "string" && /^ou_[A-Za-z0-9_-]+$/.test(value); }
/** @param {string} db */
function bindingPath(db) { return `${realpathSync(resolve(db))}.remote-account-binding.json`; }

/** Snapshot before any sync mutation. Only an initialized, empty source with
 * no runs or cursors may acquire a new binding from a later successful sync.
 * The query and all probe paths are read-only; identifiers stay in memory.
 * @param {{db: string, emptyOnly?: boolean, includeSidecar?: boolean}} options @param {BindingDeps} [deps] */
function captureRemoteAccountBinding(options, deps = {}) {
  try {
    const key = (deps.databaseKey || activityDatabaseKey)(options.db);
    if (!key) return null;
    const rows = (deps.query || readOnlySqliteJson)(options.db, options.emptyOnly ? EMPTY_SQL : SQL, "remote account binding");
    if (rows.length !== 1 || (deps.databaseKey || activityDatabaseKey)(options.db) !== key) return null;
    const row = rows[0];
    if (!["records", "runs", "cursors", "sent_records", "sent_actors", "invalid_actors", "identity_conflicts"]
      .every((field) => Number.isSafeInteger(row[field]) && row[field] >= 0)) return null;
    const sidecar = options.includeSidecar ? { binding_absent: readSidecar(options.db, (deps.now || Date.now)()) === null } : {};
    if (options.includeSidecar && (deps.databaseKey || activityDatabaseKey)(options.db) !== key) return null;
    const initial = row.initial_account_type == null ? null
      : parseInitialAccount(row.initial_account_type, row.initial_account_json, (deps.now || Date.now)());
    return { database_key: key, initial_account: initial, empty: row.records === 0 && row.runs === 0 && row.cursors === 0,
      sent_records: row.sent_records, sent_actors: row.sent_actors, sent_actor: row.sent_actor,
      conflict: row.invalid_actors > 0 || row.identity_conflicts > 0 || row.sent_actors > 1, ...sidecar };
  } catch { return null; }
}

/** Embedded association belongs to the database contents, not a pathname.
 * A copied database keeps its account; a separate sidecar still has its file fence.
 * @param {unknown} type @param {unknown} json @param {number} nowMs
 * @returns {JsonObject} */
function parseInitialAccount(type, json, nowMs) {
  if (type !== "object" || typeof json !== "string") throw new Error("invalid_initial_account");
  const value = JSON.parse(json);
  const validTime = time => typeof time === "string" && Number.isSafeInteger(Date.parse(time))
    && Date.parse(time) >= 0 && Date.parse(time) <= nowMs && new Date(time).toISOString() === time;
  if (value.kind !== INITIAL_ACCOUNT_KIND || !/^[a-f0-9]{64}$/.test(value.account_key)
    || !validTime(value.reserved_at) || !(value.confirmed_at === null || validTime(value.confirmed_at)
      && Date.parse(value.confirmed_at) >= Date.parse(value.reserved_at))) throw new Error("invalid_initial_account");
  return value;
}

/** The shared write admission rule; sampling still requires state=verified.
 * @param {{state?:string, reason?:string|null}} binding @returns {string|null} */
function accountBindingAdmissionError(binding) {
  if (binding.state === "conflict") return "Lark account conflicts with this database; use the matching account or a separate database";
  if (binding.state === "verified" || binding.state === "unverified" &&
      ["account_database_unbound", "account_database_pending"].includes(binding.reason || "")) return null;
  return "Lark account binding cannot be verified; inspect the existing database binding before retrying";
}

/** Preserve first-source ownership before runs, even if the command is killed.
 * The transaction independently rechecks emptiness and writer exclusion.
 * @param {{db:string, selfOpenId:string, before:ReturnType<typeof captureRemoteAccountBinding>}} options */
function reserveSyncAccountBinding(options) {
  const before = options.before;
  if (!before) throw new Error("initial account snapshot unavailable");
  if (!validOpenId(options.selfOpenId) || activityDatabaseKey(options.db) !== before.database_key) {
    throw new Error("initial account database identity changed");
  }
  if (!before.empty || before.binding_absent !== true || before.initial_account) return false;
  // Older first attempts could die after acquiring a lock but before creating
  // a run. Preserve their existing fenced recovery before the source-wide CAS.
  const locks = readOnlySqliteJson(options.db, `SELECT l.scope_id FROM sync_locks l
    JOIN sync_scopes s ON s.id=l.scope_id WHERE s.source_id='lark.im'
      AND NOT EXISTS (SELECT 1 FROM maintenance_locks
        WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'));`, "read initial Lark account locks");
  for (const lock of locks) {
    if (activityDatabaseKey(options.db) !== before.database_key) throw new Error("initial account database identity changed");
    recoverStaleSyncState(options.db, { scopeId: lock.scope_id });
  }
  if (activityDatabaseKey(options.db) !== before.database_key) throw new Error("initial account database identity changed");
  reserveInitialLarkAccount(options.db, accountKey(options.selfOpenId), new Date().toISOString());
  if (activityDatabaseKey(options.db) !== before.database_key) throw new Error("initial account database identity changed");
  return true;
}

/** Sidecar corruption is evidence failure, never permission to rebind.
 * @param {string} db @returns {JsonObject|null} */
function readSidecar(db, nowMs = Date.now()) {
  const read = readStableJsonFile(bindingPath(db), { maxBytes: 4096 });
  if (read.status === "missing") return null;
  if (read.status !== "ready") throw new Error("invalid_binding");
  const value = read.value;
  const at = typeof value?.bound_at === "string" ? Date.parse(value.bound_at) : NaN;
  if (value?.kind !== KIND || !/^[a-f0-9]{64}$/.test(value.database_key) || !/^[a-f0-9]{64}$/.test(value.account_key)
    || value.evidence !== "initialized_empty_database" || !Number.isSafeInteger(at) || at < 0 || at > nowMs
    || new Date(at).toISOString() !== value.bound_at) throw new Error("invalid_binding");
  return value;
}

/** Named evidence is narrow: single_sent_actor establishes only the existing
 * sent projection, never ownership of every historical record or API scope.
 * The persisted source does not establish tenant or app identity. Callers may
 * pass the remote tenant for their round's identity stability check, but it
 * cannot upgrade the local evidence or silently change the account namespace.
 * @param {{db: string, selfOpenId: string, selfTenantKey?: string}} options @param {BindingDeps} [deps] */
function readRemoteAccountBinding(options, deps = {}) {
  const unavailable = (reason) => ({ state: "unavailable", evidence: null, database_key: null, tenant_verified: false, reason });
  if (!validOpenId(options.selfOpenId)) return unavailable("self_identity_unverified");
  const before = captureRemoteAccountBinding(options, deps);
  if (!before) return unavailable("database_evidence_unavailable");
  const base = { evidence: /** @type {string|null} */ (null), database_key: before.database_key,
    account_key: accountKey(options.selfOpenId), tenant_verified: false };
  try {
    const stored = readSidecar(options.db, (deps.now || Date.now)());
    if ((deps.databaseKey || activityDatabaseKey)(options.db) !== before.database_key) return unavailable("database_identity_changed");
    if (stored && stored.database_key !== before.database_key) return { ...base, state: "unverified", reason: "binding_database_changed" };
    const initial = before.initial_account;
    if (before.conflict || stored && stored.account_key !== base.account_key || initial && initial.account_key !== base.account_key || before.sent_records > 0 && before.sent_actor !== options.selfOpenId) {
      return { ...base, state: "conflict", reason: "account_database_conflict" };
    }
    if (initial) return initial.confirmed_at === null
      ? { ...base, state: "unverified", reason: "account_database_pending" }
      : { ...base, state: "verified", evidence: "initialized_empty_database", reason: null };
    if (stored) return { ...base, state: "verified", evidence: stored.evidence, reason: null };
    if (before.sent_records > 0 && before.sent_actors === 1 && validOpenId(before.sent_actor)) {
      return { ...base, state: "verified", evidence: "single_sent_actor", reason: null };
    }
    return { ...base, state: "unverified", reason: "account_database_unbound" };
  } catch { return unavailable("binding_evidence_unavailable"); }
}

/** Called only from successful authorized sync while holding its API lease.
 * Does not write business tables or persist profile ids. A current profile
 * alone cannot attest an old database. New sources require transactionally
 * confirmed embedded evidence; the empty snapshot preserves older callers.
 * @param {{db: string, selfOpenId: string, before: ReturnType<typeof captureRemoteAccountBinding>, successful: boolean}} options
 * @param {BindingDeps} [deps] */
function recordSuccessfulSyncBinding(options, deps = {}) {
  if (!options.successful || !options.before || !validOpenId(options.selfOpenId)) return false;
  let temporary = "";
  try {
    const key = (deps.databaseKey || activityDatabaseKey)(options.db);
    if (!key || key !== options.before.database_key || readSidecar(options.db, (deps.now || Date.now)())) return false;
    const after = captureRemoteAccountBinding(options, deps);
    if (!after || after.database_key !== key || after.conflict || after.sent_records > 0 && after.sent_actor !== options.selfOpenId) return false;
    if (after.initial_account ? after.initial_account.confirmed_at === null || after.initial_account.account_key !== accountKey(options.selfOpenId)
      : !options.before.empty) return false;
    const file = bindingPath(options.db);
    temporary = `${file}.${randomUUID()}.tmp`;
    const binding = { kind: KIND, database_key: key, account_key: accountKey(options.selfOpenId),
      evidence: "initialized_empty_database", bound_at: new Date((deps.now || Date.now)()).toISOString() };
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(binding)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    if ((deps.databaseKey || activityDatabaseKey)(options.db) !== key) return false;
    renameSync(temporary, file);
    const directoryFd = openSync(dirname(file), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return true;
  } catch { return false; }
  finally { try { if (temporary) unlinkSync(temporary); } catch { /* Already renamed or inaccessible. */ } }
}

export { captureRemoteAccountBinding, readRemoteAccountBinding, recordSuccessfulSyncBinding,
  accountBindingAdmissionError, reserveSyncAccountBinding, readSidecar as readRemoteAccountBindingSidecar };
