// @ts-check
// The existing review policy excludes only these discovery scheduling fields.
// Unknown configuration remains bound in both approvals and history context.
const SCOPE_CONFIG_POLICY = 'lark_im_scope_json_remove_hot/v1';
const SCOPE_CONFIG_PROJECTION_SQL = "json_remove(config_json,'$.hot_rank','$.hot_seen_at','$.last_hot_snapshot_id')";
function projectScopeConfig(config) {
  const { hot_rank, hot_seen_at, last_hot_snapshot_id, ...policy } = config;
  return policy;
}
export { SCOPE_CONFIG_POLICY, SCOPE_CONFIG_PROJECTION_SQL, projectScopeConfig };
