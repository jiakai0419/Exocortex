// @ts-check

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Read an existing database without initialization, recovery or permission
 * repair. The SQLite connection itself rejects writes and missing databases.
 * SQL is supplied by application code, never as an arbitrary CLI argument.
 *
 * @param {string} dbPath
 * @param {string} sql
 * @param {string} label
 * @param {{spawnSync?: typeof spawnSync}} [deps]
 * @returns {Record<string, any>[]}
 */
function readOnlySqliteJson(dbPath, sql, label, deps = {}) {
  const run = deps.spawnSync || spawnSync;
  const result = run("sqlite3", ["-readonly", "-json", resolve(dbPath)], {
    input: `.bail on\n.timeout 5000\nPRAGMA query_only=ON;\nBEGIN;\n${sql}\nCOMMIT;\n`,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.error) {
    const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
    if (error?.code === "ENOENT") throw new Error("required dependency unavailable");
    if (error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") throw new Error(`${label} timed out`);
    // SQLite stderr can include private paths, SQL literals and record content.
    throw new Error(`${label} failed`);
  }
  const output = String(result.stdout || "").trim();
  if (!output) return [];
  try {
    const rows = JSON.parse(output);
    if (Array.isArray(rows)) return rows;
  } catch { /* Never include parser excerpts from private query results. */ }
  throw new Error(`${label} returned invalid JSON`);
}

export { readOnlySqliteJson };
