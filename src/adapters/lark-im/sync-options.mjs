// @ts-check
// Static command metadata: importing help never opens storage or loads dist.
/** @type {ReadonlyArray<import("../../runtime/worker/options.mjs").OptionSpec>} */
export const SYNC_OPTION_SPECS = Object.freeze([
  {"flag": "--db", "key": "db", "type": "path", "description": "Db.", "default": "data/exocortex.sqlite"},
  {"flag": "--scope", "key": "scope", "type": "enum", "description": "Scope.", "default": "all", "choices": ["all", "sent", "discover", "received", "details"]},
  {"flag": "--start", "key": "start", "type": "string", "description": "Confirm persistent baseline: ISO timestamp with explicit timezone; defaults to local midnight for a new source."},
  {"flag": "--end", "key": "end", "type": "string", "description": "Run upper bound; defaults to now."},
  {"flag": "--page-size", "key": "pageSize", "type": "integer", "description": "Message page size, capped at 50.", "default": 50},
  {"flag": "--max-pages", "key": "maxPages", "type": "integer", "description": "Max pages.", "default": 40},
  {"flag": "--chat-page-size", "key": "chatPageSize", "type": "integer", "description": "Discovery page size, capped at 100.", "default": 100},
  {"flag": "--max-chat-pages", "key": "maxChatPages", "type": "integer", "description": "Max chat pages.", "default": 100},
  {"flag": "--discovery-pages-per-run", "key": "discoveryPagesPerRun", "type": "integer", "description": "Discovery pages per run.", "default": 1},
  {"flag": "--received-scopes-per-run", "key": "receivedScopesPerRun", "type": "integer", "description": "Received scopes per run; zero means all.", "default": 0, "min": 0},
  {"flag": "--discovery-mode", "key": "discoveryMode", "type": "enum", "description": "Discovery mode.", "default": "cursor", "choices": ["cursor", "hot", "reconcile"]},
  {"flag": "--reconcile-interval-hours", "key": "reconcileIntervalHours", "type": "integer", "description": "Reconcile interval hours.", "default": 24},
  {"flag": "--received-mode", "key": "receivedMode", "type": "enum", "description": "Received mode.", "default": "all", "choices": ["all", "hot", "catchup"]},
  {"flag": "--chat-types", "key": "chatTypes", "type": "string", "description": "Chat types.", "default": "group,p2p"},
  {"flag": "--stable-horizon-seconds", "key": "stableHorizonSeconds", "type": "integer", "description": "Stable horizon seconds.", "default": 30, "min": 0},
  {"flag": "--lock-ttl-seconds", "key": "lockTtlSeconds", "type": "integer", "description": "Lock ttl seconds.", "default": 600},
  {"flag": "--retries", "key": "retries", "type": "integer", "description": "Retries.", "default": 4},
  {"flag": "--retry-delay-ms", "key": "retryDelayMs", "type": "integer", "description": "Retry delay ms.", "default": 2000},
  {"flag": "--detail-limit", "key": "detailLimit", "type": "integer", "description": "Due detail roots per details run, capped at 20.", "default": 5},
  {"flag": "--detail-scope", "key": "detailScope", "type": "string", "description": "Detail scope."},
]);
export const SYNC_DEFAULTS = Object.freeze(Object.fromEntries(SYNC_OPTION_SPECS.filter((spec) => spec.default !== undefined).map((spec) => [spec.key, spec.default])));
