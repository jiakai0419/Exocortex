-- Scheduler evidence is separate from adopted identity/name evidence.
ALTER TABLE lark_im_name_scan ADD COLUMN schedule_sequence INTEGER NOT NULL DEFAULT 0 CHECK(schedule_sequence>=0);
ALTER TABLE lark_im_name_scan ADD COLUMN schedule_slot INTEGER NOT NULL DEFAULT 0 CHECK(schedule_slot BETWEEN 0 AND 2);
ALTER TABLE lark_im_name_scan ADD COLUMN recipient_last_served_sequence INTEGER NOT NULL DEFAULT 0 CHECK(recipient_last_served_sequence>=0);
ALTER TABLE lark_im_name_tasks ADD COLUMN enqueued_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(enqueued_at_ms>=0);
ALTER TABLE lark_im_name_tasks ADD COLUMN enqueued_sequence INTEGER NOT NULL DEFAULT 0 CHECK(enqueued_sequence>=0);
ALTER TABLE lark_im_name_tasks ADD COLUMN last_served_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_served_sequence>=0);
ALTER TABLE lark_im_name_tasks ADD COLUMN serviced_record_id INTEGER NOT NULL DEFAULT 0 CHECK(serviced_record_id>=0);
ALTER TABLE lark_im_name_tasks ADD COLUMN fresh_required_record_id INTEGER NOT NULL DEFAULT 0 CHECK(fresh_required_record_id>=0);
ALTER TABLE lark_im_name_tasks ADD COLUMN schedule_failures INTEGER NOT NULL DEFAULT 0 CHECK(schedule_failures BETWEEN 0 AND 3);
ALTER TABLE lark_im_name_tasks ADD COLUMN blocked_reason TEXT CHECK(blocked_reason IS NULL OR blocked_reason IN ('permission_denied','command_unavailable','routes_blocked','retry_exhausted'));
-- A legacy task's retry history is not proof of its original enqueue time or
-- permission category. Do not turn generic prior failures into permanent blocks.
UPDATE lark_im_name_tasks SET serviced_record_id=latest_record_id;
CREATE INDEX lark_im_name_tasks_fair
  ON lark_im_name_tasks(source_id,account_key,last_served_sequence,enqueued_sequence,task_key)
  WHERE blocked_reason IS NULL;
CREATE INDEX lark_im_name_tasks_fresh
  ON lark_im_name_tasks(source_id,account_key,fresh_required_record_id DESC,last_served_sequence,task_key)
  WHERE blocked_reason IS NULL AND latest_record_id>serviced_record_id;
CREATE INDEX lark_im_name_tasks_blocked_due
  ON lark_im_name_tasks(source_id,account_key,retry_at_ms,last_served_sequence,task_key)
  WHERE blocked_reason IS NOT NULL;

CREATE TABLE lark_im_name_routes (
  source_id TEXT NOT NULL CHECK(source_id='lark.im'),
  account_key TEXT NOT NULL,
  route_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('contact_search','chat_members','application_info','chat_bots','other')),
  failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('network_timeout','network_error','rate_limited','service_unavailable','internal_error','restricted_mode','bot_user_out_of_chat','permission_denied','command_unavailable','spawn_error','unknown')),
  failure_code INTEGER CHECK(failure_code IS NULL OR failure_code>=0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at_ms>=0),
  retry_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(retry_at_ms>=0),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  PRIMARY KEY(source_id,account_key,route_key)
);
