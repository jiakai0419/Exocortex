// @ts-check
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CliExecutionError } from "./context.mjs";
import { loadMessages } from "../diagnostics/messages-report.mjs";
import { renderMessagesText } from "../terminal/messages-view.mjs";

/** Private reading preserves body, canonical, raw and display projections. */
export function executeMessages(options, deps = {}) {
  const dbPath = (deps.resolvePath || resolve)(options.db);
  if (!(deps.existsSync || existsSync)(dbPath)) throw new CliExecutionError("database not found");
  return (deps.loadMessages || loadMessages)(dbPath, options);
}

export function runMessagesCommand(options, context) {
  const messages = executeMessages(options, context.messagesDeps || context.deps || {});
  if (options.format === "json") context.stdout.write(`${JSON.stringify(messages, null, 2)}\n`);
  else context.stdout.write(renderMessagesText(messages));
  return 0;
}

export { loadMessages, renderMessagesText };
