// @ts-check
import { resolve } from "node:path";
import { CliExecutionError } from "./context.mjs";
import { publicDiagnosticError } from "../diagnostics/public-safe.mjs";
import { ACTIVITY_GRACE_MS, createActivityWriter } from "../diagnostics/lark-im-activity-evidence.mjs";
import { writeLog } from "../runtime/worker/log.mjs";
import { classifyLarkFailure, getTransportStats, resetTransportStats } from "../adapters/lark-im/transport.mjs";
import { executeLarkImSync, normalizeSyncOptions } from "../adapters/lark-im/sync-command.mjs";

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
  try {
    const opts = normalizeSyncOptions(options, { now: () => context.startedAtMs ?? now(), provided: context.provided });
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
    const message = error instanceof CliExecutionError ? error.message
      : failure.kind !== "unknown" ? `sync failed: kind=${failure.kind}${failure.code === null ? "" : ` code=${failure.code}`}`
      : publicDiagnosticError(error, "sync failed").message;
    stderr.write(`${message}\n`);
    const transport = readTransport();
    if (transport.calls > 0) stderr.write(`${JSON.stringify({ type: "lark_transport_summary", transport })}\n`);
    return 1;
  } finally { activity?.update("stopped"); }
}
