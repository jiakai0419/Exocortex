import { createHash } from "node:crypto";
import { compareObservation, isNativeRecord, OBSERVATION_POLICY } from "../../core/lark-observation.js";
import { scopeObservationContext } from "../../core/lark-scope-config.js";
import { evaluateObservation } from "./observation-store.js";
import { quoteSql } from "./sqlite-executor.js";
/** Context is based on the existing verified request admission, never on
 * display names, retry metadata or list generations. */
export function pendingDetailContextKey(databaseKey, scope) {
    const admission = scope.writeAdmission;
    if (!/^[a-f0-9]{64}$/.test(databaseKey) || !admission?.requireVerified || !admission.selfOpenId
        || !admission.accountKey || !scope.assertWriteAdmission)
        throw new Error("pending detail needs verified request admission");
    const admittedScope = admission.scopes.find(value => value.id === scope.id);
    if (!admittedScope || admittedScope.source_id !== scope.source_id || admittedScope.enabled !== scope.enabled
        || admittedScope.config_json !== scope.config_json)
        throw new Error("pending detail scope admission changed");
    const scopeContext = scopeObservationContext(admittedScope.config_json);
    return createHash("sha256").update(JSON.stringify({ databaseKey, policy: OBSERVATION_POLICY,
        accountKey: admission.accountKey, sourceConfig: admission.sourceConfigJson,
        scope: { id: scope.id, source_id: scope.source_id, enabled: scope.enabled,
            config_policy: scopeContext.policy, config_json: scopeContext.configJson } })).digest("hex");
}
/** All fields are local snapshots. Check before record insertion in the same
 * run-fenced transaction; a concurrent new record changes the observation owner. */
export function pendingDetailGuardSql(scope, runId, acquisition) {
    const { task, attempt, startedAtMs, databaseKey, contextKey } = acquisition;
    if (attempt !== `detail-run:${runId}` || !Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || startedAtMs > Date.now()
        || contextKey !== pendingDetailContextKey(databaseKey, scope) || task.scope_id !== scope.id || task.status !== "pending"
        || task.record_exists !== 0 || !Number.isSafeInteger(task.descriptor_generation) || !Number.isSafeInteger(task.evidence_generation)) {
        throw new Error("invalid pending detail observation acquisition");
    }
    const fields = ["raw_root_json", "fingerprint", "external_version", "occurred_at_ms", "status", "descriptor_generation", "evidence_generation",
        "candidate_json", "candidate_generation", "candidate_attempt", "candidate_policy", "candidate_context", "candidate_observed_at_ms"];
    return `INSERT INTO __lark_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM lark_im_detail_tasks t
    WHERE t.scope_id=${quoteSql(scope.id)} AND t.message_id=${quoteSql(task.message_id)}
      AND ${fields.map(key => `t.${key} IS ${typeof task[key] === "number" ? task[key] : quoteSql(task[key])}`).join(" AND ")})
    AND NOT EXISTS(SELECT 1 FROM records WHERE source_id=${quoteSql(scope.source_id)} AND external_id=${quoteSql(task.message_id)}) THEN 1 ELSE 0 END;`;
}
export function preparePendingDetailObservation(scope, incoming, acquisition, root) {
    const task = acquisition.task, queued = JSON.parse(task.raw_root_json), raw = JSON.parse(root.raw_json);
    const configuredChat = JSON.parse(scope.config_json || "{}").chat_id;
    const chat = configuredChat || (scope.id === "lark.im.sent_by_me" ? queued.chat_id : null);
    if (!isNativeRecord(incoming) || incoming.source_id !== scope.source_id || incoming.first_seen_scope_id !== scope.id
        || incoming.external_id !== task.message_id || incoming.container_id !== chat
        || queued.chat_id !== chat || raw.chat_id !== chat
        || queued.message_id !== incoming.external_id || raw.message_id !== incoming.external_id
        || incoming.occurred_at_ms !== root.occurred_at_ms || incoming.external_version !== root.external_version) {
        throw new Error("pending detail source identity mismatch");
    }
    const before = { ...incoming, raw_json: task.raw_root_json, external_version: task.external_version,
        occurred_at_ms: task.occurred_at_ms, container_id: queued.chat_id };
    const comparison = compareObservation(before, { ...incoming, raw_json: root.raw_json });
    if (comparison.identity !== "same" || comparison.version === "older"
        || comparison.version === "unordered" && !comparison.equivalent)
        throw new Error("pending detail source identity or version changed");
    // A matching root still needs the normal complete receipt, but no ambiguity
    // confirmation. Compare the full expansion only after a root conflict exists.
    if (comparison.equivalent || root.fingerprint === task.fingerprint || comparison.version === "newer")
        return { accepted: true, evidenceSql: "" };
    if (comparison.version !== "equal" || !/^\d+$/.test(task.external_version || ""))
        throw new Error("pending detail requires an ordered source version");
    const candidate = JSON.stringify(incoming);
    // A complete oversized response cannot be a vote, but may contradict the
    // previous source. Retain its bounded predecessor as inert evidence, invalidate
    // qualification, and consume only this task's normal retry/backoff receipt.
    if (Buffer.byteLength(candidate) > 4 * 1024 * 1024)
        return { accepted: false,
            evidenceSql: `UPDATE lark_im_detail_tasks SET evidence_generation=evidence_generation+1,candidate_generation=NULL
      WHERE scope_id=${quoteSql(scope.id)} AND message_id=${quoteSql(task.message_id)};`,
            failureReason: "detail_evidence_capacity_exceeded" };
    const decision = evaluateObservation(before, incoming, { generation: task.descriptor_generation,
        evidenceGeneration: task.evidence_generation, candidate_json: task.candidate_json, candidate_generation: task.candidate_generation,
        candidate_attempt: task.candidate_attempt, candidate_policy: task.candidate_policy, candidate_context: task.candidate_context,
        candidate_observed_at_ms: task.candidate_observed_at_ms }, { attempt: acquisition.attempt, startedAtMs: acquisition.startedAtMs,
        contextKey: acquisition.contextKey, confirm: true });
    if (decision.action === "accept")
        return { accepted: true, evidenceSql: "" };
    if (decision.preserveCandidate)
        return { accepted: false, evidenceSql: "" };
    return { accepted: false, evidenceSql: `UPDATE lark_im_detail_tasks SET evidence_generation=evidence_generation+1,
    candidate_json=${quoteSql(candidate)},candidate_generation=descriptor_generation,candidate_attempt=${quoteSql(acquisition.attempt)},
    candidate_policy=${quoteSql(OBSERVATION_POLICY)},candidate_context=${quoteSql(acquisition.contextKey)},candidate_observed_at_ms=${Date.now()}
    WHERE scope_id=${quoteSql(scope.id)} AND message_id=${quoteSql(task.message_id)};` };
}
