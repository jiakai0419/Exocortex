// @ts-check

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { copySqliteReadDiagnostic, sqliteReadDiagnostic, sqliteReadStage } from "../../diagnostics/sqlite-read-diagnostic.mjs";

const diagnostics = new WeakMap();

/** A local category; callers must not publish the diagnostic message or label. */
export class SqliteReadError extends Error {
  /** @param {"dependency_unavailable" | "read_timeout" | "read_failed" | "invalid_response"} reason @param {string} message @param {unknown} [diagnostic] */
  constructor(reason, message, diagnostic) {
    super(message); this.name = "SqliteReadError"; this.reason = reason;
    diagnostics.set(this, copySqliteReadDiagnostic(diagnostic));
  }
}

export function readSqliteReadDiagnostic(error) {
  return error instanceof SqliteReadError ? copySqliteReadDiagnostic(diagnostics.get(error)) : null;
}

/**
 * Read an existing database without initialization, recovery or permission
 * repair. The SQLite connection itself rejects writes and missing databases.
 * SQL is supplied by application code, never as an arbitrary CLI argument.
 *
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @param {{spawnSync?: typeof spawnSync, timeoutMs?:number, monotonicNowMs?:()=>number}} [deps]
 * @param {boolean} [lines]
 */
function executeReadOnly(dbPath, sql, label, deps = {}, lines = false) {
  const run = deps.spawnSync || spawnSync;
  const now = deps.monotonicNowMs || (() => performance.now());
  const observe = () => { try { return now(); } catch { return NaN; } };
  const started = observe();
  const timeoutMs = Number.isSafeInteger(deps.timeoutMs) && Number(deps.timeoutMs) > 0 ? Math.min(30_000, Number(deps.timeoutMs)) : 30_000;
  const maxBufferBytes = 50 * 1024 * 1024;
  let result;
  try { result = run("sqlite3", ["-readonly", ...(lines ? ["-batch", "-init", "/dev/null", "-noheader", "-list"] : ["-json"]), resolve(dbPath)], {
    input: `.bail on\n.timeout 5000\nPRAGMA query_only=ON;\nBEGIN;\n${lines ? `.print ${JSON_LINES_BEGIN}\n` : ""}${sql}\nCOMMIT;\n${lines ? `.print ${JSON_LINES_END}\n` : ""}`,
    encoding: "utf8",
    maxBuffer: maxBufferBytes,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  }); } catch (error) { result = { status: null, signal: null, error }; }
  const finished = observe();
  const elapsedMs = Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? Math.floor(finished - started) : null;
  const diagnostic = kind => sqliteReadDiagnostic({ stage: sqliteReadStage(label), kind, result, elapsedMs, timeoutMs, maxBufferBytes });
  const status = result?.status;
  if (!result || result.status !== 0 || result.error || result.signal) {
    const error = /** @type {NodeJS.ErrnoException | undefined} */ (result?.error);
    if (error?.code === "ENOENT") throw new SqliteReadError("dependency_unavailable", "required dependency unavailable", diagnostic('dependency_unavailable'));
    if (error?.code === "ENOBUFS") throw new SqliteReadError("read_failed", `${label} exceeded output budget`, diagnostic('output_limit'));
    if (error?.code === "ETIMEDOUT") throw new SqliteReadError("read_timeout", `${label} timed out`, diagnostic('timeout'));
    // SQLite stderr can include private paths, SQL literals and record content.
    throw new SqliteReadError("read_failed", `${label} failed`, diagnostic(error ? 'spawn_error' : result?.signal ? 'process_signal'
      : typeof status === 'number' && Number.isInteger(status) && status > 0 && status <= 255 ? 'process_exit' : 'unknown'));
  }
  return { output: String(result.stdout || ""), diagnostic };
}

const JSON_LINES_BEGIN = "__EXOCORTEX_JSON_LINES_BEGIN_V1__";
const JSON_LINES_END = "__EXOCORTEX_JSON_LINES_END_V1__";

/** @param {string} dbPath @param {string} sql @param {string} label
 * @param {{spawnSync?: typeof spawnSync, timeoutMs?:number, monotonicNowMs?:()=>number}} [deps]
 * @returns {Record<string, any>[]} */
function readOnlySqliteJson(dbPath, sql, label, deps = {}) {
  const { output: raw, diagnostic } = executeReadOnly(dbPath, sql, label, deps);
  const output = raw.trim();
  if (!output) return [];
  try {
    const rows = JSON.parse(output);
    if (Array.isArray(rows)) return rows;
  } catch { throw new SqliteReadError("invalid_response", `${label} returned invalid JSON`, diagnostic('invalid_json')); }
  throw new SqliteReadError("invalid_response", `${label} returned invalid JSON`, diagnostic('invalid_shape'));
}

/** Read one SQL-encoded JSON object column per row without CLI JSON re-escaping.
 * The fixed frame is emitted only by trusted CLI directives; END follows a
 * successful COMMIT and is never inferred from parseable row prefixes. Source
 * TEXT belongs inside SQL json_object strings, never interpolated into framing.
 * @param {string} dbPath @param {string} sql @param {string} label
 * @param {{spawnSync?: typeof spawnSync, timeoutMs?:number, monotonicNowMs?:()=>number}} [deps]
 * @returns {Record<string, any>[]} */
function readOnlySqliteJsonLines(dbPath, sql, label, deps = {}) {
  const { output, diagnostic } = executeReadOnly(dbPath, sql, label, deps, true);
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (output.includes("\0") || lines.length < 2 || lines.shift() !== JSON_LINES_BEGIN || lines.pop() !== JSON_LINES_END) {
    throw new SqliteReadError("invalid_response", `${label} returned invalid JSON`, diagnostic('invalid_shape'));
  }
  return lines.map(line => {
    let row;
    try { row = JSON.parse(line); }
    catch { throw new SqliteReadError("invalid_response", `${label} returned invalid JSON`, diagnostic('invalid_json')); }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new SqliteReadError("invalid_response", `${label} returned invalid JSON`, diagnostic('invalid_shape'));
    }
    return row;
  });
}

export { readOnlySqliteJson, readOnlySqliteJsonLines };
