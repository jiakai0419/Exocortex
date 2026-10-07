// @ts-check

import { spawnSync } from "node:child_process";
import { getLarkApiLeaseStdio, readSharedLarkCooldown, writeSharedLarkCooldown } from "../../runtime/lark-api-lease.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 * @typedef {"network_timeout" | "network_error" | "rate_limited" | "service_unavailable" | "internal_error" | "restricted_mode" | "bot_user_out_of_chat" | "permission_denied" | "command_unavailable" | "spawn_error" | "unknown"} LarkFailureKind
 * @typedef {"message_history_bundle" | "message_search_bundle" | "chat_discovery_bundle" | "self_profile" | "contact_search" | "chat_members" | "chat_bots" | "application_info" | "other"} TransportOperation
 * @typedef {{kind: LarkFailureKind, transient: boolean, code: number | null, message: string, retry_after_ms: number | null}} LarkFailureClassification
 * @typedef {{calls: number, attempts: number, retries: number, rate_limits: number, timeouts: number, wait_ms: number, max_retry_after_ms: number, cooldown_until_ms: number, exhausted: number, retry_after_unknown: number}} TransportCounters
 * @typedef {{stats: Map<TransportOperation, TransportCounters>, cooldowns: Map<TransportOperation, number>, rateStreaks: Map<TransportOperation, number>}} TransportState
 * @typedef {object} AdapterRunOptions
 * @property {string[]=} redactedFlags
 * @property {number=} retries
 * @property {number=} retryDelayMs
 * @property {number=} timeoutMs
 * @property {number=} retryBudgetMs Total time for attempts and waits, including an inherited cooldown.
 * @property {number=} maxBufferBytes Optional smaller subprocess output limit; cannot exceed the default.
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} SpawnResult
 * @typedef {object} TransportDeps
 * @property {string=} bin
 * @property {number=} timeoutMs
 * @property {(cmd: string, args: string[], options: {encoding: BufferEncoding, maxBuffer: number, timeout: number, killSignal: NodeJS.Signals}) => SpawnResult} [spawn]
 * @property {(ms: number) => void} [sleep]
 * @property {() => number} [clock] Epoch milliseconds for durable operation cooldowns.
 * @property {() => number} [monotonicClock] Elapsed milliseconds for operation budgets and ordinary backoff.
 * @property {TransportState=} state
 * @property {typeof readSharedLarkCooldown=} readSharedCooldown
 * @property {typeof writeSharedLarkCooldown=} writeSharedCooldown
 * @typedef {(args: string[], options?: AdapterRunOptions) => JsonObject | null} LarkRunner
 */

const DEFAULT_LARK_CLI_TIMEOUT_MS = 120_000;
const DEFAULT_LARK_RETRY_BUDGET_MS = 180_000;
const MAX_LARK_RETRIES = 10;
const MAX_LARK_BUFFER_BYTES = 50 * 1024 * 1024;
const FALLBACK_RATE_LIMIT_DELAY_MS = 30_000;
/** @type {readonly TransportOperation[]} */
const TRANSPORT_OPERATIONS = Object.freeze([
  "message_history_bundle", "message_search_bundle", "chat_discovery_bundle",
  "self_profile", "contact_search", "chat_members", "chat_bots", "application_info", "other",
]);

/** @returns {TransportCounters} */
function emptyCounters() {
  return { calls: 0, attempts: 0, retries: 0, rate_limits: 0, timeouts: 0, wait_ms: 0,
    max_retry_after_ms: 0, cooldown_until_ms: 0, exhausted: 0, retry_after_unknown: 0 };
}

/**
 * Only fixed operation names and future integer timestamps cross process boundaries.
 * Invalid inherited data is ignored; no files or credentials are read.
 * @param {string} [cooldownsJson]
 * @param {number} [nowMs]
 * @returns {TransportState}
 */
