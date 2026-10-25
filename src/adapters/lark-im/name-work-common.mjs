import { quoteSql, REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
export const nameRecordFence = row => `EXISTS(SELECT 1 FROM records WHERE ${REVIEW_RECORD_COLUMNS
  .map(column => `${column} IS ${quoteSql(row[column])}`).join(' AND ')})`;
export const nameEffects = sql => `${sql}; INSERT INTO __enrichment_effects(updated) VALUES(changes());`;
export const nameFence = predicate => `CREATE TEMP TABLE IF NOT EXISTS __name_work_fence(allowed INTEGER NOT NULL CHECK(allowed=1));
 INSERT INTO __name_work_fence SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END;`;
export const nameStateKey = (account, key) => `source_id='lark.im' AND account_key=${quoteSql(account)} AND task_key=${quoteSql(key)}`;
export const nameRowBytesSql = (alias='') => REVIEW_RECORD_COLUMNS
  .map(column=>`length(CAST(COALESCE(${alias}${column},'') AS BLOB))`).join('+');
export const NAME_RETRY_MS = 5 * 60_000;
export const NAME_REFRESH_MS = 24 * 60 * 60_000;
