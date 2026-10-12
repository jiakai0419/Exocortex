// @ts-check
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SampleEvidenceError } from "./remote-sample-diagnostic.mjs";
import { chatScopeId } from "../adapters/lark-im/core.mjs";
import { digest, epoch, sampleScopeHash } from "./remote-sample-core.mjs";
import { scopeObservationContext } from "../maintenance/scope-config-policy.mjs";

/** @typedef {{key:string,scope_id:string,message_id:string,created_ms:number,observed_after_ms?:number,expected_chat_id?:string}} SampleCoverageTarget */
/** @typedef {{covered:boolean,latest_finished_ms:number|null,details_pending:boolean,reason:string}} SampleCoverageEvidence */
/** @typedef {Record<string, any>} JsonObject */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_TARGETS = 200;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const RECORD_FIELDS = ["external_id", "source_id", "record_type", "container_id", "external_version", "raw_json", "canonical_json"];
const MIN_EPOCH_MS = 100_000_000_000;
const HASH = /^[a-f0-9]{64}$/;
const REASONS = new Set(["covered", "no_covering_run", "source_unavailable", "scope_unavailable",
  "before_sync_baseline", "detail_evidence_unavailable", "details_pending", "inspection_budget_exhausted", "readonly_inspection_failed"]);

/** @param {unknown} value @param {number} now */
function timestamp(value, now) {
  return Number.isSafeInteger(value) && Number(value) >= MIN_EPOCH_MS && Number(value) <= now;
}

/** This is a local acquisition-order fence, not a server-time/latest claim.
 * All database metadata below comes from the record comparison transaction.
 * @param {JsonObject} request @param {SampleCoverageTarget[]} targets @param {number} now */
function verificationRequest(request, targets, now) {
  if (!request || !HASH.test(request.binding?.database_key) || !HASH.test(request.binding?.account_key)
      || !request.observations || typeof request.observations !== 'object' || Array.isArray(request.observations)
      || !request.acquisitions || typeof request.acquisitions !== 'object' || Array.isArray(request.acquisitions)
      || Object.keys(request.acquisitions).length > MAX_TARGETS || !Array.isArray(request.requiredKeys)
      || request.requiredKeys.length > MAX_TARGETS || new Set(request.requiredKeys).size !== request.requiredKeys.length
      || Object.entries(request.acquisitions).some(([key, at]) => !HASH.test(key) || !timestamp(at, now) ||
        !Object.hasOwn(request.observations, key) || !request.observations[key])
      || request.requiredKeys.some(key => !Object.hasOwn(request.acquisitions, key))) {
    throw new SampleEvidenceError('remote_sample_coverage_invalid_targets', 'snapshot_invalid_verification');
  }
  return targets.filter(target => Object.hasOwn(request.acquisitions, target.key)).map(target => target.key);
}

/** Never interpret an invalid/mismatched existing ticket as an absent one.
 * Ordinary calls without verification retain their original schema/behavior.
 * @param {JsonObject} request @param {string[]} keys @param {JsonObject} metadata
 * @param {SampleCoverageTarget[]} targets @param {number} now */
