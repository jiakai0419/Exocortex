// @ts-check

import { spawnSync } from "node:child_process";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {"network_timeout" | "network_error" | "rate_limited" | "service_unavailable" | "internal_error" | "restricted_mode" | "bot_user_out_of_chat" | "command_unavailable" | "spawn_error" | "unknown"} LarkFailureKind
 *
 * @typedef {object} LarkFailureClassification
 * @property {LarkFailureKind} kind
 * @property {boolean} transient
 * @property {number | null} code
 * @property {string} message
 *
 * @typedef {object} AdapterRunOptions
 * @property {string[]=} redactedFlags
 * @property {number=} retries
 * @property {number=} retryDelayMs
 * @property {number=} timeoutMs
 *
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} SpawnResult
 *
 * @typedef {object} TransportDeps
 * @property {string=} bin
 * @property {number=} timeoutMs
 * @property {(cmd: string, args: string[], options: {encoding: BufferEncoding, maxBuffer: number, timeout: number, killSignal: NodeJS.Signals}) => SpawnResult} [spawn]
 * @property {(ms: number) => void} [sleep]
 *
 * @typedef {(args: string[], options?: AdapterRunOptions) => JsonObject | null} LarkRunner
 */

const DEFAULT_LARK_CLI_TIMEOUT_MS = 120_000;

/**
 * @param {string} stdout
 * @returns {JsonObject | null}
 */
function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`lark-cli returned non-JSON output: ${message}`);
  }
}

/**
 * @param {string[]} args
 * @param {string[]} [redactedFlags]
 */
function redactCommand(args, redactedFlags = []) {
  const parts = ["lark-cli", ...args];
  for (const flag of redactedFlags) {
    const index = parts.indexOf(flag);
    if (index >= 0 && index + 1 < parts.length) parts[index + 1] = "<redacted>";
  }
  return parts.join(" ");
}

/** @param {number} ms */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {unknown} stderr
 * @returns {JsonObject | null}
 */
function parseLarkError(stderr) {
  const text = String(stderr || "");
  const candidates = [text.trim()];
  const firstBrace = text.indexOf("{");
  if (firstBrace >= 0) candidates.push(text.slice(firstBrace).trim());
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.error && typeof parsed.error === "object") return parsed.error;
    } catch {
      // Keep trying looser candidates.
    }
  }
  return null;
}

/** @param {unknown} stderr */
function classifyLarkFailure(stderr) {
  const text = String(stderr || "");
  const publicKind = text.match(
    /\bkind=(network_timeout|network_error|rate_limited|service_unavailable|internal_error|restricted_mode|bot_user_out_of_chat|command_unavailable|spawn_error|unknown)\b/,
  )?.[1];
  const publicCode = text.match(/\bcode=(\d+)\b/)?.[1];
  if (publicKind) {
    return {
      kind: /** @type {LarkFailureKind} */ (publicKind),
      transient: ["network_timeout", "network_error", "rate_limited", "service_unavailable", "internal_error"].includes(publicKind),
      code: publicCode ? Number(publicCode) : null,
      message: publicKind.replaceAll("_", " "),
    };
  }
  if (/TLS handshake timeout|Client\.Timeout|timeout awaiting response headers|i\/o timeout|\bETIMEDOUT\b/i.test(text)) {
    return {
      kind: /** @type {LarkFailureKind} */ ("network_timeout"),
      transient: true,
      code: null,
      message: "network timeout",
    };
  }
  const error = parseLarkError(stderr);
  const code = Number.isFinite(Number(error?.code)) ? Number(error?.code) : null;
  const message = String(error?.message || "");
  if (code === 231203 || /Restricted Mode|don't allow copying or forwarding messages/i.test(text)) {
    return {
      kind: /** @type {LarkFailureKind} */ ("restricted_mode"),
      transient: false,
      code,
      message: "restricted mode",
    };
  }
  if (code === 230002 || /Bot\/User can NOT be out of the chat/i.test(text)) {
    return {
      kind: /** @type {LarkFailureKind} */ ("bot_user_out_of_chat"),
      transient: false,
      code,
      message: "bot or user is not in the chat",
    };
  }
  if (error?.type === "network" && error?.subtype === "timeout") {
    return {
      kind: /** @type {LarkFailureKind} */ ("network_timeout"),
      transient: true,
      code,
      message,
    };
  }
  if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|socket hang up|connection reset|unexpected EOF/i.test(text)) {
    return {
      kind: /** @type {LarkFailureKind} */ ("network_error"),
      transient: true,
      code,
      message: "network error",
    };
  }
  if (error?.type === "api" && (code === 9499 || /too many request/i.test(message))) {
    return {
      kind: /** @type {LarkFailureKind} */ ("rate_limited"),
      transient: true,
      code,
      message,
    };
  }
  if (
    (error?.type === "api" && (code === 2200 || code === 1663) && /Internal Error/i.test(message)) ||
    /\b(?:502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Timeout|temporarily unavailable/i.test(text)
  ) {
    const serviceUnavailable = !(error?.type === "api" && (code === 2200 || code === 1663));
    return {
      kind: /** @type {LarkFailureKind} */ (serviceUnavailable ? "service_unavailable" : "internal_error"),
      transient: true,
      code,
      message: serviceUnavailable ? "service unavailable" : message || "internal error",
    };
  }
  return {
    kind: /** @type {LarkFailureKind} */ ("unknown"),
    transient: false,
    code,
    message,
  };
}

