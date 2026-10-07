// @ts-check

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/** A local category; callers must not publish the diagnostic message or label. */
export class SqliteReadError extends Error {
  /** @param {"dependency_unavailable" | "read_timeout" | "read_failed" | "invalid_response"} reason @param {string} message */
  constructor(reason, message) { super(message); this.name = "SqliteReadError"; this.reason = reason; }
}

/**
 * Read an existing database without initialization, recovery or permission
 * repair. The SQLite connection itself rejects writes and missing databases.
 * SQL is supplied by application code, never as an arbitrary CLI argument.
 *
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @param {{spawnSync?: typeof spawnSync, timeoutMs?:number}} [deps]
 * @returns {Record<string, any>[]}
 */
function readOnlySqliteJson(dbPath, sql, label, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("sqlite3", ["-readonly", "-json", resolve(dbPath)], {
    input: `.bail on\n.timeout 5000\nPRAGMA query_only=ON;\nBEGIN;\n${sql}\nCOMMIT;\n`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: Number.isSafeInteger(deps.timeoutMs) && Number(deps.timeoutMs) > 0 ? Math.min(30_000, Number(deps.timeoutMs)) : 30_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.error) {
    const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
    if (error?.code === "ENOENT") throw new SqliteReadError("dependency_unavailable", "required dependency unavailable");
    if (error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") throw new SqliteReadError("read_timeout", `${label} timed out`);
    // SQLite stderr can include private paths, SQL literals and record content.
    throw new SqliteReadError("read_failed", `${label} failed`);
  }
  const output = String(result.stdout || "").trim();
  if (!output) return [];
  try {
    const rows = JSON.parse(output);
    if (Array.isArray(rows)) return rows;
  } catch { /* Never include parser excerpts from private query results. */ }
  throw new SqliteReadError("invalid_response", `${label} returned invalid JSON`);
}

export { readOnlySqliteJson };
