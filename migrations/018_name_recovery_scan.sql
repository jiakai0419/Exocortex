-- Local reviewed-debt discovery is separate from remote admission and failure
-- evidence. Migration never resets retry history or fabricates an API result.
ALTER TABLE lark_im_name_tasks ADD COLUMN reviewed_retry_at_ms INTEGER NOT NULL DEFAULT 0 CHECK(reviewed_retry_at_ms>=0);
CREATE TABLE lark_im_name_recovery_scan (
  account_key TEXT PRIMARY KEY,
  after_task_key TEXT NOT NULL DEFAULT '',
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0)
);