function createTransportState(cooldownsJson = "", nowMs = Date.now()) {
  /** @type {TransportState} */
  const state = { stats: new Map(), cooldowns: new Map(), rateStreaks: new Map() };
  if (!cooldownsJson || cooldownsJson.length > 16_384) return state;
  try {
    const parsed = JSON.parse(cooldownsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return state;
    for (const operation of TRANSPORT_OPERATIONS) {
      const value = Object.hasOwn(parsed, operation) ? parsed[operation] : null;
      if (typeof value === "number" && Number.isSafeInteger(value) && value > nowMs) {
        state.cooldowns.set(operation, value);
      }
    }
  } catch {
    // Malformed worker input must neither escape to logs nor become a bucket name.
  }
  return state;
}

const defaultTransportState = createTransportState(process.env.EXOCORTEX_LARK_COOLDOWNS_JSON || "");

/** @param {TransportState} [state] @param {number} [nowMs] */
function getTransportStats(state = defaultTransportState, nowMs = Date.now()) {
  const aggregate = emptyCounters();
  /** @type {Partial<Record<TransportOperation, TransportCounters>>} */
  const byOperation = {};
  /** @type {Partial<Record<TransportOperation, number>>} */
  const cooldowns = {};
  for (const operation of TRANSPORT_OPERATIONS) {
    const until = state.cooldowns.get(operation) || 0;
    const activeUntil = until > nowMs ? until : 0;
    if (activeUntil) cooldowns[operation] = activeUntil;
    if (!state.stats.has(operation) && !activeUntil) continue;
    const counters = { ...(state.stats.get(operation) || emptyCounters()), cooldown_until_ms: activeUntil };
    byOperation[operation] = counters;
    for (const key of /** @type {(keyof TransportCounters)[]} */ (Object.keys(aggregate))) {
      if (key === "cooldown_until_ms" || key === "max_retry_after_ms") {
        aggregate[key] = Math.max(aggregate[key], counters[key]);
      } else {
        aggregate[key] += counters[key];
      }
    }
  }
  return { ...aggregate, by_operation: byOperation, cooldowns_by_operation: cooldowns };
}

/** Reset telemetry only: clearing counts must never bypass a pending cooldown. @param {TransportState} [state] */
function resetTransportStats(state = defaultTransportState) {
  state.stats.clear();
}

/**
 * Shortcuts can make several hidden HTTP requests. These are operation bundles,
 * not claims of endpoint-level pacing or control over the CLI's internal fanout.
 * @param {string[]} args
 * @returns {TransportOperation}
 */
function transportOperation(args) {
  if (args[0] === "im") {
    if (args[1] === "+chat-messages-list") return "message_history_bundle";
    if (args[1] === "+messages-search") return "message_search_bundle";
    if (args[1] === "+chat-list") return "chat_discovery_bundle";
    if (args[1] === "chat.members" && args[2] === "get") return "chat_members";
    if (args[1] === "chat.members" && args[2] === "bots") return "chat_bots";
  }
  if (args[0] === "contact" && args[1] === "+get-user") return "self_profile";
  if (args[0] === "contact" && args[1] === "+search-user") return "contact_search";
  if (args[0] === "api") {
    if (args[1] === "GET" && args[2] === "/open-apis/authen/v1/user_info") return "self_profile";
    if (args[1] === "POST" && args[2] === "/open-apis/im/v1/messages/search") return "message_search_bundle";
    if (args[1] === "GET" && args[2] === "/open-apis/im/v1/messages/mget") return "message_search_bundle";
    if (args[1] === "GET" && (args[2] === "/open-apis/im/v1/messages" ||
        /^\/open-apis\/im\/v1\/messages\/[^/]+$/.test(args[2] || ""))) return "message_history_bundle";
  }
  if (args[0] === "api" && args[1] === "GET" && /^\/open-apis\/application\/v6\/applications\/[^/]+$/.test(args[2] || "")) {
    return "application_info";
  }
  return "other";
}

/** @param {string} stdout @returns {JsonObject | null} */
function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Native JSON parser errors can quote the private response payload.
    throw new Error("lark-cli returned non-JSON output");
  }
}

