// @ts-check
import { spawnSync } from "node:child_process";
import { createLarkImAdapter } from "../adapters/lark-im/adapter.mjs";
import { createLarkCliRunner, createTransportState } from "../adapters/lark-im/transport.mjs";
import { NAME_LOOKUP_RETRY_BUDGET_MS } from "../adapters/lark-im/name-resolver.mjs";
import { enrichRecords } from "./enrich-records.mjs";
import { enrichScopes } from "./enrich-scopes.mjs";

class EnrichmentInputError extends Error {}

/** One workflow entrance; target-specific planning and CAS remain separate.
 * @param {Record<string, any>} options @param {Record<string, any>} [deps] */
function executeEnrichment(options, deps = {}) {
  if (!["records", "scopes"].includes(options.target)) throw new EnrichmentInputError("--target must be records or scopes");
  if (options.target !== "records" && (options.probeApps || options.unsafeDetails || options.senderOnly || options.senderId)) {
    throw new EnrichmentInputError("sender, app probing and unsafe detail options require --target records");
  }
  if (Boolean(options.senderOnly) !== Boolean(options.senderId)) throw new EnrichmentInputError("--sender-only and --sender-id are required together");
  /** @type {Record<string, any>} */
  const opts = { ...options, dryRun: options.apply !== true,
    limit: options.limit ?? (options.senderOnly ? 50 : options.target === "records" ? 1000 : 50) };
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) throw new EnrichmentInputError("--limit must be a positive integer");
  if (opts.senderOnly) {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(opts.senderId) || opts.senderId.length > 512) throw new EnrichmentInputError("--sender-id must be an explicit open ID");
    if (opts.limit > 100) throw new EnrichmentInputError("sender-only --limit must be at most 100");
    if (opts.probeApps) throw new EnrichmentInputError("--probe-apps cannot be used with --sender-only");
  }
  const transport = deps.runLark || createLarkCliRunner({ bin: (deps.env || process.env).LARK_CLI || "lark-cli",
    spawn: (command, args, settings) => spawnSync(command, args, { ...settings, env: deps.env || process.env }),
    timeoutMs: NAME_LOOKUP_RETRY_BUDGET_MS, state: createTransportState(), clock: deps.now || Date.now });
  const runLark = (args, /** @type {Record<string, any>} */ settings = {}) => transport(args, { ...settings, retries: 0, retryDelayMs: 0,
    timeoutMs: Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, Number(settings.timeoutMs || NAME_LOOKUP_RETRY_BUDGET_MS)),
    retryBudgetMs: Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, Number(settings.retryBudgetMs || NAME_LOOKUP_RETRY_BUDGET_MS)) });
  const report = opts.target === "records"
    ? (deps.enrichRecords || enrichRecords)(opts, { runLark })
    : (deps.enrichScopes || enrichScopes)(opts, { fetchChatMetadata: deps.fetchChatMetadata || createLarkImAdapter({ run: runLark }).fetchChatMetadata });
  return { ...report, target: opts.target,
    partial: Boolean(report.partial || report.failed > 0 || report.skipped_conflicts > 0),
    ...(opts.unsafeDetails ? { output_sensitivity: "private" } : {}) };
}

export { executeEnrichment, EnrichmentInputError };
