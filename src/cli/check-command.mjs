// @ts-check
import { collectCheckReport } from "../diagnostics/check-report.mjs";
import { REMOTE_REASONS } from "../diagnostics/remote-sample-cache.mjs";
import { safeCollectorDiagnostic } from "../diagnostics/remote-sample-diagnostic.mjs";
import { terminalColumns, wrapLabelValue } from "../terminal/text-layout.mjs";

const SAMPLE_REASONS = Object.freeze({
  not_due: "Next sample is not due", sync_busy: "Synchronization is using the API",
  account_mismatch: "Account association conflicts", account_unverified: "Account association is unverified",
  no_eligible_chats: "No eligible discovered chats", no_usable_remote_messages: "No usable remote messages",
  source_difference: "Sample has source differences", unresolved_observations: "Prior sample findings remain unresolved",
});
const EXTRA_FINDINGS = [
  ["identity_conflict", "Message identity conflicts"], ["unresolved_prior", "Prior findings unresolved"],
  ["local_newer", "Newer local versions"], ["expired_observations", "Expired observations"],
  ["observation_overflow", "Observations beyond retained capacity"],
];
/** @type {Readonly<Record<string, string>>} */
const WAIT_REASONS = Object.freeze({
  service_not_running_or_target_unverified: "Service is not running or its database target is unverified",
  wait_timeout: "Wait deadline reached",
  final_local_not_ready: "Final local checks are not ready",
});
/** Project only known incomplete-wait reasons; never echo dependency text.
 * @param {Record<string, any> | undefined} check */
export function waitReasonText(check) {
  const reason = check?.evidence?.reason;
  return check?.status === "incomplete" && typeof reason === "string" && Object.hasOwn(WAIT_REASONS, reason)
    ? WAIT_REASONS[reason] : "";
}
/** @param {Record<string, any>} options @param {Record<string, any>} context @param {Record<string, any>} [deps] */
export async function runCheckCommand(options, context, deps = {}) {
  const report = await collectCheckReport(options, context, deps);
  if (options.format === "json") context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const columns = terminalColumns(context.stdout);
    const row = (label, value) => context.stdout.write(`${wrapLabelValue(`${label}:`, value, columns, { gap: " " }).join("\n")}\n`);
    row(`${report.privacy === "private" ? "PRIVATE · " : ""}Check`, report.ok ? "PASSED" : report.exit_code === 1 ? "ERROR" : "INCOMPLETE");
    for (const [name, item] of Object.entries(report.checks)) row(name, item.status.toUpperCase());
    for (const issue of report.issues) row(issue.check, issue.code);
    const waitReason = waitReasonText(report.checks.wait);
    if (waitReason) row("Wait reason", waitReason);
    const live = report.checks.live.evidence;
    if (live?.schema_version === 3) {
      row("Remote sample", `${live.status} · ${live.probe.remote_messages_checked} messages / ${live.probe.hot_chats_found} discovered chats · checked ${live.checked_at}`);
      if (live.status !== "healthy" && REMOTE_REASONS.includes(live.reason)) {
        row("Reason", SAMPLE_REASONS[live.reason] || live.reason.replace(/_/g, " "));
      }
      const diagnostic = safeCollectorDiagnostic(live.collector_diagnostic);
      if (diagnostic) row("Sample diagnostic", `${diagnostic.stage} · ${diagnostic.code}`);
      row("Window", `${live.window.start} to ${live.window.end}`);
      row("Findings", `${live.findings.confirmed_missing} confirmed missing · ${live.findings.suspected_missing} suspected · ${live.findings.pending_sync} pending sync · ${live.findings.stale_version} older versions · ${live.findings.content_mismatch} source content differences`);
      for (const [key, label] of EXTRA_FINDINGS) {
        if (Number.isSafeInteger(live.findings[key]) && live.findings[key] > 0) row(label, String(live.findings[key]));
      }
      row("Compared", `${live.findings.content_equal} static bodies · ${live.findings.content_unverified} body comparisons unverified · ${live.probe.truncated_chats} truncated chats`);
    }
  }
  return report.exit_code;
}