/** Legacy display helper. Runner errors deliberately do not include any command arguments. @param {string[]} args @param {string[]} [redactedFlags] */
function redactCommand(args, redactedFlags = []) {
  const parts = ["lark-cli", ...args];
  for (let index = 1; index < parts.length; index += 1) {
    if (redactedFlags.includes(parts[index]) && index + 1 < parts.length) parts[++index] = "<redacted>";
  }
  return parts.join(" ");
}

/** @param {number} ms */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {unknown} input @returns {JsonObject | null} */
function parseLarkEnvelope(input) {
  const text = String(input || "").trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const candidates = [text];
  if (firstBrace >= 0) candidates.push(text.slice(firstBrace, lastBrace + 1));
  candidates.push(...text.split("\n").reverse().filter((line) => line.trim().startsWith("{")));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* Try the next structured candidate. */ }
  }
  return null;
}

/** @param {unknown} stderr @returns {JsonObject | null} */
function parseLarkError(stderr) {
  const parsed = parseLarkEnvelope(stderr);
  if (parsed?.error && typeof parsed.error === "object") return parsed.error;
  return parsed && (Object.hasOwn(parsed, "code") || Object.hasOwn(parsed, "subtype")) ? parsed : null;
}

/** @param {unknown} value */
function numericCode(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const code = Number(value);
  return Number.isSafeInteger(code) && code >= 0 ? code : null;
}

/**
 * The documented reset value is a duration in seconds, not an epoch timestamp.
 * An oversized valid duration remains a long cooldown; it is never shortened
 * to the retry budget. Malformed values fall back to conservative backoff.
 * @param {unknown} value
 * @returns {number | null}
 */
function resetSecondsToMs(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && (!/^\d+(?:\.\d+)?$/.test(value.trim()) || value.length > 128)) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(seconds * 1000));
}

/** @param {JsonObject | null} envelope @param {string} text @returns {number | null} */
function extractRetryAfterMs(envelope, text) {
  /** @type {number[]} */
  const values = [];
  /** @param {unknown} item @param {number} depth */
  function visit(item, depth) {
    if (depth > 6 || !item || typeof item !== "object" || Array.isArray(item)) return;
    for (const [key, value] of Object.entries(item)) {
      if (key.toLowerCase() === "x-ogw-ratelimit-reset") {
        const ms = resetSecondsToMs(value);
        if (ms !== null) values.push(ms);
      } else if (["headers", "response", "detail", "details", "error"].includes(key.toLowerCase())) {
        if (typeof value === "string") {
          const nested = parseLarkEnvelope(value);
          if (nested) visit(nested, depth + 1);
          for (const match of value.matchAll(/^\s*x-ogw-ratelimit-reset\s*[:=]\s*(.*?)\s*$/gim)) {
            const ms = resetSecondsToMs(match[1]);
            if (ms !== null) values.push(ms);
          }
        } else visit(value, depth + 1);
      }
    }
  }
  visit(envelope, 0);
  // Only header-shaped lines, never an arbitrary occurrence in remote prose.
  for (const match of text.matchAll(/^\s*x-ogw-ratelimit-reset\s*:\s*(\d+(?:\.\d+)?)\s*$/gim)) {
    const ms = resetSecondsToMs(match[1]);
    if (ms !== null) values.push(ms);
  }
  return values.length ? Math.max(...values) : null;
}

