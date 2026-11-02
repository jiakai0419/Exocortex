-- Diagnostic provenance only; these hashes never authorize a request or denial.
-- Existing 022 diagnoses have no recoverable original association: keep NULL.
-- Discovery preserves these values; claim/result updates use the existing CAS.
ALTER TABLE lark_im_resource_work ADD COLUMN failure_binding_key TEXT
  CHECK(failure_binding_key IS NULL OR (length(failure_binding_key)=64 AND failure_binding_key NOT GLOB '*[^a-f0-9]*'));
ALTER TABLE lark_im_resource_work ADD COLUMN failure_source_fence TEXT
  CHECK(failure_source_fence IS NULL OR (length(failure_source_fence)=64 AND failure_source_fence NOT GLOB '*[^a-f0-9]*'));

-- Older supported writers do not know the association columns. Never let a new
-- claim or successful result inherit a previous diagnosis, even on rollback.
CREATE TRIGGER lark_resource_failure_attempt_guard
AFTER UPDATE OF state,attempt_token ON lark_im_resource_work
WHEN ((NEW.state='running' AND (OLD.state<>'running' OR NEW.attempt_token IS NOT OLD.attempt_token))
      OR (NEW.state='available' AND OLD.state<>'available'))
  AND (NEW.failure_stage IS NOT NULL OR NEW.failure_reason IS NOT NULL
       OR NEW.failure_binding_key IS NOT NULL OR NEW.failure_source_fence IS NOT NULL)
BEGIN
  UPDATE lark_im_resource_work
    SET failure_stage=NULL,failure_reason=NULL,failure_binding_key=NULL,failure_source_fence=NULL
    WHERE source_id=NEW.source_id AND account_key=NEW.account_key AND work_key=NEW.work_key;
END;

-- A legacy result can change a diagnosis but cannot attest new provenance.
-- Value comparison preserves same-value permanent-denial/name scan updates.
CREATE TRIGGER lark_resource_failure_association_guard
AFTER UPDATE OF failure_stage,failure_reason ON lark_im_resource_work
WHEN (NEW.failure_stage IS NOT OLD.failure_stage OR NEW.failure_reason IS NOT OLD.failure_reason)
  AND NEW.failure_binding_key IS OLD.failure_binding_key
  AND NEW.failure_source_fence IS OLD.failure_source_fence
  AND (NEW.failure_binding_key IS NOT NULL OR NEW.failure_source_fence IS NOT NULL)
BEGIN
  UPDATE lark_im_resource_work SET failure_binding_key=NULL,failure_source_fence=NULL
    WHERE source_id=NEW.source_id AND account_key=NEW.account_key AND work_key=NEW.work_key;
END;
