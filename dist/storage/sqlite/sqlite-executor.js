import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { markSqlDispatch, observeSqlProcess } from './execution-evidence.js';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
function quoteSql(value) {
    if (value === null || value === undefined)
        return "NULL";
    return `'${String(value).replaceAll("'", "''")}'`;
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
            const observed = spawnSync("sqlite3", [...(json ? ["-json"] : []), resolvedDbPath], {
                input: `.bail on\n.timeout ${timeout === undefined ? 5000 : Math.min(5000, timeout)}\nPRAGMA foreign_keys = ON;\n${sql}`,
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
    if (result.status !== 0 || result.error || executionBudget && result.signal)
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
export { quoteSql, sqlJson, secureDatabasePaths, prepareWritableDatabasePaths, withPrivateUmask, sqliteExec, sqliteQuery };
