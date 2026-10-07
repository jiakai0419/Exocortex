// @ts-check
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CliExecutionError } from "./context.mjs";
import { loadMessages } from "../diagnostics/messages-report.mjs";
import { applyLocalChatAppNames, LocalChatAppNamesError, readLocalChatAppNames } from "../diagnostics/local-chat-app-names.mjs";
import { renderMessagesText } from "../terminal/messages-view.mjs";
import { SqliteReadError } from "../storage/sqlite/readonly-query.mjs";

const READ_ERRORS = Object.freeze({
  dependency_unavailable: "SQLite command unavailable; install SQLite CLI and ensure sqlite3 is on PATH.",
  read_timeout: "Message query timed out; retry with a smaller --limit or check local database contention.",
  read_failed: "Message query failed; run check against the same --db to inspect database evidence.",
  invalid_response: "SQLite returned an invalid query response; verify the SQLite CLI installation and retry.",
});

/** Private reading preserves body, canonical, raw and display projections. */
export function executeMessages(options, deps = {}) {
  const dbPath = (deps.resolvePath || resolve)(options.db);
  if (!(deps.existsSync || existsSync)(dbPath)) throw new CliExecutionError("database not found");
  try {
    const names = (deps.readLocalChatAppNames || readLocalChatAppNames)(dbPath);
    const messages = (deps.loadMessages || loadMessages)(names?.dbPath || dbPath, options);
    return (deps.applyLocalChatAppNames || applyLocalChatAppNames)(messages, names);
  } catch (error) {
    if (error instanceof LocalChatAppNamesError) throw new CliExecutionError(error.message);
    if (error instanceof SqliteReadError && Object.hasOwn(READ_ERRORS, error.reason)) {
      throw new CliExecutionError(READ_ERRORS[error.reason], error.reason);
    }
    throw error;
  }
}

export function runMessagesCommand(options, context) {
  const messages = executeMessages(options, context.messagesDeps || context.deps || {});
  if (options.format === "json") context.stdout.write(`${JSON.stringify(messages, null, 2)}\n`);
  else context.stdout.write(renderMessagesText(messages));
  return 0;
}

export { loadMessages, renderMessagesText };
