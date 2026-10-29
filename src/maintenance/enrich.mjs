// @ts-check
import { createLarkImAdapter } from "../adapters/lark-im/adapter.mjs";
import { NAME_LOOKUP_RETRY_BUDGET_MS } from "../adapters/lark-im/name-resolver.mjs";
import { enrichRecords } from "./enrich-records.mjs";
import { enrichScopes } from "./enrich-scopes.mjs";
import { enrichRecipients } from "./enrich-recipients.mjs";
import { enrichResources } from "./enrich-resources.mjs";
import { createMaintenanceRequestSession } from "./request-session.mjs";
import { validateReviewOptions } from "./review-artifact.mjs";

class EnrichmentInputError extends Error {}

/** @param {Record<string, any>} options */
function validateRequestBudget(options) {
  for (const [field, flag, maximum] of [["maxCliAttempts", "--max-cli-attempts", 1000], ["maxSeconds", "--max-seconds", 180]]) {
    const value = options[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
      throw new EnrichmentInputError(`${flag} must be an integer from 1 to ${maximum}`);
    }
  }
}

/** One workflow entrance; target-specific planning and CAS remain separate.
 * @param {Record<string, any>} options @param {Record<string, any>} [deps] */
function executeEnrichment(options, deps = {}) {
  if (options.target === 'resources') {
    if (options.probeApps || options.unsafeDetails || options.senderOnly || options.namesOnly
      || options.senderId !== undefined || options.limit !== undefined
      || options.reviewOut !== undefined || options.reviewIn !== undefined || options.reviewSha256 !== undefined) {
      throw new EnrichmentInputError('--target resources accepts only exact --record-id targets, request budgets and --resource-dir');
    }
    if (!Array.isArray(options.recordIds) || options.recordIds.length < 1 || options.recordIds.length > 20
      || options.recordIds.some(id => !Number.isSafeInteger(id) || id < 1)
      || new Set(options.recordIds).size !== options.recordIds.length) {
      throw new EnrichmentInputError('--target resources requires 1 to 20 unique positive --record-id values');
    }
    if (options.resourceDir !== undefined && (typeof options.resourceDir !== 'string' || !options.resourceDir)) {
      throw new EnrichmentInputError('--resource-dir requires a non-empty path');
    }
    validateRequestBudget(options);
    // Resources own their session: an offline preview must not create the
    // names session or inherit its default scan limit and transport wrapper.
    return (deps.enrichResources || enrichResources)({ ...options, dryRun: options.apply !== true }, deps);
  }
  if (options.resourceDir !== undefined) throw new EnrichmentInputError('--resource-dir requires --target resources');
  const recipients = options.target === 'recipients';
  if (recipients && (options.probeApps || options.unsafeDetails || options.senderOnly || options.senderId || options.namesOnly
    || options.limit !== undefined || options.reviewOut !== undefined || options.reviewIn !== undefined || options.reviewSha256 !== undefined)) {
    throw new EnrichmentInputError('--target recipients accepts only exact --record-id targets and request budgets');
  }
  validateReviewOptions(options, 'names');
  if (!["records", "scopes", "recipients"].includes(options.target)) throw new EnrichmentInputError("--target must be records, scopes, recipients or resources");
  if (options.recordIds !== undefined && !Array.isArray(options.recordIds)) throw new EnrichmentInputError("--record-id requires an integer selection");
  const hasRecordIds = Array.isArray(options.recordIds) && options.recordIds.length > 0;
  if (options.target === "scopes" && (options.probeApps || options.unsafeDetails || options.senderOnly || options.senderId || options.namesOnly || hasRecordIds)) {
    throw new EnrichmentInputError("sender, app probing and unsafe detail options require --target records");
  }
  if (Boolean(options.senderOnly) !== Boolean(options.senderId)) throw new EnrichmentInputError("--sender-only and --sender-id are required together");
  if (!recipients && Boolean(options.namesOnly) !== hasRecordIds) throw new EnrichmentInputError("--names-only and --record-id are required together");
  if (recipients && (!hasRecordIds || options.recordIds.length > 20
    || options.recordIds.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(options.recordIds).size !== options.recordIds.length)) {
    throw new EnrichmentInputError('--target recipients requires 1 to 20 unique positive --record-id values');
  }
  if (options.namesOnly) {
    if (!Array.isArray(options.recordIds) || options.recordIds.length < 1 || options.recordIds.length > 100
      || options.recordIds.some((/** @type {unknown} */ id) => !Number.isSafeInteger(id) || Number(id) < 1)
      || new Set(options.recordIds).size !== options.recordIds.length) {
      throw new EnrichmentInputError("--record-id requires 1 to 100 unique positive safe integers");
    }
    if (options.senderOnly || options.senderId || options.probeApps || options.limit !== undefined) {
      throw new EnrichmentInputError("--names-only cannot be combined with --sender-only, --probe-apps or --limit");
    }
  }
  validateRequestBudget(options);
  /** @type {Record<string, any>} */
  const opts = { ...options, dryRun: options.apply !== true,
    limit: options.limit ?? (options.senderOnly ? 50 : options.target === "records" ? 1000 : 50) };
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) throw new EnrichmentInputError("--limit must be a positive integer");
  if (opts.senderOnly) {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(opts.senderId) || opts.senderId.length > 512) throw new EnrichmentInputError("--sender-id must be an explicit open ID");
    if (opts.limit > 100) throw new EnrichmentInputError("sender-only --limit must be at most 100");
    if (opts.probeApps) throw new EnrichmentInputError("--probe-apps cannot be used with --sender-only");
  }
  // An explicitly injected runner is the existing domain-test seam. Real CLI
  // invocations always use the shared session, including dry-run lookups.
  const session = deps.runLark ? null : createMaintenanceRequestSession(opts,
    { env: deps.env, now: deps.now, ...deps.requestSessionDeps });
  const transport = deps.runLark || session?.runLark;
  const runLark = (args, /** @type {Record<string, any>} */ settings = {}) => transport(args, { ...settings, retries: 0, retryDelayMs: 0,
    timeoutMs: Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, Number(settings.timeoutMs || NAME_LOOKUP_RETRY_BUDGET_MS)),
    retryBudgetMs: Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, Number(settings.retryBudgetMs || NAME_LOOKUP_RETRY_BUDGET_MS)) });
  const assertReady = session?.assertReady || deps.assertReady || (() => {});
  const withCommit = session?.withCommit || deps.withCommit;
  const report = recipients
    ? (deps.enrichRecipients || enrichRecipients)(opts, { runLark, assertReady, withCommit, now: deps.now })
    : opts.target === "records"
    ? (deps.enrichRecords || enrichRecords)(opts, { runLark, assertReady, withCommit, now: deps.now })
    : (deps.enrichScopes || enrichScopes)(opts, { assertReady, withCommit, fetchChatMetadata: deps.fetchChatMetadata || createLarkImAdapter({ run: runLark }).fetchChatMetadata });
  return { ...report, target: opts.target,
    ...(session ? { request_budget: session.summary() } : {}),
    partial: Boolean(report.partial || report.failed > 0 || report.skipped_conflicts > 0),
    ...(opts.unsafeDetails ? { output_sensitivity: "private" } : {}) };
}

export { executeEnrichment, EnrichmentInputError };
