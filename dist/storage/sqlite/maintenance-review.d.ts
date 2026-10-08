import type { MaintenanceReviewFence } from "./ingestion-types.js";
declare const REVIEW_RECORD_COLUMNS: readonly ["id", "source_id", "first_seen_scope_id", "external_id", "external_version", "record_type", "occurred_at", "occurred_at_ms", "received_at", "actor_id", "container_id", "direction", "title", "body", "content_hash", "canonical_json", "raw_json", "created_at", "updated_at"];
declare const REVIEW_LIFETIME_MS: number;
/** All predicates execute after BEGIN IMMEDIATE, before any business update.
 * This intentionally fences no-op selected rows too. The runtime clock is
 * SQLite's transaction-time clock, not a pre-API JavaScript timestamp. */
declare function reviewFenceSql(fence: MaintenanceReviewFence): string;
export { REVIEW_RECORD_COLUMNS, REVIEW_LIFETIME_MS, reviewFenceSql };
