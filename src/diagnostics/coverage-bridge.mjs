// @ts-check
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { publicTimestamp } from "./public-safe.mjs";

/** @typedef {Record<string, any>} JsonObject */

/** Only the Python implementation decides coverage. Exit 2 may mean either
 * valid incomplete evidence or a read failure; JSON and process outcome must agree.
 * @param {JsonObject} plan @param {JsonObject} context @param {JsonObject} [deps]
 */
function inspectCoverage(plan, context, deps = {}) {
  const result = (deps.spawnSync || spawnSync)(deps.python || "python3", [
    resolve(context.root, "tools/coverage/lark-im-coverage-check.py"), "--db", plan.db,
    "--target", new Date(plan.throughMs).toISOString(),
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 120000, killSignal: "SIGKILL", env: context.env });
  if (result.error || result.signal || ![0, 2].includes(result.status)) throw new Error("coverage_execution_failed");
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error("coverage_invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.error || typeof value.ok !== "boolean" ||
      !value.coverage || typeof value.coverage.initial_baseline_complete !== "boolean" ||
      value.ok !== (result.status === 0) || value.ok && value.coverage.initial_baseline_complete !== true) {
    throw new Error("coverage_inspection_failed");
  }
  return { ok: value.ok, evidence: publicCoverage(value) };
}

/** @param {JsonObject} value */
function publicCoverage(value) {
  const coverage = value.coverage || {};
  const counts = ["required_start_ms", "target_ms", "configured_initial_sync_start_ms", "enabled_message_scopes",
    "complete_window_coverage_scopes", "incomplete_window_coverage_scopes", "scopes_missing_start_coverage",
    "scopes_with_internal_gaps", "scopes_missing_end_coverage", "scopes_without_eligible_successful_runs",
    "scopes_with_invalid_successful_run_evidence", "covered_scope_milliseconds", "missing_scope_milliseconds"];
  return { checked_at: publicTimestamp(value.checked_at), database_checks_ok: value.database_checks_ok === true,
    coverage: { ...Object.fromEntries(counts.map((key) => [key, Number.isSafeInteger(coverage[key]) && coverage[key] >= 0 ? coverage[key] : null])),
      initial_baseline_complete: coverage.initial_baseline_complete === true,
      successful_windows_cover_fixed_range: coverage.successful_windows_cover_fixed_range === true,
      details_at_or_before_target_resolved: typeof coverage.details_at_or_before_target_resolved === "boolean"
        ? coverage.details_at_or_before_target_resolved : null,
      required_start_utc: publicTimestamp(coverage.required_start_utc), target_utc: publicTimestamp(coverage.target_utc) } };
}

export { inspectCoverage, publicCoverage };
