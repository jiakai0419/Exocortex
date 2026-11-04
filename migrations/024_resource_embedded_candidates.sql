-- Add a broader conservative discovery index without replacing021: the exact
-- old partial predicate/index remains necessary for supported rollback readers
-- using INDEXED BY. Neither index grants endpoint or resource authority.
-- Source rows, task state, denials, exhaustion, cursors and fair state stay put.
ALTER TABLE lark_im_resource_work ADD COLUMN capability_evidence_json TEXT
  CHECK(capability_evidence_json IS NULL OR CASE
    WHEN length(CAST(capability_evidence_json AS BLOB))<=512 AND json_valid(capability_evidence_json)
    THEN json_type(capability_evidence_json) IS 'object'
      AND json_type(capability_evidence_json,'$.version') IS 'integer' AND json_extract(capability_evidence_json,'$.version')=1
      AND json_type(capability_evidence_json,'$.reason') IS 'text' AND json_extract(capability_evidence_json,'$.reason') IN ('resource_endpoint_unverified','resource_identity_conflict')
      AND json_type(capability_evidence_json,'$.binding_key') IS 'text' AND length(json_extract(capability_evidence_json,'$.binding_key'))=64
      AND json_extract(capability_evidence_json,'$.binding_key') NOT GLOB '*[^a-f0-9]*'
      AND json_type(capability_evidence_json,'$.source_fence') IS 'text' AND length(json_extract(capability_evidence_json,'$.source_fence'))=64
      AND json_extract(capability_evidence_json,'$.source_fence') NOT GLOB '*[^a-f0-9]*'
      AND json_remove(capability_evidence_json,'$.version','$.reason','$.binding_key','$.source_fence')='{}'
    ELSE 0 END);
CREATE INDEX records_resource_media_candidates ON records(source_id,id)
WHERE source_id='lark.im' AND record_type='lark.im.message' AND (
  CASE WHEN json_valid(canonical_json) THEN json_extract(canonical_json,'$.msg_type') IN ('image','post','interactive') ELSE 0 END OR
  CASE WHEN json_valid(raw_json) THEN (
    json_extract(raw_json,'$.msg_type') IN ('image','post','interactive') OR
    json_extract(raw_json,'$.message_type') IN ('image','post','interactive') OR
    json_extract(raw_json,'$.raw_api.msg_type') IN ('image','post','interactive') OR
    json_extract(raw_json,'$.raw_api.message_type') IN ('image','post','interactive')
  ) ELSE 0 END
);
