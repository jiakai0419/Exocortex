import type { ExecutionBudget, SqliteRow } from "./ingestion-types.js";
declare function quoteSql(value: unknown): string;
declare function sqlJson(value: unknown): string;
declare function prepareWritableDatabasePaths(dbPath: string, protectExistingDirectory?: boolean): string;
declare function secureDatabasePaths(dbPath: string): string;
declare function withPrivateUmask<T>(work: () => T): T;
declare function sqliteExec(dbPath: string, sql: string, label: string, executionBudget?: ExecutionBudget): string;
declare function sqliteQuery(dbPath: string, sql: string, label: string, executionBudget?: ExecutionBudget, evidence?: object): SqliteRow[];
/** Only for a trusted SELECT producing one SQL-encoded JSON object per row.
 * A second CLI JSON layer can double large TEXT values; a completed read
 * transaction and strict framing replace that layer without accepting prefixes.
 */
declare function sqliteQueryJsonObjects(dbPath: string, sql: string, label: string, executionBudget?: ExecutionBudget): SqliteRow[];
export { quoteSql, sqlJson, secureDatabasePaths, prepareWritableDatabasePaths, withPrivateUmask, sqliteExec, sqliteQuery, sqliteQueryJsonObjects };
