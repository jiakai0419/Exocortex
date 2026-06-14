CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_scopes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  cursor_json TEXT,
  cursor_updated_at TEXT,
  last_success_run_id INTEGER,
  last_error_run_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (cursor_json IS NULL OR json_valid(cursor_json)),
  UNIQUE (source_id, name)
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  first_seen_scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  external_version TEXT,
  record_type TEXT NOT NULL,
  occurred_at TEXT,
  occurred_at_ms INTEGER,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_id TEXT,
  container_id TEXT,
  direction TEXT CHECK (direction IS NULL OR direction IN ('sent', 'received')),
  title TEXT,
  body TEXT,
  content_hash TEXT,
  canonical_json TEXT CHECK (canonical_json IS NULL OR json_valid(canonical_json)),
  raw_json TEXT NOT NULL CHECK (json_valid(raw_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_records_first_seen_scope_time
  ON records(first_seen_scope_id, occurred_at_ms, external_id);

CREATE INDEX IF NOT EXISTS idx_records_container_time
  ON records(source_id, container_id, occurred_at_ms);

CREATE INDEX IF NOT EXISTS idx_records_actor_time
  ON records(source_id, actor_id, occurred_at_ms);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  cursor_before_json TEXT CHECK (cursor_before_json IS NULL OR json_valid(cursor_before_json)),
  cursor_after_json TEXT CHECK (cursor_after_json IS NULL OR json_valid(cursor_after_json)),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  error_type TEXT,
  error_message TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_scope_started
  ON sync_runs(scope_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status
  ON sync_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_locks (
  scope_id TEXT PRIMARY KEY REFERENCES sync_scopes(id) ON DELETE CASCADE,
  locked_by TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
