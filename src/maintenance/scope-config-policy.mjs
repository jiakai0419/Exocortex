// @ts-check
// Keep existing maintenance imports while sharing the exact context policy
// with the TypeScript ingestion store.
export { SCOPE_CONFIG_POLICY, SCOPE_CONFIG_PROJECTION_SQL, projectScopeConfig, scopeObservationContext }
  from '../../dist/core/lark-scope-config.js';
