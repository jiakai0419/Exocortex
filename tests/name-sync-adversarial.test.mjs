import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { loadMessages } from '../src/diagnostics/messages-report.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Synthetic adversarial fixtures only: no production messages, account IDs or APIs.
const SELF = 'ou_adversarial_synthetic_self', CHAT = 'oc_adversarial_synthetic_group';
const NOW = Date.parse('2025-04-05T06:07:08.000Z');
function fixture(t, count = 1, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exo-name-adversarial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  const statements = [];
  for (let id = 1; id <= count; id++) {
    const type = options.mode?.(id) || 'group';
    const raw = { message_id: `om_adversarial_synthetic_${id}`, chat_id: options.chat?.(id) || CHAT, chat_type: type,
      // Sender identity is already named; each case below varies chat evidence.
      sender: { id: SELF, id_type: 'open_id', sender_type: 'user', name: 'Synthetic author' } };
    const canonical = { message_id: raw.message_id, chat_id: raw.chat_id, chat_type: type,
      sender_id: SELF, sender_id_type: 'open_id', sender_name: 'Synthetic author', chat_name: null };
    options.alter?.(id, canonical, raw);
    statements.push(`INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
      VALUES(${id},'lark.im','lark.im.sent_by_me',${quoteSql(raw.message_id)},'synthetic-version','lark.im.message',
      ${quoteSql(SELF)},${quoteSql(raw.chat_id)},'sent','Synthetic unchanged body',${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`);
  }
  sqliteExec(db, statements.join('\n'), 'create authored adversarial fixtures');
  return { db, now: NOW, calls: [] };
}
function run(f, deps = {}) {
  return syncNames(f.db, { open_id: SELF }, { now: () => f.now, monotonicNow: () => 0,
    syncRecipients: () => ({ reason: 'idle' }), runLark: args => {
      f.calls.push(args);
      if (args[0] === 'contact') return { open_id: SELF };
      if (args.slice(0, 3).join(' ') === 'im chats get')
        return { data: { chat_id: JSON.parse(args[args.indexOf('--params') + 1]).chat_id,
          chat_mode: 'group', name: 'Verified synthetic title' } };
      throw new Error('Unexpected synthetic route');
    }, ...deps });
}

test('an oversized historical row cannot permanently hide eligible rows later in its scan page', t => {
  const f = fixture(t, 121, { mode: id => id === 42 ? 'group' : 'p2p',
    chat: id => id === 42 ? CHAT : `oc_adversarial_synthetic_p2p_${id}` });
  sqliteExec(f.db, "UPDATE records SET body=printf('%.*c',9000000,'x') WHERE id=41;", 'author oversized predecessor');
  for (let i = 0; i < 8; i++) { run(f); f.now += 60001; }
  const tasks = sqliteQuery(f.db, "SELECT latest_record_id FROM lark_im_name_tasks WHERE kind='chat';", 'inspect historical enrollment');
  assert.ok(tasks.some(task => task.latest_record_id === 42), 'the small eligible row must be enrolled after complete historical sweeps');
});

test('chat projection and exact witness respect the byte cap for multibyte payloads', t => {
  const f = fixture(t);
  sqliteExec(f.db, "UPDATE records SET body=replace(printf('%.*c',900000,'x'),'x','界');", 'author multibyte payload');
  const materialized = [];
  run(f, { readOnlyQuery: (db, sql, label, options) => {
    const result = readOnlySqliteJson(db, sql, label, options);
    if (label === 'read bounded chat name projection' || label === 'read exact name witness')
      materialized.push({ label, bytes: Buffer.byteLength(JSON.stringify(result)) });
    return result;
  } });
  assert.ok(materialized.every(batch => batch.bytes <= 2 * 1024 * 1024), JSON.stringify(materialized));
});

test('nested raw group-name clear survives enrollment through a different message', t => {
  const f = fixture(t, 3, { alter: (id, canonical, raw) => {
    if (id === 2) raw.chat = { chat_id: CHAT, chat_name_state: 'cleared', name: 'Old synthetic title' };
  } });
  const result = run(f);
  assert.equal(result.reason, 'resolved');
  const row = loadMessages(f.db, { direction: 'all', limit: 10, search: '' }).find(item => item.external_id === 'om_adversarial_synthetic_2');
  assert.equal(row.canonical.chat_name_account_key, undefined, 'explicit clear must not gain borrowed account evidence');
  assert.notEqual(row.display.chat, 'Verified synthetic title');
  assert.notEqual(row.display.chat, 'Old synthetic title');
});

