import { parseEvidence, stable } from "./lark-observation.js";
// Discovery scheduling is not source policy. Bind every unknown field and all
// nested fields; only these three established top-level fields are projected.
const SCOPE_CONFIG_POLICY = "lark_im_scope_json_remove_hot/v1";
const SCOPE_CONFIG_PROJECTION_SQL = "json_remove(config_json,'$.hot_rank','$.hot_seen_at','$.last_hot_snapshot_id')";
function projectScopeConfig(config) {
    if (!config || typeof config !== "object" || Array.isArray(config))
        throw new Error("scope configuration must be an object");
    const { hot_rank, hot_seen_at, last_hot_snapshot_id, ...policy } = config;
    return policy;
}
/** Cross-acquisition context only. Request admission and commit still bind the
 * complete captured configuration. Never project through a rounded Number or
 * ambiguous parse: uncertain evidence remains bound by its exact original text,
 * including scheduling fields, under a distinct versioned policy. */
function scopeObservationContext(configJson) {
    try {
        return { policy: SCOPE_CONFIG_POLICY, configJson: stable(projectScopeConfig(parseEvidence(configJson))) };
    }
    catch {
        return { policy: "exact_scope_config/v1", configJson };
    }
}
export { SCOPE_CONFIG_POLICY, SCOPE_CONFIG_PROJECTION_SQL, projectScopeConfig, scopeObservationContext };
