CREATE INDEX IF NOT EXISTS idx_sync_runs_succeeded_noop_retention
  ON sync_runs(started_at, id)
  WHERE status = 'succeeded'
    AND inserted_count = 0
    AND updated_count = 0;

CREATE INDEX IF NOT EXISTS idx_sync_scopes_last_success_run
  ON sync_scopes(last_success_run_id)
  WHERE last_success_run_id IS NOT NULL;
