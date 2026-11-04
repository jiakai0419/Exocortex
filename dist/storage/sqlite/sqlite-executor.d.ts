import type { ExecutionBudget, SqliteRow } from "./ingestion-types.js";
declare function quoteSql(value: unknown): string;
declare function sqlJson(value: unknown): string;
declare function prepareWritableDatabasePaths(dbPath: string, protectExistingDirectory?: boolean): string;
declare function secureDatabasePaths(dbPath: string): string;
declare function withPrivateUmask<T>(work: () => T): T;
declare function sqliteExec(dbPath: string, sql: string, label: string, executionBudget?: ExecutionBudget): string;
declare function sqliteQuery(dbPath: string, sql: string, label: string, executionBudget?: ExecutionBudget, evidence?: object): SqliteRow[];
export { quoteSql, sqlJson, secureDatabasePaths, prepareWritableDatabasePaths, withPrivateUmask, sqliteExec, sqliteQuery };