function verificationFence(request, keys, metadata, targets, now) {
  const all = Object.keys(request.acquisitions);
  const invalid = () => { throw new SampleEvidenceError('remote_sample_coverage_invalid_output', 'snapshot_verification_schema'); };
  if (!metadata || !Array.isArray(metadata.rows) || !['ready', 'unavailable'].includes(metadata.status)) return invalid();
  if (metadata.status === 'unavailable') {
    if (metadata.rows.length) return invalid();
    return { status: 'ready', blockedKeys: all };
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_RECORD_BYTES + 128 * 1024 ||
      metadata.rows.length !== keys.length || new Set(metadata.rows.map(row => row?.key)).size !== keys.length ||
      metadata.rows.some(row => !row || !keys.includes(row.key) || !Object.hasOwn(row, 'ticket') ||
        !Object.hasOwn(row, 'record') || !Object.hasOwn(row, 'scope'))) return invalid();
  const blocked = new Set(all.filter(key => !keys.includes(key)));
  const required = new Set(request.requiredKeys);
  for (const row of metadata.rows) {
    const { key, record, scope, ticket } = row;
    const target = targets.find(target => target.key === key);
    if (!target) { blocked.add(key); continue; }
    const observation = request.observations[key];
    const source = metadata.source;
    try {
      // A missing local record can still be compared by the ordinary missing
      // reducer, but never supplies acceptance proof for a required ticket.
      if (!source || source.id !== 'lark.im' || source.enabled !== 1 ||
          !scope || scope.id !== target.scope_id || scope.source_id !== 'lark.im' || scope.enabled !== 1 ||
          typeof source.config_json !== 'string' || typeof scope.config_json !== 'string') throw new Error();
      const sourceConfig = JSON.parse(source.config_json); const scopeConfig = JSON.parse(scope.config_json);
      const chat = scopeConfig?.chat_id;
      if (typeof chat !== 'string' || scopeConfig.unsupported_reason || scope.id !== chatScopeId(chat) ||
          target.expected_chat_id !== undefined && target.expected_chat_id !== chat ||
          epoch(sourceConfig?.initial_sync_start_ms) === null || target.created_ms < sourceConfig.initial_sync_start_ms ||
          target.created_ms !== observation.target ||
          digest([request.binding.database_key, request.binding.account_key, chat, target.message_id, target.created_ms]) !== key ||
          observation.scope_hash && observation.scope_hash !== sampleScopeHash(request.binding, chat)) throw new Error();
      if (record && (record.external_id !== target.message_id || record.source_id !== 'lark.im' ||
          record.record_type !== 'lark.im.message' || record.container_id !== chat || record.occurred_at_ms !== target.created_ms ||
          record.candidate_present === 1 || record.history_error_present === 1)) throw new Error();
      if (ticket === null) {
        if (required.has(key)) blocked.add(key);
        continue;
      }
      if (!ticket || !record || !Number.isSafeInteger(record.id) || record.id < 1 ||
          !Number.isSafeInteger(record.generation) || record.generation < 0 ||
          record.candidate_present !== 0 || record.history_error_present !== 0 ||
          ticket.record_id !== record.id || ticket.finding_key !== key ||
          ticket.database_key !== request.binding.database_key || ticket.account_key !== request.binding.account_key ||
          ticket.scope_id !== scope.id ||
          digest({ source: source.config_json, scope: scope.id, policy: scopeObservationContext(scope.config_json) }) !== ticket.context_fingerprint) throw new Error();
      const debts = observation.debts || (observation.kind === 'version' ? { version: 0 } :
        observation.kind === 'missing' ? { missing: observation.first_seen } : { legacy_content: 0 });
      if (digest(Object.fromEntries(Object.entries(debts).sort(([a], [b]) => a.localeCompare(b)))) !== ticket.debt_fingerprint) throw new Error();
      // mergeHistoryDebtHints initializes a new ready queue row with NULL/0;
      // it is not an accepted ticket. Preserve ordinary positive comparisons
      // only for this fully bound no-ticket shape, never recent admission.
      if (!required.has(key) && ticket.status === 'ready' && ticket.verification_generation === null &&
          ticket.verification_requested_at_ms === 0) continue;
      if (ticket.status !== 'awaiting_verification' || ticket.verification_generation !== record.generation ||
          !timestamp(ticket.verification_requested_at_ms, now) || ticket.verification_requested_at_ms > request.acquisitions[key]) throw new Error();
    } catch { blocked.add(key); }
  }
  return { status: 'ready', blockedKeys: [...blocked] };
}

/** The sole coverage algorithm lives in Python. Coverage and private records
 * come from one read-only SQLite transaction. The returned records are internal
 * comparison input and must never be included in public reports or logs.
 * @param {string} dbPath
 * @param {SampleCoverageTarget[]} targets
 * @param {JsonObject} [deps]
 * @returns {{coverage:Record<string, SampleCoverageEvidence>, records:Map<string,JsonObject>, verification?:{status:string,blockedKeys:string[]}}}
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
        || Object.hasOwn(target, "expected_chat_id") && (typeof target.expected_chat_id !== 'string' || !target.expected_chat_id.trim() ||
          target.expected_chat_id.length > 512 || /[\u0000-\u001f\u007f]/u.test(target.expected_chat_id))
        || Object.keys(target).some((key) => !["key", "scope_id", "message_id", "created_ms", "observed_after_ms", "expected_chat_id"].includes(key))) {
      throw new SampleEvidenceError("remote_sample_coverage_invalid_targets", "snapshot_invalid_targets");
    }
    keys.add(target.key);
  }
  const verificationKeys = deps.verification === undefined ? null : verificationRequest(deps.verification, targets, now);
  if (targets.length === 0) return { coverage: {}, records: new Map(), ...(verificationKeys === null ? {} :
    { verification: { status: 'ready', blockedKeys: Object.keys(deps.verification.acquisitions) } }) };
  const input = JSON.stringify({ targets, ...(verificationKeys === null ? {} : { verification_keys: verificationKeys }) });
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
  return { coverage: evidence, records, ...(verificationKeys === null ? {} :
    { verification: verificationFence(deps.verification, verificationKeys, output.verification, targets, output.checked_at_ms) }) };
}

/** Coverage-only compatibility for callers that do not compare local records.
 * Never combine this result with records read in a separate snapshot.
 * @param {string} dbPath @param {SampleCoverageTarget[]} targets @param {JsonObject} [deps]
 */
function inspectRemoteSampleCoverage(dbPath, targets, deps = {}) {
  return inspectRemoteSampleSnapshot(dbPath, targets, deps).coverage;
}

export { inspectRemoteSampleCoverage, inspectRemoteSampleSnapshot };
