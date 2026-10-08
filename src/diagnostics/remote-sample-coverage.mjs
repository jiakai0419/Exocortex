// @ts-check
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SampleEvidenceError } from "./remote-sample-diagnostic.mjs";

/** @typedef {{key:string,scope_id:string,message_id:string,created_ms:number,observed_after_ms?:number}} SampleCoverageTarget */
/** @typedef {{covered:boolean,latest_finished_ms:number|null,details_pending:boolean,reason:string}} SampleCoverageEvidence */
/** @typedef {Record<string, any>} JsonObject */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_TARGETS = 200;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const RECORD_FIELDS = ["external_id", "source_id", "record_type", "container_id", "external_version", "raw_json", "canonical_json"];
const MIN_EPOCH_MS = 100_000_000_000;
const REASONS = new Set(["covered", "no_covering_run", "source_unavailable", "scope_unavailable",
  "detail_evidence_unavailable", "details_pending", "inspection_budget_exhausted", "readonly_inspection_failed"]);

/** @param {unknown} value @param {number} now */
function timestamp(value, now) {
  return Number.isSafeInteger(value) && Number(value) >= MIN_EPOCH_MS && Number(value) <= now;
}

/** The sole coverage algorithm lives in Python. Coverage and private records
 * come from one read-only SQLite transaction. The returned records are internal
 * comparison input and must never be included in public reports or logs.
 * @param {string} dbPath
 * @param {SampleCoverageTarget[]} targets
 * @param {JsonObject} [deps]
 * @returns {{coverage:Record<string, SampleCoverageEvidence>, records:Map<string,JsonObject>}}
 */
