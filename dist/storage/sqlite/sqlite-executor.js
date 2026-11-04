import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { markSqlDispatch, observeSqlProcess } from './execution-evidence.js';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const OBJECTS_BEGIN = "__EXOCORTEX_OBSERVATION_OBJECTS_BEGIN_V1__";
const OBJECTS_END = "__EXOCORTEX_OBSERVATION_OBJECTS_END_V1__";
function quoteSql(value) {
    if (value === null || value === undefined)
        return "NULL";
    const text = String(value);
    // A NUL byte belongs to the TEXT value, never to the SQLite CLI's SQL
    // program. Keep exact UTF-8 bytes for ingestion and all source/CAS fences.
    if (text.includes("\0"))
        return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
    return `'${text.replaceAll("'", "''")}'`;
}
function sqlJson(value) {
    return quoteSql(JSON.stringify(value));
}
function chmodIfPresent(path, mode) {
    try {
        if (existsSync(path))
            chmodSync(path, mode);
    }
    catch (error) {
        const err = error;
        if (err.code !== "ENOENT")
            throw error;
    }
}
function prepareWritableDatabasePaths(dbPath, protectExistingDirectory = false) {
    const resolvedDbPath = resolve(dbPath);
    const dbDir = dirname(resolvedDbPath);
    mkdirSync(dbDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    // Ordinary store writes may target a DB in a shared directory. Tightening
    // that existing directory is reserved for explicit initialization/security.
    if (protectExistingDirectory)
        chmodSync(dbDir, PRIVATE_DIRECTORY_MODE);
    for (const path of [resolvedDbPath, `${resolvedDbPath}-wal`, `${resolvedDbPath}-shm`, `${resolvedDbPath}-journal`]) {
        chmodIfPresent(path, PRIVATE_FILE_MODE);
    }
    return resolvedDbPath;
}
function secureDatabasePaths(dbPath) {
    return prepareWritableDatabasePaths(dbPath, true);
}
function withPrivateUmask(work) {
    const previous = process.umask(0o077);
    try {
        return work();
    }
    finally {
        process.umask(previous);
    }
}
function sqliteFailure(result, label) {
    const error = result.error;
    if (error?.code === "ENOENT") {
        return new Error(`${label} failed: sqlite3 executable not found (ENOENT); install SQLite and ensure sqlite3 is on PATH`);
    }
    const stderr = String(result.stderr || "").trim();
    const detail = stderr || error?.message || `sqlite3 exited with status ${String(result.status)}`;
    return new Error(`${label} failed: ${detail}`);
}
function sqliteRun(dbPath, sql, label, json = false, executionBudget, evidence) {
    executionBudget?.assertReady();
    const resolvedDbPath = prepareWritableDatabasePaths(dbPath);
    let result;
    try {
        const timeout = executionBudget?.timeoutMs();
        if (executionBudget && (!Number.isSafeInteger(timeout) || Number(timeout) <= 0)) {
            throw new RangeError("SQLite execution budget must provide a positive integer timeout");
        }
        result = withPrivateUmask(() => {
            markSqlDispatch(evidence);
            const objectLines = json === "objects";
            const observed = spawnSync("sqlite3", [...(objectLines
                    ? ["-readonly", "-batch", "-init", "/dev/null", "-noheader", "-list"]
                    : json ? ["-json"] : []), resolvedDbPath], {
                input: `.bail on\n.timeout ${timeout === undefined ? 5000 : Math.min(5000, timeout)}\nPRAGMA foreign_keys = ON;\n${objectLines
                    ? `PRAGMA query_only = ON;\nBEGIN;\nSELECT '${OBJECTS_BEGIN}' AS object_frame;\n${sql}\nCOMMIT;\nSELECT '${OBJECTS_END}' AS object_frame;\n`
                    : sql}`,
                encoding: "utf8",
                maxBuffer: 50 * 1024 * 1024,
                ...(timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" }),
            });
            observeSqlProcess(evidence, observed);
            return observed;
        });
    }
    finally {
        prepareWritableDatabasePaths(resolvedDbPath);
    }
    if (result.status !== 0 || result.error || (executionBudget || json === "objects") && result.signal)
        throw sqliteFailure(result, label);
    return String(result.stdout || "");
}
function sqliteExec(dbPath, sql, label, executionBudget) {
    return sqliteRun(dbPath, sql, label, false, executionBudget);
}
function sqliteQuery(dbPath, sql, label, executionBudget, evidence) {
    const trimmed = sqliteRun(dbPath, sql, label, true, executionBudget, evidence).trim();
    return trimmed ? JSON.parse(trimmed) : [];
}
/** Only for a trusted SELECT producing one SQL-encoded JSON object per row.
 * A second CLI JSON layer can double large TEXT values; a completed read
 * transaction and strict framing replace that layer without accepting prefixes.
 */
function sqliteQueryJsonObjects(dbPath, sql, label, executionBudget) {
    const output = sqliteRun(dbPath, sql, label, "objects", executionBudget);
    executionBudget?.assertReady();
    const lines = output.split(/\r?\n/);
    if (lines.at(-1) === "")
        lines.pop();
    if (output.includes("\0") || lines.length < 2 || lines[0] !== OBJECTS_BEGIN || lines.at(-1) !== OBJECTS_END) {
        throw new Error(`${label} failed: incomplete or invalid SQLite object frame`);
    }
    const rows = [];
    for (const line of lines.slice(1, -1)) {
        executionBudget?.assertReady();
        const row = JSON.parse(line);
        if (!row || typeof row !== "object" || Array.isArray(row)) {
            throw new Error(`${label} failed: SQLite object row required`);
        }
        rows.push(row);
    }
    executionBudget?.assertReady();
    return rows;
}
export { quoteSql, sqlJson, secureDatabasePaths, prepareWritableDatabasePaths, withPrivateUmask, sqliteExec, sqliteQuery, sqliteQueryJsonObjects };