test('scope validation and final commit bind the same exact scope snapshot', t => {
  const f = fixture(t), scopeId = chatScopeId(CHAT);
  sqliteExec(f.db, `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json)
    VALUES(${quoteSql(scopeId)},'lark.im','Synthetic scoped chat',0,
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`, 'create synthetic exact scope');
  let raced = false;
  run(f, { readOnlyQuery: (db, sql, label, options) => {
    const result = readOnlySqliteJson(db, sql, label, options);
    if (label === 'read exact name scope' && !raced) {
      raced = true;
      sqliteExec(db, `UPDATE sync_scopes SET config_json=${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'p2p' }))}
        WHERE id=${quoteSql(scopeId)};`, 'inject concurrent scope change before admission capture');
    }
    return result;
  } });
  assert.ok(raced);
  const task = sqliteQuery(f.db, "SELECT evidence_json FROM lark_im_name_tasks WHERE kind='chat';", 'inspect title after concurrent scope change')[0];
  assert.equal(task.evidence_json, null, 'a newly conflicting scope must invalidate the prepared group observation');
  const canonical = JSON.parse(sqliteQuery(f.db, 'SELECT canonical_json FROM records WHERE id=1;', 'inspect authored record')[0].canonical_json);
  assert.equal(canonical.chat_name_account_key, undefined);
});

test('one ambiguous scope cannot starve unrelated due chat tasks', t => {
  const f = fixture(t), secondChat = 'oc_adversarial_synthetic_second';
  run(f);
  f.now += 86400001;
  const row = sqliteQuery(f.db, 'SELECT * FROM records WHERE id=1;', 'read authored template')[0];
  const canonical = JSON.parse(row.canonical_json), raw = JSON.parse(row.raw_json);
  canonical.message_id = raw.message_id = 'om_adversarial_synthetic_second';
  canonical.chat_id = raw.chat_id = secondChat;
  delete canonical.chat_name_account_key;
  sqliteExec(f.db, `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json)
    VALUES(${quoteSql(chatScopeId(CHAT))},'lark.im','Synthetic ambiguous scope',0,
      ${quoteSql(`{"chat_id":"${CHAT}","chat_type":"group","chat_type":"p2p"}`)});
    INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
      VALUES(2,'lark.im','lark.im.sent_by_me',${quoteSql(raw.message_id)},'synthetic-version','lark.im.message',
        ${quoteSql(SELF)},${quoteSql(secondChat)},'sent','Second authored body',${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`,
    'author a stale malformed scope and an independent eligible chat');
  for (let i = 0; i < 8; i++) { run(f); f.now += 60001; }
  const second = sqliteQuery(f.db, `SELECT evidence_json FROM lark_im_name_tasks WHERE kind='chat' AND chat_id=${quoteSql(secondChat)};`,
    'inspect unrelated due task')[0];
  assert.ok(second?.evidence_json, 'malformed metadata for one chat must not hold the whole chat queue indefinitely');
});

test('an invalid initial monotonic clock cannot admit optional work', t => {
  const f = fixture(t);
  let observations = 0;
  const result = run(f, { monotonicNow: () => observations++ === 0 ? Number.NaN : 0 });
  assert.equal(result.calls, 0);
  assert.equal(sqliteQuery(f.db, 'SELECT count(*) AS n FROM lark_im_name_tasks;', 'inspect invalid-clock state')[0].n, 0);
});

test('contradictory official group/p2p declarations cannot supply a group title', t => {
  const f = fixture(t);
  run(f, { runLark: args => args[0] === 'contact' ? { open_id: SELF }
    : { code: 0, data: { chat_id: CHAT, chat_mode: 'group', chat_type: 'p2p', name: 'Conflicting synthetic title' } } });
  assert.equal(sqliteQuery(f.db, "SELECT evidence_json FROM lark_im_name_tasks WHERE kind='chat';", 'inspect contradictory metadata')[0].evidence_json, null);
});

test('a sent row with a contradictory raw sender cannot acquire current-account title evidence', t => {
  const f = fixture(t, 2, { alter: (id, canonical, raw) => {
    if (id === 1) raw.sender.id = 'ou_adversarial_synthetic_other';
  } });
  run(f);
  const row = sqliteQuery(f.db, 'SELECT canonical_json FROM records WHERE id=1;', 'inspect contradictory sent source')[0];
  assert.equal(JSON.parse(row.canonical_json).chat_name_account_key, undefined);
});
