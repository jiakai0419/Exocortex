-- Conservative type-only discovery. This index supplies candidates, never
-- identity/resource authority: the normal exact source/account validator still
-- fences enrollment. CASE keeps damaged JSON readable during index maintenance.
-- No queue, denied endpoint, claim, scan cursor or fair state is reset.
CREATE INDEX records_resource_image_candidates ON records(source_id,id)
WHERE source_id='lark.im' AND record_type='lark.im.message' AND (
  CASE WHEN json_valid(canonical_json) THEN json_extract(canonical_json,'$.msg_type')='image' ELSE 0 END OR
  CASE WHEN json_valid(raw_json) THEN (
    json_extract(raw_json,'$.msg_type')='image' OR
    json_extract(raw_json,'$.message_type')='image' OR
    json_extract(raw_json,'$.raw_api.msg_type')='image' OR
    json_extract(raw_json,'$.raw_api.message_type')='image'
  ) ELSE 0 END
);
