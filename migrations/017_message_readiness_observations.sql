-- Historical results of the actual local reading pipeline. These timestamps
-- are observations, never proof of the first true missing/complete instant.
CREATE TABLE lark_im_message_readiness (
  source_id TEXT NOT NULL CHECK(source_id='lark.im'),
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  observer_account_key TEXT NOT NULL CHECK(length(observer_account_key)=64),
  contract_version INTEGER NOT NULL CHECK(contract_version>0),
  source_version_key TEXT NOT NULL CHECK(length(source_version_key)=64),
  source_epoch INTEGER NOT NULL DEFAULT 1 CHECK(source_epoch>0),
  state TEXT NOT NULL CHECK(state IN ('captured','enriching','ready','blocked')),
  reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
  first_observed_at_ms INTEGER NOT NULL CHECK(first_observed_at_ms>=0),
  first_missing_observed_at_ms INTEGER CHECK(first_missing_observed_at_ms>=first_observed_at_ms),
  first_ready_observed_at_ms INTEGER CHECK(first_ready_observed_at_ms>=first_observed_at_ms),
  last_observed_at_ms INTEGER NOT NULL CHECK(last_observed_at_ms>=first_observed_at_ms),
  observed_regression_count INTEGER NOT NULL DEFAULT 0 CHECK(observed_regression_count>=0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
  PRIMARY KEY(source_id,record_id,observer_account_key,contract_version)
);
CREATE INDEX lark_im_message_readiness_observer
  ON lark_im_message_readiness(source_id,observer_account_key,contract_version,record_id);

CREATE TABLE lark_im_message_readiness_scan (
  source_id TEXT NOT NULL CHECK(source_id='lark.im'),
  observer_account_key TEXT NOT NULL CHECK(length(observer_account_key)=64),
  contract_version INTEGER NOT NULL CHECK(contract_version>0),
  tail_after_id INTEGER NOT NULL DEFAULT 0 CHECK(tail_after_id>=0),
  history_after_id INTEGER NOT NULL DEFAULT 0 CHECK(history_after_id>=0),
  history_horizon_id INTEGER NOT NULL DEFAULT 0 CHECK(history_horizon_id>=0),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at_ms>=0),
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at_ms>=0),
  last_scanned_count INTEGER NOT NULL DEFAULT 0 CHECK(last_scanned_count>=0),
  last_observed_count INTEGER NOT NULL DEFAULT 0 CHECK(last_observed_count>=0),
  last_deferred_count INTEGER NOT NULL DEFAULT 0 CHECK(last_deferred_count>=0),
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation>0),
  PRIMARY KEY(source_id,observer_account_key,contract_version)
);
