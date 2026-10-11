import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { senderLookupNamespace } from '../src/adapters/lark-im/sender-identity.mjs';
import { bindCurrentSenderNames, reuseKnownSenderNames } from '../src/adapters/lark-im/name-history.mjs';
import { ensureInitialized, reserveInitialLarkAccount, confirmInitialLarkAccountSql,
  sqliteExec, sqliteQuery, quoteSql, upsertRecordsSql }
  from '../dist/storage/sqlite/ingestion-store.js';

// Invented identities, payloads and temporary databases; no transport or API.
const START = Date.UTC(2044, 0, 1), CHAT = 'oc_synthetic_namespace_repro';
const SCOPE = 'lark.im.received.chat.synthetic_namespace_repro';
const APP = 'cli_synthetic_namespace_repro';
const SELF = { open_id: 'ou_synthetic_namespace_owner' };
const NAME = 'Synthetic Copper Cart';
const canonical = record => JSON.parse(record.canonical_json);
function raw(id, kind = 'app', offset = 1) {
  return { message_id: `om_synthetic_namespace_${id}`, chat_id: CHAT, msg_type: 'text',
    create_time: String(START), update_time: String(START + offset),
    sender: { id: APP, id_type: 'app_id', sender_type: kind },
    body: { content: JSON.stringify({ text: 'An entirely synthetic namespace example.' }) } };
}
function record(id, kind = 'app', source = null, offset = 1) {
  const result = recordFromMessage(normalizeApiMessage(raw(id, kind, offset)), SCOPE, 'received', {}, { chat_id: CHAT });
  if (source) result.canonical_json = JSON.stringify({ ...canonical(result), sender_name: NAME,
    sender_name_source: source, sender_name_confidence: 'high' });
  return result;
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-name-namespace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  reserveInitialLarkAccount(db, createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex'), new Date().toISOString());
  sqliteExec(db, confirmInitialLarkAccountSql(new Date().toISOString()));
  sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(SCOPE)},'lark.im','Synthetic namespace scope',${quoteSql(JSON.stringify({chat_id:CHAT}))});`);
  return db;
}
const put = (db, row) => sqliteExec(db, upsertRecordsSql([row]));
const reuse = (db, row) => reuseKnownSenderNames(db, [row], SELF)[0];

for (const source of ['application_api', 'chat_bot_app_id']) {
  test(`recipient actor-kind conflict cannot borrow ${source} history`, (t) => {
    const db = fixture(t);
    put(db, record(`authority_${source}`, 'app', source));
    assert.equal(canonical(reuse(db, record('valid_recipient'))).sender_name, NAME);
    const input = record('contradictory_recipient', 'user');
    assert.equal(senderLookupNamespace(raw('contradictory_recipient', 'user')), '');
    assert.equal(canonical(input).sender_name, null);
    const actual = reuse(db, input);
    assert.equal(canonical(actual).sender_name, null);
    assert.equal(actual.raw_json, input.raw_json);
  });
}

test('contradictory historical donor cannot lend an app name to a valid recipient', (t) => {
  const db = fixture(t), donor = record('contradictory_donor', 'user', 'application_api');
  assert.equal(senderLookupNamespace(raw('contradictory_donor', 'user')), '');
  put(db, donor);
  assert.equal(canonical(reuse(db, record('valid_recipient'))).sender_name, null);
});

test('actual upsert cannot retain an app name after incoming actor-kind contradiction', (t) => {
  const db = fixture(t);
  put(db, record('same_record', 'app', 'application_api', 1));
  const incoming = record('same_record', 'user', null, 2);
  assert.equal(canonical(incoming).sender_name, null);
  put(db, incoming);
  const saved = sqliteQuery(db, `SELECT raw_json,canonical_json,external_version FROM records WHERE external_id=${quoteSql(incoming.external_id)};`)[0];
  assert.equal(saved.raw_json, incoming.raw_json);
  assert.equal(saved.external_version, incoming.external_version);
  assert.equal(canonical(saved).sender_name, null);
});

test('an actor-kind contradiction cannot acquire an official name account marker', () => {
  const valid = record('valid_binding', 'app', 'application_api');
  assert.equal(typeof canonical(bindCurrentSenderNames([valid], SELF)[0]).sender_name_account_key, 'string');
  const conflicting = record('conflicting_binding', 'user', 'application_api');
  assert.strictEqual(bindCurrentSenderNames([conflicting], SELF)[0], conflicting);
});
