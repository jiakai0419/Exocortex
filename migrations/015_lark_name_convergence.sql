-- Name work is independent of content coverage and collection-scope enablement.
CREATE TABLE lark_im_name_tasks (
  source_id TEXT NOT NULL DEFAULT 'lark.im' CHECK(source_id='lark.im'),
  account_key TEXT NOT NULL,
  task_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('sender','chat')),
  chat_id TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  namespace TEXT NOT NULL DEFAULT '',
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  outcome TEXT NOT NULL DEFAULT 'pending',
  latest_record_id INTEGER NOT NULL CHECK(latest_record_id>0),
  after_record_id INTEGER NOT NULL DEFAULT 0 CHECK(after_record_id>=0),
  projection_horizon_record_id INTEGER NOT NULL DEFAULT 0 CHECK(projection_horizon_record_id>=0),
  projection_deferred INTEGER NOT NULL DEFAULT 0 CHECK(projection_deferred IN (0,1)),
  witness_after_record_id INTEGER NOT NULL DEFAULT 0 CHECK(witness_after_record_id>=0),
  witness_horizon_record_id INTEGER NOT NULL DEFAULT 0 CHECK(witness_horizon_record_id>=0),
  retry_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(retry_at_ms>=0),
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at_ms>=0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 16),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  attempt_token TEXT,
  PRIMARY KEY(source_id,account_key,task_key)
);
CREATE INDEX lark_im_name_tasks_due
  ON lark_im_name_tasks(source_id,account_key,kind,retry_at_ms,last_attempt_at_ms,task_key);
CREATE INDEX lark_im_name_tasks_chat
  ON lark_im_name_tasks(source_id,account_key,kind,chat_id);
CREATE TABLE lark_im_name_scan (
  account_key TEXT PRIMARY KEY,
  after_record_id INTEGER NOT NULL DEFAULT 0 CHECK(after_record_id>=0),
  horizon_record_id INTEGER NOT NULL DEFAULT 0 CHECK(horizon_record_id>=0),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at_ms>=0),
  next_role INTEGER NOT NULL DEFAULT 0 CHECK(next_role BETWEEN 0 AND 2),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)
);
CREATE INDEX records_name_scan ON records(source_id,id) WHERE record_type='lark.im.message';
CREATE INDEX records_name_chat ON records(source_id,container_id,id) WHERE record_type='lark.im.message';
CREATE INDEX records_name_sender ON records(source_id,actor_id,container_id,id) WHERE record_type='lark.im.message';
