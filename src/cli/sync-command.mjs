// @ts-check
import { resolve } from "node:path";
import { CliExecutionError, CliUsageError, writeCliError } from "./context.mjs";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";
import { ACTIVITY_GRACE_MS, createActivityWriter } from "../diagnostics/lark-im-activity-evidence.mjs";
import { writeLog } from "../runtime/worker/log.mjs";
import { classifyLarkFailure, getTransportStats, resetTransportStats } from "../adapters/lark-im/transport.mjs";
import { executeLarkImSync, normalizeSyncOptions } from "../adapters/lark-im/sync-command.mjs";
import { acquireSyncLarkApiLease } from "../runtime/lark-api-lease.mjs";

/** The registry owns parsing, paths and help; the adapter owns sync semantics.
 * @param {Record<string, any>} options
 * @param {any} context
 */
export function runSyncCommand(options, context) {
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const deps = context.deps;
  const env = context.env || process.env;
  const now = context.now || Date.now;
  const readTransport = deps?.getTransportStats || getTransportStats;
  (deps?.resetTransportStats || resetTransportStats)();
  let activity;
  let apiLease;
  try {
    let opts;
    try { opts = normalizeSyncOptions(options, { now: () => context.startedAtMs ?? now(), provided: context.provided }); }
    catch (error) {
      if (error instanceof CliExecutionError) throw new CliUsageError(error.message);
      throw error;
    }
    // Dependency-injected harnesses own their lease stub, as they do activity
    // writers. The public CLI always takes the real cross-process lease.
    const acquire = deps?.tryAcquireLarkApiLease || (!deps ? acquireSyncLarkApiLease : undefined);
    apiLease = acquire?.({ db: opts.db, role: "sync" });
    if (apiLease && apiLease.state !== "acquired") {
      throw new CliExecutionError(apiLease.state === "busy" ? "sync skipped: Lark API is busy" : "sync skipped: Lark API lease unavailable");
    }
    const parent = env.EXOCORTEX_ACTIVITY_PARENT || "";
    const timeout = Number(env.EXOCORTEX_ACTIVITY_STEP_TIMEOUT_MS);
    const durationMs = parent && Number.isSafeInteger(timeout) && timeout > 0 ? timeout + ACTIVITY_GRACE_MS : 5000;
    activity = deps?.activity || (!deps ? createActivityWriter({ db: opts.db, role: "sync", parentInstance: parent, now,
      emit: (event) => writeLog({ logDir: env.EXOCORTEX_ACTIVITY_LOG_DIR || resolve(context.root, "logs/lark-im") }, event, { stdout: { write() {} } }),
    }) : undefined);
    activity?.update("sync", { step: opts.scope, durationMs });
    const summary = executeLarkImSync(opts, { ...deps, activity });
    summary.transport = readTransport();
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.ok ? 0 : summary.partial ? 2 : 1;
  } catch (error) {
    const failure = classifyLarkFailure(error);
    const message = error instanceof CliUsageError || error instanceof CliExecutionError ? error.message
      : failure.kind !== "unknown" ? `sync failed: kind=${failure.kind}${failure.code === null ? "" : ` code=${failure.code}`}`
      : publicDiagnosticError(error, "sync failed").message;
    writeCliError({ stdout, stderr }, { format: options.format ?? "json",
      code: error instanceof CliUsageError ? "invalid_arguments" : "execution_failed", message,
      reason: error instanceof CliExecutionError ? error.reason : undefined });
    const transport = readTransport();
    if (transport.calls > 0) stderr.write(`${JSON.stringify({ type: "lark_transport_summary", transport })}\n`);
    return 1;
  } finally { try { activity?.update("stopped"); } finally { apiLease?.release(); } }
}
