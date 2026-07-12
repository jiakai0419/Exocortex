DROP INDEX IF EXISTS idx_sync_runs_succeeded_noop_retention;

CREATE INDEX idx_sync_runs_succeeded_noop_retention
  ON sync_runs(started_at, id)
  WHERE status = 'succeeded'
    AND inserted_count = 0
    AND updated_count = 0;
