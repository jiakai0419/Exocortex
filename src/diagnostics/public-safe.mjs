// @ts-check

const PUBLIC_UNSUPPORTED_REASONS = new Set([
  "bot_user_out_of_chat",
  "restricted_mode",
]);

const PUBLIC_MESSAGE_TYPES = new Set([
  "audio",
  "calendar",
  "file",
  "folder",
  "general_calendar",
  "hongbao",
  "image",
  "interactive",
  "location",
  "media",
  "merge_forward",
  "post",
  "share_chat",
  "share_user",
  "sticker",
  "system",
  "text",
  "todo",
  "video_chat",
  "vote",
]);

const PUBLIC_FAILURE_KINDS = new Set([
  "command_unavailable",
  "internal_error",
  "network_error",
  "network_timeout",
  "permission_denied",
  "rate_limited",
  "service_unavailable",
  "spawn_error",
  "unknown",
]);

/** @param {unknown} value */
function publicUnsupportedReason(value) {
  const reason = String(value || "");
  return PUBLIC_UNSUPPORTED_REASONS.has(reason) ? reason : "unsupported";
}

/** @param {unknown} value */
function publicErrorCode(value) {
  if (value === null || value === undefined || value === "") return null;
  const code = Number(value);
  return Number.isSafeInteger(code) && code >= 0 ? code : null;
}

/** @param {unknown} value */
function publicFailureKind(value) {
  const kind = String(value || "unknown");
  return PUBLIC_FAILURE_KINDS.has(kind) ? kind : "unknown";
}

/** @param {unknown} value */
function publicTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  const parsed = typeof value === "number" || /^\d{10,}$/.test(text)
    ? Number(value)
    : Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** @param {Array<Record<string, any>> | null | undefined} rows */
function publicUnsupportedReasons(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const reason = publicUnsupportedReason(row.reason);
    const errorCode = publicErrorCode(row.lark_cli_error_code ?? row.error_code);
    const key = `${reason}:${errorCode ?? ""}`;
    const current = grouped.get(key) || { reason, error_code: errorCode, count: 0 };
    current.count += Math.max(0, Number(row.count || 0));
    grouped.set(key, current);
  }
  return [...grouped.values()].sort(
    (left, right) => right.count - left.count || left.reason.localeCompare(right.reason),
  );
}

/** @param {Array<Record<string, any>> | null | undefined} rows */
function publicMessageTypes(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const candidate = String(row.msg_type || "");
    const msgType = PUBLIC_MESSAGE_TYPES.has(candidate) ? candidate : "other";
    grouped.set(msgType, Number(grouped.get(msgType) || 0) + Math.max(0, Number(row.count || 0)));
  }
  return [...grouped.entries()]
    .map(([msg_type, count]) => ({ msg_type, count }))
    .sort((left, right) => right.count - left.count || left.msg_type.localeCompare(right.msg_type));
}

/** @param {unknown} text */
function publicCommandFailureReason(text) {
  const message = String(text || "");
  if (["keychain_unavailable", "database_not_found", "dependency_unavailable", "command_failed"].includes(message)) {
    return message;
  }
  if (/keychain Get failed: keychain not initialized|keychain not initialized|keychain-downgrade/i.test(message)) {
    return "keychain_unavailable";
  }
  if (/database not found/i.test(message)) return "database_not_found";
  if (/required dependency unavailable|ENOENT|not found|command not found/i.test(message)) {
    return "dependency_unavailable";
  }
  return "command_failed";
}

/**
 * Preserve only a small, actionable error vocabulary at public diagnostic
 * boundaries. The original error may contain local paths, remote identifiers,
 * request URLs, or message excerpts.
 * @param {unknown} error
 * @param {string} fallback
 */
function publicDiagnosticError(error, fallback) {
  const message = String(error instanceof Error ? error.message : error || "");
  const reason = publicCommandFailureReason(message);
  if (reason === "keychain_unavailable") return new Error("keychain not initialized");
  if (reason === "database_not_found") return new Error("database not found");
  if (reason === "dependency_unavailable") return new Error("required dependency unavailable");
  return new Error(fallback);
}

/**
 * Convert child-process failures to a small diagnostic vocabulary. Never copy
 * stderr through this boundary because it may contain paths, URLs, tokens, or
 * remote record details.
 * @param {Record<string, any>} result
 * @param {string} label
 */
function diagnosticSubprocessError(result, label) {
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (result?.error);
  if (error?.code === "ENOENT") return new Error("required dependency unavailable");
  if (error?.code === "ETIMEDOUT" || result?.signal === "SIGKILL") {
    return new Error(`${label} timed out`);
  }
  return new Error(`${label} failed`);
}

export {
  publicCommandFailureReason,
  publicDiagnosticError,
  publicErrorCode,
  publicFailureKind,
  publicMessageTypes,
  publicTimestamp,
  publicUnsupportedReason,
  publicUnsupportedReasons,
  diagnosticSubprocessError,
};
