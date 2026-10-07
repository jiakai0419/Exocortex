import { quoteSql, sqliteQuery } from "./sqlite-executor.js";

const INITIAL_ACCOUNT_KIND = "lark_im_initial_account/v1";

/** Reserve a genuinely empty source before any run can outlive its command.
 * Pending association constrains retries but does not attest successful work. */
function reserveInitialLarkAccount(dbPath: string, accountKey: string, now: string) {
  if (!/^[a-f0-9]{64}$/.test(accountKey) ||
      !Number.isFinite(Date.parse(now))) throw new Error("invalid initial account reservation");
  const value = JSON.stringify({ kind: INITIAL_ACCOUNT_KIND, account_key: accountKey, reserved_at: now, confirmed_at: null });
  const rows = sqliteQuery(dbPath, `BEGIN IMMEDIATE;
    UPDATE sources SET config_json=json_set(config_json, '$.initial_account_binding', json(${quoteSql(value)})),
      updated_at=${quoteSql(now)}
    WHERE id='lark.im' AND enabled=1 AND json_type(config_json)='object'
      AND json_type(config_json, '$.initial_account_binding') IS NULL
      AND NOT EXISTS (SELECT 1 FROM records WHERE source_id='lark.im')
      AND NOT EXISTS (SELECT 1 FROM sync_runs WHERE source_id='lark.im')
      AND NOT EXISTS (SELECT 1 FROM sync_scopes WHERE source_id='lark.im' AND cursor_json IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM lark_im_list_progress)
      AND NOT EXISTS (SELECT 1 FROM lark_im_detail_tasks)
      AND NOT EXISTS (SELECT 1 FROM sync_locks)
      AND NOT EXISTS (SELECT 1 FROM maintenance_locks WHERE expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    RETURNING id;
    COMMIT;`, "reserve initial Lark account");
  if (rows.length !== 1) throw new Error("initial account reservation rejected: source changed or a writer is active");
}

/** Compose only with an actual list/discovery commit, after its run fence.
 * Rollback includes this confirmation; errors and skipped work never call it. */
function confirmInitialLarkAccountSql(now: string) {
  return `UPDATE sources SET config_json=json_set(config_json,
      '$.initial_account_binding.confirmed_at',
      max(json_extract(config_json, '$.initial_account_binding.reserved_at'), ${quoteSql(now)})), updated_at=${quoteSql(now)}
    WHERE id='lark.im'
      AND json_extract(config_json, '$.initial_account_binding.kind')=${quoteSql(INITIAL_ACCOUNT_KIND)}
      AND json_type(config_json, '$.initial_account_binding.confirmed_at')='null';`;
}

export { INITIAL_ACCOUNT_KIND, reserveInitialLarkAccount, confirmInitialLarkAccountSql };
