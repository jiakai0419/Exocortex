-- Keep the existing records/approval schema and raw evidence unchanged.
CREATE TABLE record_observation_state (
  record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  evidence_generation INTEGER NOT NULL DEFAULT 0 CHECK(evidence_generation >= 0),
  previous_json TEXT,
  last_observed_json TEXT,
  candidate_json TEXT,
  candidate_generation INTEGER,
  candidate_attempt TEXT,
  candidate_policy TEXT,
  candidate_context TEXT,
  candidate_observed_at_ms INTEGER,
  reason TEXT NOT NULL DEFAULT 'legacy_observation',
  observed_at_ms INTEGER,
  history_error TEXT
);
INSERT INTO record_observation_state(record_id) SELECT id FROM records;
CREATE TRIGGER record_observation_insert AFTER INSERT ON records BEGIN
  INSERT INTO record_observation_state(record_id,reason) VALUES(NEW.id,'selected_observation');
END;
CREATE TRIGGER record_observation_generation AFTER UPDATE ON records BEGIN
  UPDATE record_observation_state SET generation=generation+1 WHERE record_id=NEW.id;
END;

-- Checkpoint is processed known-row coverage, not verified source coverage.
CREATE TABLE lark_im_history_progress (
  scope_id TEXT PRIMARY KEY REFERENCES sync_scopes(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0,
  sweep_max_id INTEGER NOT NULL DEFAULT 0,
  after_id INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  last_attempt_id TEXT,
  last_result_json TEXT,
  completed_sweeps INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX records_history_scope_id ON records(source_id,first_seen_scope_id,id);
