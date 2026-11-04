-- Old/manual audits remain unmarked. Never infer provenance from attempt IDs.
ALTER TABLE bounded_replay_runs ADD COLUMN history_record_id INTEGER REFERENCES records(id) ON DELETE RESTRICT;
ALTER TABLE bounded_replay_runs ADD COLUMN history_fence_hash TEXT;
CREATE INDEX idx_bounded_replay_history ON bounded_replay_runs(history_record_id) WHERE history_record_id IS NOT NULL;
