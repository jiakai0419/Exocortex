// @ts-check
import { collectCheckReport } from "../diagnostics/check-report.mjs";
import { REMOTE_REASONS } from "../diagnostics/remote-sample-cache.mjs";

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
      if (live.status !== "healthy" && REMOTE_REASONS.includes(live.reason)) {
        context.stdout.write(`Reason: ${SAMPLE_REASONS[live.reason] || live.reason.replace(/_/g, " ")}\n`);
      }
      context.stdout.write(`Window: ${live.window.start} to ${live.window.end}\n`);
      context.stdout.write(`Findings: ${live.findings.confirmed_missing} confirmed missing · ${live.findings.suspected_missing} suspected · ${live.findings.pending_sync} pending sync · ${live.findings.stale_version} older versions · ${live.findings.content_mismatch} source content differences\n`);
      for (const [key, label] of EXTRA_FINDINGS) {
        if (Number.isSafeInteger(live.findings[key]) && live.findings[key] > 0) context.stdout.write(`${label}: ${live.findings[key]}\n`);
      }
      context.stdout.write(`Compared: ${live.findings.content_equal} static bodies · ${live.findings.content_unverified} body comparisons unverified · ${live.probe.truncated_chats} truncated chats\n`);
    }
  }
  return report.exit_code;
}
