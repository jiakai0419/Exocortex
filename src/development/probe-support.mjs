import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { createLarkCliRunner, createTransportState, classifyLarkFailure } from "../adapters/lark-im/transport.mjs";

export const PROBE_TIMEOUT_MS = 10_000;
export const PROBE_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

/** Keep first-attempt observations separate from transport's public errors.
 * Each research command has one bounded attempt, without inherited cooldowns.
 * @param {{spawn?: typeof spawnSync, clock?: () => number}} [dependencies]
 */
export function createProbeRunner({ spawn = spawnSync, clock = Date.now } = {}) {
  return (id, args, options = {}) => {
    const started = clock();
    /** @type {import("node:child_process").SpawnSyncReturns<string> | null} */
    let observed = null;
    const runner = createLarkCliRunner({ state: createTransportState(), clock,
      spawn: (bin, argv, settings) => {
        observed = spawn(bin, argv, settings);
        return observed;
      },
    });
    let json = null;
    let failure = null;
    let parseFailed = false;
    try {
      json = runner(args, { retries: 0, timeoutMs: PROBE_TIMEOUT_MS,
        retryBudgetMs: PROBE_TIMEOUT_MS, maxBufferBytes: PROBE_MAX_BUFFER_BYTES });
    } catch (error) {
      parseFailed = error instanceof Error && error.message === "lark-cli returned non-JSON output";
      failure = classifyLarkFailure(error instanceof Error ? error.message : "").kind;
    }
    // TypeScript cannot follow a synchronous callback's assignment.
    const result = /** @type {import("node:child_process").SpawnSyncReturns<string> | null} */ (observed);
    const apiFailed = json?.success === false || (args[0] === "api" && json?.code !== undefined && Number(json.code) !== 0);
    if (apiFailed) failure = classifyLarkFailure(JSON.stringify(json)).kind;
    const flags = [...(options.redactedFlags || []), ...(options.redactions || []).map((entry) => entry.flag)];
    const label = args.map((part, index) => flags.includes(args[index - 1]) ? "<redacted>" : part).join(" ");
    return {
      id, command: `lark-cli ${label}`, ok: result?.status === 0 && !result?.error && !result?.signal && !apiFailed && (!parseFailed || options.keepStdout === true),
      exit_code: result?.status ?? null, signal: result?.signal ?? null,
      execution_error: result === null || Boolean(result.error),
      failure_kind: parseFailed && options.keepStdout === true ? null : failure,
      json_parse_failed: parseFailed && options.keepStdout !== true,
      started_at: new Date(started).toISOString(), finished_at: new Date(clock()).toISOString(),
      stderr: String(result?.stderr || "").slice(0, 2000), json,
      ...(options.keepStdout ? { stdout: String(result?.stdout || "").trim().slice(0, 2000) } : {}),
      // Invalid JSON remains an observation; it is never normalized into data.
      ...(result?.stdout && json === null ? { stdout_excerpt: result.stdout.slice(0, 2000) } : {}),
    };
  };
}

export function boundedInteger(value, maximum, label) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return Number(value);
}

export function validateProbeWindow(start, end) {
  // Use the same local-time round trip as sync/replay, without importing their
  // storage dependencies or imposing their modern-epoch persistence constraint.
  const timestamp = (value) => {
    const match = String(value).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/);
    if (!match) throw new Error("Invalid probe timestamp");
    const [, local, seconds = "00", fraction = "", zone, sign, hours = "0", minutes = "0"] = match;
    const parsed = Date.parse(value);
    if (Number(hours) > 23 || Number(minutes) > 59 || !Number.isSafeInteger(parsed)) throw new Error("Invalid probe timestamp");
    const offset = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
    if (new Date(parsed + offset).toISOString() !== `${local}:${seconds}.${fraction.padEnd(3, "0")}Z`) {
      throw new Error("Invalid probe calendar timestamp");
    }
    return parsed;
  };
  const first = timestamp(start); const last = timestamp(end);
  if (last <= first || last - first > 86_400_000) throw new Error("Probe window must be increasing and at most 24 hours");
}

/** No output argument means no file, directory or detailed report path. */
export function writeProbeReport(output, report) {
  if (!output) return false;
  const path = resolve(output);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Do not follow links or truncate an existing private/user file.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); }
  finally { closeSync(fd); }
  return true;
}

/** Strictly numeric version only; arbitrary CLI output stays in private detail. */
export function probeVersion(record) {
  const match = String(record?.stdout || "").trim().match(/^(?:lark-cli\s+)?v?(\d+\.\d+\.\d+)$/);
  return match?.[1] || "unknown";
}
