-- Exact known-resource work; source/name projections are never rewritten here.
CREATE TABLE lark_im_resource_work (
  source_id TEXT NOT NULL CHECK(source_id='lark.im'),
  account_key TEXT NOT NULL CHECK(length(account_key)=64),
  work_key TEXT NOT NULL CHECK(length(work_key)=64),
  record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  binding_key TEXT NOT NULL CHECK(length(binding_key)=64),
  source_fence TEXT NOT NULL CHECK(length(source_fence)=64),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','deferred','available','blocked','exhausted')),
  reason TEXT CHECK(reason IS NULL OR reason IN ('permission_denied','restricted_mode','bot_user_out_of_chat','resource_invalid','account_unavailable','source_changed','retry_exhausted','sync_busy','lease_unavailable','time_budget','cli_budget','self_budget','rate_cooldown','rate_limited','shared_cooldown_unavailable','clock_unavailable','transient_failure','receipt_unavailable')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
  deferrals INTEGER NOT NULL DEFAULT 0 CHECK(deferrals BETWEEN 0 AND 8),
  enqueued_at_ms INTEGER NOT NULL CHECK(enqueued_at_ms>=0),
  last_attempt_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_attempt_at_ms>=0),
  retry_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(retry_at_ms>=0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  attempt_token TEXT,
  claim_owner TEXT,
  claim_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(claim_until_ms>=0),
  PRIMARY KEY(source_id,account_key,work_key),
  CHECK((state='running' AND attempt_token IS NOT NULL AND claim_owner IS NOT NULL) OR
        (state<>'running' AND attempt_token IS NULL AND claim_owner IS NULL))
);
CREATE INDEX lark_im_resource_work_due ON lark_im_resource_work(source_id,account_key,state,retry_at_ms,enqueued_at_ms,record_id);
CREATE INDEX lark_im_resource_work_record ON lark_im_resource_work(record_id);
CREATE TABLE lark_im_resource_scan (
  source_id TEXT PRIMARY KEY CHECK(source_id='lark.im'),
  after_id INTEGER NOT NULL DEFAULT 0 CHECK(after_id>=0),
  horizon_id INTEGER NOT NULL DEFAULT 0 CHECK(horizon_id>=0),
  last_head_id INTEGER NOT NULL DEFAULT 0 CHECK(last_head_id>=0),
  next_scan_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_scan_at_ms>=0),
  priority_streak INTEGER NOT NULL DEFAULT 0 CHECK(priority_streak BETWEEN 0 AND 2),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)
);
INSERT INTO lark_im_resource_scan(source_id) VALUES('lark.im');
