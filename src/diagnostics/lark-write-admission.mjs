// @ts-check
import { createHash } from 'node:crypto';
import { activityDatabaseKey } from './lark-im-activity-evidence.mjs';
import { captureRemoteAccountBinding, readRemoteAccountBinding, readRemoteAccountBindingSidecar,
  accountBindingAdmissionError } from './remote-account-binding.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { quoteSql } from '../../dist/storage/sqlite/sqlite-executor.js';

const keyFor = id => createHash('sha256').update(`lark.im\0${id}`).digest('hex');

/** Captures no new remote evidence. Call before lookups; an existing self
 * result may refine identity with setSelf without replacing the local basis.
 * The commit owner must hold the shared request lease while assertCurrent and
 * its guarded transaction execute. External file replacement requires writer
 * quiescence; SQLite cannot make filesystem checks atomic.
 * @param {string} db
 * @param {{selfOpenId?:string,requireVerified?:boolean,scopeIds?:string[]}} [options]
 * @param {{query?:typeof readOnlySqliteJson}} [deps]
 */
export function captureLarkWriteAdmission(db, options = {}, deps = {}) {
  // Optional workflow deadlines apply to admission reads too. Defaults preserve
  // existing callers; the identity rules and SQL commit fence are unchanged.
  const query = deps.query || readOnlySqliteJson;
  const source = query(db, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", 'capture Lark source admission')[0];
  const before = captureRemoteAccountBinding({ db }, { query });
  const sidecar = readRemoteAccountBindingSidecar(db);
  if (!source || source.enabled !== 1 || !before || before.conflict ||
      activityDatabaseKey(db) !== before.database_key || sidecar && sidecar.database_key !== before.database_key) {
    throw new Error('Lark write admission unavailable');
  }
  const databaseKey = before.database_key;
  const localKeys = [before.initial_account?.account_key, sidecar?.account_key, before.sent_actor ? keyFor(before.sent_actor) : null].filter(Boolean);
  if (new Set(localKeys).size > 1) throw new Error('Lark local account evidence conflicts');
  /** @type {import('../../dist/storage/sqlite/lark-write-admission.js').LarkWriteAdmission} */
  const fence = { sourceConfigJson: source.config_json, selfOpenId: null, accountKey: localKeys[0] || null,
    sentActor: before.sent_actor || null, requireVerified: options.requireVerified === true,
    sidecarVerified: Boolean(sidecar), scopes: [] };
  function setSelf(selfOpenId) {
    if (typeof selfOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(selfOpenId) ||
        fence.accountKey && fence.accountKey !== keyFor(selfOpenId)) throw new Error('Lark request account conflicts with local evidence');
    const admitted = readRemoteAccountBinding({ db, selfOpenId }, { query });
    const error = accountBindingAdmissionError(admitted);
    if (error || fence.requireVerified && admitted.state !== 'verified' || admitted.database_key !== databaseKey) {
      throw new Error(error || 'Lark verified request admission unavailable');
    }
    fence.selfOpenId = selfOpenId;
    fence.accountKey = keyFor(selfOpenId);
  }
  function bindScopes(scopeIds) {
    const ids = [...new Set(scopeIds)];
    fence.scopes = ids.length ? query(db,
      `SELECT id,source_id,enabled,config_json FROM sync_scopes WHERE id IN (${ids.map(quoteSql).join(',')});`, 'capture Lark admission scopes').map(row => ({ id: row.id, source_id: row.source_id, enabled: row.enabled, config_json: row.config_json })) : [];
    if (fence.scopes.length !== ids.length || fence.scopes.some(scope => scope.source_id !== 'lark.im' || ![0, 1].includes(scope.enabled))) {
      throw new Error('Lark admission scopes unavailable');
    }
  }
  function assertCurrent() {
    if (activityDatabaseKey(db) !== databaseKey) throw new Error('Lark admission database identity changed');
    const current = readRemoteAccountBindingSidecar(db);
    if (current && (current.database_key !== databaseKey || !fence.accountKey || current.account_key !== fence.accountKey)
        || sidecar && !current) throw new Error('Lark admission sidecar changed');
    if (fence.selfOpenId) {
      const admitted = readRemoteAccountBinding({ db, selfOpenId: fence.selfOpenId }, { query });
      const error = accountBindingAdmissionError(admitted);
      if (error || admitted.database_key !== databaseKey || fence.requireVerified && admitted.state !== 'verified') {
        throw new Error(error || 'Lark request admission changed');
      }
    }
    fence.sidecarVerified = Boolean(current);
    if (activityDatabaseKey(db) !== databaseKey) throw new Error('Lark admission database identity changed');
  }
  if (options.selfOpenId !== undefined) setSelf(options.selfOpenId);
  if (options.requireVerified && !options.selfOpenId) throw new Error('verified admission requires an existing self observation');
  bindScopes(options.scopeIds || []);
  return { fence, setSelf, bindScopes, assertCurrent };
}