/** @param {SpawnResult | null} result */
function spawnFailureText(result) {
  if (!result) return "";
  const spawnError = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  return [String(result.stderr || ""), spawnError?.code || "", spawnError?.message || ""].filter(Boolean).join("\n");
}

/**
 * Keep command failures useful without copying remote stderr payloads (which
 * can contain tenant ids, chat ids, request bodies, or tokens) into run history.
 *
 * @param {SpawnResult | null} result
 * @param {number} timeoutMs
 */
function publicFailureDescriptor(result, timeoutMs) {
  const spawnError = /** @type {NodeJS.ErrnoException | undefined} */ (result?.error);
  if (spawnError?.code === "ENOENT") return "kind=command_unavailable spawn_code=ENOENT";
  if (spawnError?.code === "ETIMEDOUT") return `kind=network_timeout timeout_ms=${timeoutMs}`;
  const classification = classifyLarkFailure(spawnFailureText(result));
  const parts = [`kind=${classification.kind}`];
  if (classification.code !== null) parts.push(`code=${classification.code}`);
  if (spawnError?.code) parts.push(`spawn_code=${spawnError.code}`);
  if (result?.signal) parts.push(`signal=${result.signal}`);
  return parts.join(" ");
}

/** @param {unknown} stderr */
function isTransientLarkFailure(stderr) {
  return classifyLarkFailure(stderr).transient;
}

/**
 * @param {number} attempt
 * @param {number} baseDelayMs
 */
function retryDelayForAttempt(attempt, baseDelayMs) {
  return Math.min(30_000, Math.max(0, Number(baseDelayMs)) * 2 ** Math.max(0, Number(attempt)));
}

/**
 * @param {TransportDeps} [deps]
 * @returns {LarkRunner}
 */
function createLarkCliRunner({
  bin = process.env.LARK_CLI || "lark-cli",
  spawn = spawnSync,
  sleep = sleepMs,
  timeoutMs: defaultTimeoutMs = DEFAULT_LARK_CLI_TIMEOUT_MS,
} = {}) {
  return function runLark(args, options = {}) {
    const retries = Number(options.retries ?? 0);
    const retryDelayMs = Number(options.retryDelayMs ?? 1000);
    const requestedTimeoutMs = Number(options.timeoutMs ?? defaultTimeoutMs);
    const timeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : DEFAULT_LARK_CLI_TIMEOUT_MS;
    /** @type {SpawnResult | null} */
    let lastResult = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = spawn(bin, args, {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
      lastResult = result;
      if (result.status === 0) return parseJson(result.stdout || "");
      const failureText = spawnFailureText(result);
      if (attempt < retries && isTransientLarkFailure(failureText)) {
        sleep(retryDelayForAttempt(attempt, retryDelayMs));
        continue;
      }
      break;
    }
    throw new Error(
      `${redactCommand(args, options.redactedFlags)} failed: ${publicFailureDescriptor(lastResult, timeoutMs)}`,
    );
  };
}

const runLark = createLarkCliRunner();

export {
  DEFAULT_LARK_CLI_TIMEOUT_MS,
  classifyLarkFailure,
  createLarkCliRunner,
  isTransientLarkFailure,
  parseLarkError,
  parseJson,
  publicFailureDescriptor,
  redactCommand,
  retryDelayForAttempt,
  runLark,
  sleepMs,
};