/** @param {unknown} stderr @returns {LarkFailureClassification} */
function classifyLarkFailure(stderr) {
  const text = String(stderr || "");
  const envelope = parseLarkEnvelope(text);
  const error = parseLarkError(text);
  const code = numericCode(error?.code ?? envelope?.code ??
    (!envelope ? text.match(/\bcode[=:]\s*(\d+)(?=\s|;|$)/)?.[1] : undefined));
  const message = String(error?.message || "");
  const retryAfterMs = extractRetryAfterMs(envelope, text);
  /** @param {LarkFailureKind} kind @param {boolean} transient @param {string} [safeMessage] */
  const result = (kind, transient, safeMessage = kind.replaceAll("_", " ")) => ({
    kind, transient, code, message: safeMessage, retry_after_ms: retryAfterMs,
  });
  const publicKind = text.match(/\bkind=(network_timeout|network_error|rate_limited|service_unavailable|internal_error|restricted_mode|bot_user_out_of_chat|permission_denied|command_unavailable|spawn_error|unknown)(?=\s|;|$)/)?.[1];
  if (publicKind && !envelope) {
    const classification = result(/** @type {LarkFailureKind} */ (publicKind),
      ["network_timeout", "network_error", "rate_limited", "service_unavailable", "internal_error"].includes(publicKind));
    classification.retry_after_ms = numericCode(text.match(/\bretry_after_ms=(\d+)\b/)?.[1]);
    // Older public descriptors may only have recognized the numeric denial.
    if (publicKind === "unknown" && classification.code === 231203) classification.kind = "restricted_mode";
    if (publicKind === "unknown" && classification.code === 230002) classification.kind = "bot_user_out_of_chat";
    if (publicKind === "unknown" && classification.code === 210508) classification.kind = "permission_denied";
    if (classification.kind !== publicKind) classification.message = classification.kind.replaceAll("_", " ");
    return classification;
  }
  const status = [error?.http_status, error?.http_status_code, error?.status, error?.status_code,
    envelope?.http_status, envelope?.http_status_code, envelope?.status, envelope?.status_code, envelope?.response?.status,
    envelope?.response?.status_code, error?.response?.status, error?.response?.status_code].map(numericCode);
  const http429 = status.includes(429) || /\bHTTP(?:\/\d(?:\.\d)?)?\s+429\b|\b(?:http_status|status_code|status)\s*[:=]\s*429\b/i.test(text);
  if (code === 99991400 || code === 9499 || error?.subtype === "rate_limit" || envelope?.subtype === "rate_limit" || http429 || (error?.type === "api" && /too many request/i.test(message))) {
    return result("rate_limited", true);
  }
  if (/TLS handshake timeout|Client\.Timeout|timeout awaiting response headers|i\/o timeout|\bETIMEDOUT\b/i.test(text) || (error?.type === "network" && error?.subtype === "timeout")) {
    return result("network_timeout", true, "network timeout");
  }
  if (code === 231203 || /Restricted Mode|don't allow copying or forwarding messages/i.test(text)) return result("restricted_mode", false);
  if (code === 230002 || /Bot\/User can NOT be out of the chat/i.test(text)) return result("bot_user_out_of_chat", false, "bot or user is not in the chat");
  if (code === 210508) return result("permission_denied", false);
  if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|socket hang up|connection reset|unexpected EOF/i.test(text)) return result("network_error", true);
  if (error?.type === "api" && (code === 2200 || code === 1663) && /Internal Error/i.test(message)) return result("internal_error", true);
  if (/\b(?:502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Timeout|temporarily unavailable/i.test(text)) return result("service_unavailable", true);
  if (/insufficient permission|permission denied|permission level|no permission|unauthorized/i.test(text)) return result("permission_denied", false);
  return result("unknown", false);
}

/** @param {SpawnResult | null} result */
function spawnFailureText(result) {
  if (!result) return "";
  const spawnError = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  return [String(result.stderr || ""), String(result.stdout || ""), spawnError?.code || "", spawnError?.message || ""].filter(Boolean).join("\n");
}

/** Safe descriptors contain only enums and validated numbers, never remote payloads. @param {SpawnResult | null} result @param {number} timeoutMs */
function publicFailureDescriptor(result, timeoutMs) {
  const spawnError = /** @type {NodeJS.ErrnoException | undefined} */ (result?.error);
  if (spawnError?.code === "ENOENT") return "kind=command_unavailable spawn_code=ENOENT";
  if (spawnError?.code === "ETIMEDOUT") return `kind=network_timeout timeout_ms=${timeoutMs}`;
  const classification = classifyLarkFailure(spawnFailureText(result));
  const parts = [`kind=${classification.kind}`];
  if (classification.code !== null) parts.push(`code=${classification.code}`);
  if (classification.retry_after_ms !== null) parts.push(`retry_after_ms=${classification.retry_after_ms} retry_after_source=header`);
  else if (classification.kind === "rate_limited") parts.push("retry_after_source=fallback");
  return parts.join(" ");
}

/** @param {unknown} stderr */
function isTransientLarkFailure(stderr) { return classifyLarkFailure(stderr).transient; }

/** A remote outage ends this batch only after the request transport returned
 * its public failure. Validation prose and task-local detail failures do not
 * acquire transport semantics merely by mentioning a failure kind.
 * @param {unknown} error
 */
function isExhaustedLarkTransportFailure(error) {
  const text = error instanceof Error ? error.message : String(error || "");
  const descriptor = text.match(/^lark-cli failed: (kind=[^\s;]+)/)?.[1];
  return Boolean(descriptor) && classifyLarkFailure(descriptor).transient;
}

/** @param {number} attempt @param {number} baseDelayMs */
function retryDelayForAttempt(attempt, baseDelayMs) {
  return Math.min(30_000, Math.max(0, Number(baseDelayMs)) * 2 ** Math.max(0, Number(attempt)));
}

/** @param {number | undefined} value @param {number} fallback */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/** @param {TransportDeps} [deps] @returns {LarkRunner} */
function createLarkCliRunner({
  bin = process.env.LARK_CLI || "lark-cli", spawn = spawnSync, sleep = sleepMs, clock = Date.now,
  monotonicClock = () => performance.now(),
  state = defaultTransportState, timeoutMs: defaultTimeoutMs = DEFAULT_LARK_CLI_TIMEOUT_MS,
  readSharedCooldown = spawn === spawnSync ? readSharedLarkCooldown : undefined,
  writeSharedCooldown = spawn === spawnSync ? writeSharedLarkCooldown : undefined,
} = {}) {
  return function runLark(args, options = {}) {
    const operation = transportOperation(args);
    const counters = state.stats.get(operation) || emptyCounters();
    state.stats.set(operation, counters);
    counters.calls += 1;
    const retries = Number.isFinite(options.retries) ? Math.min(MAX_LARK_RETRIES, Math.max(0, Math.floor(Number(options.retries)))) : 0;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) && Number(options.retryDelayMs) >= 0 ? Number(options.retryDelayMs) : 1000;
    const requestedTimeoutMs = positiveInteger(options.timeoutMs, positiveInteger(defaultTimeoutMs, DEFAULT_LARK_CLI_TIMEOUT_MS));
    const budgetMs = positiveInteger(options.retryBudgetMs, DEFAULT_LARK_RETRY_BUDGET_MS);
    const maxBuffer = Math.min(MAX_LARK_BUFFER_BYTES, positiveInteger(options.maxBufferBytes, MAX_LARK_BUFFER_BYTES));
    const wallNow = () => { const value = clock(); return Number.isFinite(value) ? value : Date.now(); };
    const now = () => {
      const value = monotonicClock();
      if (!Number.isFinite(value)) throw new Error(`lark-cli failed: kind=unknown reason=clock_unavailable operation=${operation}`);
      return value;
    };
    // Epoch cooldowns may cross processes; elapsed deadlines must not follow
    // wall-clock corrections or treat a requested sleep as proof time passed.
    const started = now();
    const deadline = started + budgetMs;
    /** @type {SpawnResult | null} */
    let lastResult = null;
    let lastTimeoutMs = requestedTimeoutMs;
    let nextAttemptAt = started;
    /** @param {boolean} budgetExhausted */
    const fail = (budgetExhausted) => {
      if (budgetExhausted) counters.exhausted += 1;
      const descriptor = lastResult ? publicFailureDescriptor(lastResult, lastTimeoutMs) : "kind=rate_limited retry_after_source=shared";
      throw new Error(`lark-cli failed: ${descriptor} operation=${operation}${budgetExhausted ? " retry_exhausted=1" : ""}`);
    };
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      // A best-effort caller may swallow an earlier error. Cooling this operation
      // remains mandatory, while unrelated operations can proceed immediately.
      while (true) {
        const shared = readSharedCooldown?.({ operation, nowMs: wallNow() });
        if (shared?.state === "unavailable") throw new Error(`lark-cli failed: kind=unknown reason=shared_cooldown_unavailable operation=${operation}`);
        if (shared?.state === "cooldown") state.cooldowns.set(operation, Math.max(state.cooldowns.get(operation) || 0, Number(shared.untilMs)));
        const current = now();
        const waitMs = Math.max(0, nextAttemptAt - current, (state.cooldowns.get(operation) || 0) - wallNow());
        if (current >= deadline || waitMs >= deadline - current) return fail(true);
        if (waitMs <= 0) break;
        sleep(waitMs);
        counters.wait_ms += waitMs;
        // Re-read after waiting: another process may have lengthened the
        // operation cooldown. Never launch from a stale ready decision.
      }
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) return fail(true);
      lastTimeoutMs = Math.min(requestedTimeoutMs, remaining);
      counters.attempts += 1;
      if (attempt > 0) counters.retries += 1;
      let result;
      try {
        result = spawn(bin, args, { encoding: "utf8", maxBuffer, timeout: lastTimeoutMs, killSignal: "SIGKILL",
          ...(spawn === spawnSync ? { stdio: getLarkApiLeaseStdio() } : {}) });
      } catch {
        // Do not leak paths, arguments or payloads from an executor exception.
        throw new Error(`lark-cli failed: kind=spawn_error operation=${operation}`);
      }
      lastResult = result;
      if (result.status === 0) {
        state.rateStreaks.delete(operation);
        if ((state.cooldowns.get(operation) || 0) <= wallNow()) state.cooldowns.delete(operation);
        return parseJson(result.stdout || "");
      }
      const failure = classifyLarkFailure(spawnFailureText(result));
      if (failure.kind === "network_timeout") counters.timeouts += 1;
      if (failure.kind === "rate_limited") {
        counters.rate_limits += 1;
        const streak = Math.min(MAX_LARK_RETRIES, (state.rateStreaks.get(operation) || 0) + 1);
        state.rateStreaks.set(operation, streak);
        const delay = failure.retry_after_ms ?? Math.min(120_000, FALLBACK_RATE_LIMIT_DELAY_MS * 2 ** (streak - 1));
        if (failure.retry_after_ms === null) counters.retry_after_unknown += 1;
        else counters.max_retry_after_ms = Math.max(counters.max_retry_after_ms, failure.retry_after_ms);
        const wall = wallNow();
        const until = Math.min(Number.MAX_SAFE_INTEGER, wall + delay);
        state.cooldowns.set(operation, Math.max(state.cooldowns.get(operation) || 0, until));
        if (writeSharedCooldown && until > wall && !writeSharedCooldown({ operation, untilMs: until, nowMs: wall })) {
          throw new Error(`lark-cli failed: kind=rate_limited reason=shared_cooldown_unavailable operation=${operation}`);
        }
      }
      if (!failure.transient) return fail(false);
      if (attempt >= retries) return fail(true);
      nextAttemptAt = failure.kind === "rate_limited" ? now() : now() + retryDelayForAttempt(attempt, retryDelayMs);
    }
    return fail(true);
  };
}

const runLark = createLarkCliRunner();

export {
  DEFAULT_LARK_CLI_TIMEOUT_MS, DEFAULT_LARK_RETRY_BUDGET_MS, MAX_LARK_RETRIES, TRANSPORT_OPERATIONS,
  classifyLarkFailure, createLarkCliRunner, createTransportState, getTransportStats, resetTransportStats,
  isTransientLarkFailure, isExhaustedLarkTransportFailure, parseLarkError, parseJson, publicFailureDescriptor, redactCommand,
  retryDelayForAttempt, runLark, sleepMs, transportOperation,
};
