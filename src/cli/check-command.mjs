// @ts-check
import { renderLagText } from "../terminal/lark-im-lag-view.mjs";
import { collectCheckReport } from "../diagnostics/check-report.mjs";
/** @param {Record<string, any>} options @param {Record<string, any>} context @param {Record<string, any>} [deps] */
export async function runCheckCommand(options, context, deps = {}) {
  const report = await collectCheckReport(options, context, deps);
  if (options.format === "json") context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    context.stdout.write(`${report.privacy === "private" ? "PRIVATE · " : ""}Check: ${report.ok ? "PASSED" : report.exit_code === 1 ? "ERROR" : "INCOMPLETE"}\n`);
    for (const [name, item] of Object.entries(report.checks)) context.stdout.write(`${name}: ${item.status.toUpperCase()}\n`);
    for (const issue of report.issues) context.stdout.write(`${issue.check}: ${issue.code}\n`);
    const live = report.checks.live.evidence;
    if (live?.schema_version === 3) {
      context.stdout.write(`Remote sample: ${live.status} · ${live.probe.remote_messages_checked} messages / ${live.probe.hot_chats_found} discovered chats · checked ${live.checked_at}\n`);
      context.stdout.write(`Window: ${live.window.start} to ${live.window.end}\n`);
      context.stdout.write(`Findings: ${live.findings.confirmed_missing} confirmed missing · ${live.findings.suspected_missing} suspected · ${live.findings.pending_sync} pending sync · ${live.findings.stale_version} older versions · ${live.findings.content_mismatch} source content differences\n`);
      context.stdout.write(`Compared: ${live.findings.content_equal} static bodies · ${live.findings.content_unverified} body comparisons unverified · ${live.probe.truncated_chats} truncated chats\n`);
    } else if (live?.window && live?.probe) context.stdout.write(renderLagText({ ...live,
      missing: live.missing || [], unsupported_chats: live.unsupported_chats || [], probe_errors: live.probe_errors || [] }));
  }
  return report.exit_code;
}
