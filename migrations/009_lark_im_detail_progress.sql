-- List coverage advances independently of complete merge-forward content.
-- The anchor is the last full-content cursor; completed detail receipts prevent
-- unchanged inclusive-boundary replays from reopening already resolved debt.
CREATE TABLE IF NOT EXISTS lark_im_list_progress (
  scope_id TEXT PRIMARY KEY REFERENCES sync_scopes(id) ON DELETE CASCADE,
  anchor_cursor_json TEXT CHECK (anchor_cursor_json IS NULL OR json_valid(anchor_cursor_json)),
  cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
  coverage_start_ms INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  -- Only stable chat identity, excluding discovery labels/ranks/timestamps.
  scope_config_json TEXT NOT NULL CHECK (json_valid(scope_config_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lark_im_detail_tasks (
  scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  raw_root_json TEXT NOT NULL CHECK (json_valid(raw_root_json)),
  fingerprint TEXT NOT NULL,
  external_version TEXT,
  occurred_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  retry_at TEXT NOT NULL,
  last_error_type TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (scope_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_lark_im_detail_tasks_due
  ON lark_im_detail_tasks(scope_id, status, retry_at, occurred_at_ms, message_id);
