-- Relationships are independent of discovery: muted sent chats must not
-- create a sync scope or change enablement to acquire recipient evidence.
CREATE TABLE lark_im_recipient_state (
  source_id TEXT NOT NULL DEFAULT 'lark.im' CHECK(source_id='lark.im'),
  account_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  enqueued_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(enqueued_at_ms >= 0),
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at_ms >= 0),
  retry_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(retry_at_ms >= 0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 16),
  record_after_id INTEGER NOT NULL DEFAULT 0 CHECK(record_after_id >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  attempt_token TEXT,
  attempt_evidence_json TEXT CHECK(attempt_evidence_json IS NULL OR json_valid(attempt_evidence_json)),
  PRIMARY KEY(source_id,account_key,chat_id)
);
CREATE INDEX lark_im_recipient_state_due
  ON lark_im_recipient_state(source_id,account_key,retry_at_ms,last_attempt_at_ms,enqueued_at_ms,chat_id);
CREATE INDEX lark_im_recipient_state_changed
  ON lark_im_recipient_state(source_id,account_key,last_attempt_at_ms,enqueued_at_ms,chat_id)
  WHERE attempt_evidence_json IS NOT evidence_json;
CREATE TABLE lark_im_recipient_scan (
  account_key TEXT PRIMARY KEY,
  after_record_id INTEGER NOT NULL DEFAULT 0 CHECK(after_record_id >= 0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)
);
CREATE INDEX records_recipient_sent_id ON records(source_id,id)
  WHERE direction='sent' AND record_type='lark.im.message';
-- A bounded witness page must not walk arbitrarily many received messages.
CREATE INDEX records_recipient_sent_container_id ON records(source_id,container_id,id)
  WHERE direction='sent' AND record_type='lark.im.message';
