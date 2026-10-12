-- Hints only: independent source sampling remains the authority for closure.
-- A priority acquisition never moves the fair sweep's checkpoint.
CREATE TABLE lark_im_history_debt (
  record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL REFERENCES sync_scopes(id) ON DELETE CASCADE,
  finding_key TEXT NOT NULL UNIQUE,
  database_key TEXT NOT NULL,
  account_key TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  debt_fingerprint TEXT NOT NULL,
  debts_json TEXT NOT NULL CHECK(json_valid(debts_json)),
  enqueued_at_ms INTEGER NOT NULL CHECK(enqueued_at_ms >= 0),
  sample_checked_at_ms INTEGER NOT NULL CHECK(sample_checked_at_ms >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at_ms >= 0),
  next_due_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_due_at_ms >= 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 16),
  verification_generation INTEGER CHECK(verification_generation IS NULL OR verification_generation >= 0),
  verification_requested_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(verification_requested_at_ms >= 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','awaiting_verification')),
  last_attempt_id TEXT,
  last_result_json TEXT
);
CREATE INDEX lark_im_history_debt_due ON lark_im_history_debt(status,next_due_at_ms,last_attempt_at_ms,enqueued_at_ms,record_id);
CREATE TABLE lark_im_history_scheduler (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  priority_streak INTEGER NOT NULL DEFAULT 0 CHECK(priority_streak BETWEEN 0 AND 2),
  last_attempt_id TEXT,
  last_result_json TEXT
);
ALTER TABLE lark_im_history_scheduler ADD COLUMN fair_round INTEGER NOT NULL DEFAULT 0 CHECK(fair_round >= 0);
CREATE TABLE lark_im_history_round (
  scope_id TEXT PRIMARY KEY REFERENCES sync_scopes(id) ON DELETE CASCADE,
  round INTEGER NOT NULL CHECK(round >= 0),
  baseline_sweeps INTEGER NOT NULL CHECK(baseline_sweeps >= 0),
  enrolled_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(enrolled_at_ms >= 0)
);
-- A scope re-enabled or given a different policy joins at its real current
-- baseline. Cursor/freshness updates deliberately do not reset round coverage.
CREATE TRIGGER lark_history_round_scope_change AFTER UPDATE OF enabled,config_json ON sync_scopes
WHEN OLD.enabled IS NOT NEW.enabled OR
  CASE WHEN json_valid(OLD.config_json) AND json_valid(NEW.config_json)
    THEN json_remove(OLD.config_json,'$.hot_rank','$.hot_seen_at','$.last_hot_snapshot_id')
      IS NOT json_remove(NEW.config_json,'$.hot_rank','$.hot_seen_at','$.last_hot_snapshot_id')
    ELSE OLD.config_json IS NOT NEW.config_json END
BEGIN
  DELETE FROM lark_im_history_round WHERE scope_id=NEW.id;
END;
