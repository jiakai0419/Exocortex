// @ts-check
import { CliUsageError } from "./context.mjs";
import { renderStatusText } from "../terminal/status-view.mjs";
import { collectStatusEvidence, publicStatusReport, readPrivateLogs } from "../diagnostics/status-report.mjs";
/** @param {Record<string, any>} options @param {Record<string, any>} context @param {Record<string, any>} [deps] */
export async function runStatusCommand(options, context, deps = {}) {
  if (context.provided.has("--lines") && !options.logs) throw new CliUsageError("--lines requires --logs");
  const collected = collectStatusEvidence(options, context, deps);
  /** @type {Record<string, any>} */
  const report = publicStatusReport(collected, options);
  if (options.logs) report.logs = readPrivateLogs(options, deps);
  const code = collected.report.sync.status ? 0 : 1;
  if (options.format === "json") context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else context.stdout.write(renderStatusText(report, { columns: context.stdout.columns, stream: context.stdout }));
  return code;
}
