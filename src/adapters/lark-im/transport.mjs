// @ts-check

import { spawnSync } from "node:child_process";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {"network_timeout" | "rate_limited" | "internal_error" | "unknown"} LarkFailureKind
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
 *
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} SpawnResult
 *
 * @typedef {object} TransportDeps
 * @property {string=} bin
 * @property {(cmd: string, args: string[], options: {encoding: BufferEncoding, maxBuffer: number}) => SpawnResult} [spawn]
 * @property {(ms: number) => void} [sleep]
 *
 * @typedef {(args: string[], options?: AdapterRunOptions) => JsonObject | null} LarkRunner
 */

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
  if (/TLS handshake timeout|Client\.Timeout|timeout awaiting response headers|i\/o timeout/i.test(text)) {
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
  if (error?.type === "network" && error?.subtype === "timeout") {
    return {
      kind: /** @type {LarkFailureKind} */ ("network_timeout"),
      transient: true,
      code,
      message,
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
  if (error?.type === "api" && code === 2200 && /Internal Error/i.test(message)) {
    return {
      kind: /** @type {LarkFailureKind} */ ("internal_error"),
      transient: true,
      code,
      message,
    };
  }
  return {
    kind: /** @type {LarkFailureKind} */ ("unknown"),
    transient: false,
    code,
    message,
  };
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
function createLarkCliRunner({ bin = process.env.LARK_CLI || "lark-cli", spawn = spawnSync, sleep = sleepMs } = {}) {
  return function runLark(args, options = {}) {
    const retries = Number(options.retries ?? 0);
    const retryDelayMs = Number(options.retryDelayMs ?? 1000);
    /** @type {SpawnResult | null} */
    let lastResult = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = spawn(bin, args, {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      });
      lastResult = result;
      if (result.status === 0) return parseJson(result.stdout || "");
      const stderr = result.stderr.trim();
      if (attempt < retries && isTransientLarkFailure(stderr)) {
        sleep(retryDelayForAttempt(attempt, retryDelayMs));
        continue;
      }
      break;
    }
    const stderr = lastResult?.stderr?.trim() || "";
    throw new Error(`${redactCommand(args, options.redactedFlags)} failed: ${stderr}`);
  };
}

const runLark = createLarkCliRunner();

export {
  classifyLarkFailure,
  createLarkCliRunner,
  isTransientLarkFailure,
  parseLarkError,
  parseJson,
  redactCommand,
  retryDelayForAttempt,
  runLark,
  sleepMs,
};
