function textFromCommandFailure(result) {
  return `${result?.stderr || ""}\n${result?.stdout || ""}`;
}

function isKeychainUnavailable(text) {
  return /keychain Get failed: keychain not initialized|keychain not initialized|system Keychain is reachable|keychain-downgrade/i.test(
    String(text || ""),
  );
}

function normalizeLiveResult(live) {
  if (!live) return null;
  if (live.status === "command_failed" && isKeychainUnavailable(textFromCommandFailure(live))) {
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

function buildFindings({ status, quality, live }) {
  const findings = [];
  if (status.status === "command_failed") findings.push("local status command failed");
  if (quality.status === "command_failed") findings.push("local quality command failed");
  if (status.health === "syncing") findings.push("worker is currently syncing");
  if (status.health === "catching_up") findings.push(status.health_detail || "initial catch-up is still in progress");
  if (quality.quality?.missing_sender_name > 0) findings.push("some senders still lack display names");
  if (quality.quality?.invalid_rendered_body > 0) findings.push("some messages still have invalid rendered bodies");
  if (live?.status === "delayed") findings.push("remote hot messages are not fully present locally yet");
  if (live?.status === "needs_attention") findings.push("live lag probe had remote API errors");
  if (live?.status === "command_failed") findings.push("live lag probe could not run");
  if (live?.status === "unavailable") findings.push("live lag probe unavailable in this shell");
  return findings;
}

function overallStatus({ status, quality, live }) {
  if (status.status === "command_failed" || quality.status === "command_failed") return "needs_attention";
  if (live?.status === "needs_attention" || live?.status === "command_failed") return "needs_attention";
  if (live?.status === "delayed") return "delayed";
  if (status.health === "syncing") return "syncing";
  if (status.health === "catching_up") return "catching_up";
  if (quality.quality?.missing_sender_name > 0 || quality.quality?.invalid_rendered_body > 0) {
    return "needs_attention";
  }
  return "fresh";
}

export {
  buildFindings,
  isKeychainUnavailable,
  normalizeLiveResult,
  overallStatus,
};
