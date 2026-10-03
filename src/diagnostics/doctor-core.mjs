// @ts-check

/**
 * @typedef {object} CommandResult
 * @property {string=} stdout
 * @property {string=} stderr
 *
 * @typedef {object} LocalStatus
 * @property {string=} status
 * @property {string=} health
 * @property {string=} health_detail
 *
 * @typedef {object} LocalQuality
 * @property {string=} status
 * @property {{missing_sender_name?: number, missing_user_sender_name?: number, missing_app_sender_name?: number, actionable_missing_sender_name?: number, missing_chat_name?: number, invalid_rendered_body?: number}=} quality
 *
 * @typedef {object} LiveResult
 * @property {boolean | null=} ok
 * @property {string=} status
 * @property {number=} exit_status
 * @property {string=} stdout
 * @property {string=} stderr
 * @property {string=} reason
 * @property {string=} hint
 * @property {string=} scope
 * @property {string=} auth_identity
 * @property {number=} missing_count
 * @property {{remote_messages_checked?: number, probe_errors?: number}=} probe
 * @property {{start?: string, end?: string}=} window
 *
 * @typedef {object} DoctorState
 * @property {LocalStatus} status
 * @property {LocalQuality} quality
 * @property {LiveResult | null=} live
 *
 * @typedef {"needs_attention" | "delayed" | "syncing" | "catching_up" | "not_ready" | "unknown" | "local_ready" | "sampled"} OverallStatus
 */

/** @param {CommandResult | null | undefined} result */
function textFromCommandFailure(result) {
  return `${result?.stderr || ""}\n${result?.stdout || ""}`;
}

/** @param {unknown} text */
function isKeychainUnavailable(text) {
  return /keychain Get failed: keychain not initialized|keychain not initialized|system Keychain is reachable|keychain-downgrade/i.test(
    String(text || ""),
  );
}

/**
 * @param {LiveResult | null | undefined} live
 * @returns {LiveResult | null}
 */
function normalizeLiveResult(live) {
  if (!live) return null;
  if (
    live.status === "command_failed" &&
    (live.reason === "keychain_unavailable" || isKeychainUnavailable(textFromCommandFailure(live)))
  ) {
    return {
      ...live,
      status: "unavailable",
      reason: "keychain_unavailable",
      ok: null,
      hint:
        "Live probe could not access lark-cli keychain from this shell. The background service can still be healthy.",
    };
  }
  return live;
}

/** @param {DoctorState} state */
function actionableMissingSenderNames(state) {
  const q = state.quality.quality || {};
  if (q.actionable_missing_sender_name !== undefined && q.actionable_missing_sender_name !== null) {
    return Number(q.actionable_missing_sender_name || 0);
  }
  return Number(q.missing_user_sender_name || 0) + Number(q.missing_app_sender_name || 0);
}

/** @param {DoctorState} state */
function hasActionableQualityIssues(state) {
  const q = state.quality.quality || {};
  return (
    actionableMissingSenderNames(state) > 0 ||
    Number(q.missing_chat_name || 0) > 0 ||
    Number(q.invalid_rendered_body || 0) > 0
  );
}

/** @param {DoctorState} state */
function buildFindings({ status, quality, live }) {
  /** @type {string[]} */
  const findings = [];
  const missingSenderName = actionableMissingSenderNames({ status, quality, live });
  const missingChatName = Number(quality.quality?.missing_chat_name || 0);
  const invalidRenderedBody = Number(quality.quality?.invalid_rendered_body || 0);
  if (status.status === "command_failed") findings.push("local status command failed");
  if (quality.status === "command_failed") findings.push("local quality command failed");
  if (status.health === "syncing") findings.push("worker is currently syncing");
  if (status.health === "catching_up") findings.push(status.health_detail || "initial catch-up is still in progress");
  if (status.health === "not_ready") findings.push("initial discovery or successful message-scope evidence is missing");
  if (status.health === "needs_attention") findings.push("local sync state needs attention");
  if (!["syncing", "catching_up", "not_ready", "needs_attention", "ok", "ok_with_history"].includes(status.health || "")) {
    findings.push("local sync state is unknown");
  }
  if (missingSenderName > 0) findings.push("some senders still lack display names");
  if (missingChatName > 0) findings.push("some group messages still lack chat names");
  if (invalidRenderedBody > 0) findings.push("some messages still have invalid rendered bodies");
  if (live?.status === "delayed") findings.push("remote hot messages are not fully present locally yet");
  if (live?.status === "needs_attention") findings.push("live lag probe had remote API errors");
  if (live?.status === "command_failed") findings.push("live lag probe could not run");
  if (live?.status === "inconclusive") findings.push("live lag probe did not obtain a usable remote sample");
  if (live?.status === "unavailable") findings.push("live lag probe unavailable in this shell");
  if (live?.status === "healthy" && !(Number(live.probe?.remote_messages_checked) > 0)) {
    findings.push("live lag probe has no usable message sample");
  }
  return findings;
}

/**
 * @param {DoctorState} state
 * @returns {OverallStatus}
 */
function overallStatus({ status, quality, live }) {
  const state = { status, quality, live };
  if (status.status === "command_failed" || quality.status === "command_failed") return "needs_attention";
  if (status.health === "needs_attention") return "needs_attention";
  if (
    live?.status === "needs_attention" ||
    live?.status === "command_failed" ||
    live?.status === "inconclusive"
  ) return "needs_attention";
  if (hasActionableQualityIssues(state)) return "needs_attention";
  if (live?.status === "delayed") return "delayed";
  if (status.health === "syncing") return "syncing";
  if (status.health === "catching_up") return "catching_up";
  if (status.health === "not_ready") return "not_ready";
  if (!["ok", "ok_with_history"].includes(status.health || "")) return "unknown";
  if (live?.status === "healthy") {
    const start = Date.parse(String(live.window?.start || ""));
    const end = Date.parse(String(live.window?.end || ""));
    return live.ok === true && Number.isSafeInteger(live.probe?.remote_messages_checked) && Number(live.probe?.remote_messages_checked) > 0
      && live.missing_count === 0 && Number(live.probe?.probe_errors || 0) === 0
      && Number.isFinite(start) && Number.isFinite(end) && start < end
      ? "sampled" : "unknown";
  }
  return "local_ready";
}

export {
  actionableMissingSenderNames,
  buildFindings,
  hasActionableQualityIssues,
  isKeychainUnavailable,
  normalizeLiveResult,
  overallStatus,
};