function inspectRemoteSampleSnapshot(dbPath, targets, deps = {}) {
  const now = (deps.now || Date.now)();
  const keys = new Set();
  if (!Array.isArray(targets) || targets.length > MAX_TARGETS) throw new SampleEvidenceError("remote_sample_coverage_invalid_targets", "snapshot_invalid_targets");
  for (const target of targets) {
    if (!target || typeof target !== "object" || Array.isArray(target)
        || !/^[a-f0-9]{64}$/.test(target.key) || keys.has(target.key)
        || typeof target.scope_id !== "string" || !/^lark\.im\.received\.chat\..+$/u.test(target.scope_id)
        || target.scope_id.length > 512 || /[\u0000-\u001f\u007f]/u.test(target.scope_id)
        || typeof target.message_id !== "string" || !target.message_id.trim() || target.message_id.length > 512
        || /[\u0000-\u001f\u007f]/u.test(target.message_id)
        || !timestamp(target.created_ms, now)
        || Object.hasOwn(target, "observed_after_ms") && !timestamp(target.observed_after_ms, now)
        || Object.keys(target).some((key) => !["key", "scope_id", "message_id", "created_ms", "observed_after_ms"].includes(key))) {
      throw new SampleEvidenceError("remote_sample_coverage_invalid_targets", "snapshot_invalid_targets");
    }
    keys.add(target.key);
  }
  if (targets.length === 0) return { coverage: {}, records: new Map() };
  const input = JSON.stringify({ targets });
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) throw new SampleEvidenceError("remote_sample_coverage_invalid_targets", "snapshot_invalid_targets");
  const timeout = deps.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) throw new SampleEvidenceError("remote_sample_coverage_invalid_budget", "snapshot_invalid_budget");
  const result = (deps.spawnSync || spawnSync)(deps.python || "python3", [
    "-B", resolve(deps.root || ROOT, "tools/coverage/lark-im-coverage-check.py"), "--db", dbPath, "--sample-targets",
  ], { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024, timeout, killSignal: "SIGKILL", env: deps.env || process.env });
  if (result.error || result.signal || result.status !== 0) {
    const code = result.error?.code === "ENOENT" ? "snapshot_dependency_unavailable"
      : result.error?.code === "ETIMEDOUT" ? "snapshot_timeout"
        : result.signal ? "snapshot_process_signal" : "snapshot_execution_failed";
    throw new SampleEvidenceError("remote_sample_coverage_execution_failed", code);
  }
  let output;
  try { output = JSON.parse(result.stdout); }
  catch { throw new SampleEvidenceError("remote_sample_coverage_invalid_output", "snapshot_invalid_json"); }
  if (output?.kind === "lark_im_sample_snapshot/v1" &&
      ["inspection_budget_exhausted", "readonly_inspection_failed"].includes(output.error)) {
    throw new SampleEvidenceError("remote_sample_coverage_invalid_output",
      output.error === "inspection_budget_exhausted" ? "snapshot_budget_exhausted" : "snapshot_read_failed");
  }
  if (!output || output.kind !== "lark_im_sample_snapshot/v1" || output.error
      || !timestamp(output.checked_at_ms, (deps.now || Date.now)())
      || !output.coverage || typeof output.coverage !== "object" || Array.isArray(output.coverage)
      || Object.keys(output.coverage).length !== keys.size || Object.keys(output.coverage).some((key) => !keys.has(key))
      || !Array.isArray(output.records) || output.records.length > targets.length) {
    throw new SampleEvidenceError("remote_sample_coverage_invalid_output", "snapshot_output_schema");
  }
  /** @type {Record<string, SampleCoverageEvidence>} */
  const evidence = {};
  for (const target of targets) {
    const value = output.coverage[target.key];
    if (!value || typeof value.covered !== "boolean" || typeof value.details_pending !== "boolean" || !REASONS.has(value.reason)
        || (value.covered ? value.reason !== "covered" || value.details_pending
          || !timestamp(value.latest_finished_ms, output.checked_at_ms) || value.latest_finished_ms < target.created_ms
          || target.observed_after_ms !== undefined && value.latest_finished_ms <= target.observed_after_ms
          : value.reason === "covered" || value.latest_finished_ms !== null)
        || value.details_pending !== (value.reason === "details_pending")) {
      throw new SampleEvidenceError("remote_sample_coverage_invalid_output", "snapshot_coverage_invariant");
    }
    evidence[target.key] = { covered: value.covered, latest_finished_ms: value.latest_finished_ms,
      details_pending: value.details_pending, reason: value.reason };
  }
  const requested = new Set(targets.map((target) => target.message_id));
  /** @type {Map<string,JsonObject>} */
  const records = new Map();
  let bytes = 0;
  for (const row of output.records) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== RECORD_FIELDS.length
        || Object.keys(row).some((key) => !RECORD_FIELDS.includes(key))
        || !requested.has(row.external_id) || records.has(row.external_id) || row.source_id !== "lark.im"
        || typeof row.record_type !== "string" || typeof row.raw_json !== "string"
        || !["container_id", "external_version", "canonical_json"].every((key) => row[key] === null || typeof row[key] === "string")) {
      throw new SampleEvidenceError("remote_sample_coverage_invalid_output", "snapshot_record_schema");
    }
    for (const field of RECORD_FIELDS) if (typeof row[field] === "string") bytes += Buffer.byteLength(row[field], "utf8");
    if (bytes > MAX_RECORD_BYTES) throw new SampleEvidenceError("remote_sample_coverage_invalid_output", "snapshot_record_budget");
    records.set(row.external_id, Object.fromEntries(RECORD_FIELDS.map((field) => [field, row[field]])));
  }
  return { coverage: evidence, records };
}

/** Coverage-only compatibility for callers that do not compare local records.
 * Never combine this result with records read in a separate snapshot.
 * @param {string} dbPath @param {SampleCoverageTarget[]} targets @param {JsonObject} [deps]
 */
function inspectRemoteSampleCoverage(dbPath, targets, deps = {}) {
  return inspectRemoteSampleSnapshot(dbPath, targets, deps).coverage;
}

export { inspectRemoteSampleCoverage, inspectRemoteSampleSnapshot };
