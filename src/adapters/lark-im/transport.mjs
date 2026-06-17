// @ts-check

import { spawnSync } from "node:child_process";

/**
 * @typedef {Record<string, any>} JsonObject
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

/** @param {unknown} stderr */
function isTransientLarkFailure(stderr) {
  const text = String(stderr || "");
  if (/TLS handshake timeout|Client\.Timeout|timeout awaiting response headers|i\/o timeout/i.test(text)) {
    return true;
  }
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error?.type === "network" && error?.subtype === "timeout") return true;
    return error?.type === "api" && Number(error?.code) === 2200 && /Internal Error/i.test(String(error?.message || ""));
  } catch {
    return false;
  }
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
        sleep(retryDelayMs);
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
  createLarkCliRunner,
  isTransientLarkFailure,
  parseJson,
  redactCommand,
  runLark,
  sleepMs,
};
