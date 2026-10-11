-- The same bounded observation policy, before a complete record exists.
ALTER TABLE lark_im_detail_tasks ADD COLUMN descriptor_generation INTEGER NOT NULL DEFAULT 0 CHECK(descriptor_generation >= 0);
ALTER TABLE lark_im_detail_tasks ADD COLUMN evidence_generation INTEGER NOT NULL DEFAULT 0 CHECK(evidence_generation >= 0);
ALTER TABLE lark_im_detail_tasks ADD COLUMN candidate_json TEXT CHECK(candidate_json IS NULL OR json_valid(candidate_json));
ALTER TABLE lark_im_detail_tasks ADD COLUMN candidate_generation INTEGER;
ALTER TABLE lark_im_detail_tasks ADD COLUMN candidate_attempt TEXT;
ALTER TABLE lark_im_detail_tasks ADD COLUMN candidate_policy TEXT;
ALTER TABLE lark_im_detail_tasks ADD COLUMN candidate_context TEXT;
ALTER TABLE lark_im_detail_tasks ADD COLUMN candidate_observed_at_ms INTEGER;
CREATE TRIGGER lark_detail_descriptor_generation AFTER UPDATE OF raw_root_json,fingerprint,external_version,occurred_at_ms,status ON lark_im_detail_tasks
WHEN OLD.raw_root_json IS NOT NEW.raw_root_json OR OLD.fingerprint IS NOT NEW.fingerprint
  OR OLD.external_version IS NOT NEW.external_version OR OLD.occurred_at_ms IS NOT NEW.occurred_at_ms OR OLD.status IS NOT NEW.status
BEGIN
  UPDATE lark_im_detail_tasks SET descriptor_generation=descriptor_generation+1,evidence_generation=evidence_generation+1,
    candidate_json=NULL,candidate_generation=NULL,candidate_attempt=NULL,candidate_policy=NULL,candidate_context=NULL,candidate_observed_at_ms=NULL
    WHERE scope_id=NEW.scope_id AND message_id=NEW.message_id;
END;
