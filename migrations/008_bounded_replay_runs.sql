-- Repair evidence is separate from normal sync_runs and cursor coverage.
CREATE TABLE IF NOT EXISTS bounded_replay_runs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE RESTRICT,
  initial_sync_start_ms INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  self_id_hash TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  fetched_count INTEGER NOT NULL CHECK (fetched_count >= 0),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
  updated_count INTEGER NOT NULL CHECK (updated_count >= 0),
  duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
  conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
  finished_at TEXT NOT NULL,
  CHECK (window_start_ms >= initial_sync_start_ms AND window_end_ms > window_start_ms),
  CHECK (candidate_count <= fetched_count),
  CHECK (candidate_count = inserted_count + updated_count + duplicate_count + conflict_count)
);

CREATE INDEX IF NOT EXISTS idx_bounded_replay_plan ON bounded_replay_runs(plan_id, finished_at);
