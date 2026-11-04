// @ts-check
/** Conservative index predicate, identical to migration024. A matching row is
 * only a bounded candidate; resourceWorkIdentity retains all exact validation.
 * Do not replace OR with COALESCE: conflicting declarations must reach the
 * validator and valid native legacy envelopes must not be hidden. */
export const RESOURCE_CANDIDATE_INDEX = 'records_resource_media_candidates';
export const RESOURCE_CANDIDATE_WHERE = `source_id='lark.im' AND record_type='lark.im.message' AND (
  CASE WHEN json_valid(canonical_json) THEN json_extract(canonical_json,'$.msg_type') IN ('image','post','interactive') ELSE 0 END OR
  CASE WHEN json_valid(raw_json) THEN (
    json_extract(raw_json,'$.msg_type') IN ('image','post','interactive') OR
    json_extract(raw_json,'$.message_type') IN ('image','post','interactive') OR
    json_extract(raw_json,'$.raw_api.msg_type') IN ('image','post','interactive') OR
    json_extract(raw_json,'$.raw_api.message_type') IN ('image','post','interactive')
  ) ELSE 0 END
)`;
