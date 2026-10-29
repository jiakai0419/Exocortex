import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncRecipients } from '../src/adapters/lark-im/recipient-sync.mjs';
import { enrichRecipients } from '../src/maintenance/enrich-recipients.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { makeRecipientEvidence, readRecipientEvidence, recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { ensureInitialized, quoteSql, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';

// Every account, record, timestamp and database in this file is authored here.
const SELF = 'ou_synthetic_auto_self', PEER = 'ou_synthetic_auto_peer';
const NOW = Date.parse('2025-04-05T06:07:08.000Z'), WAIT = 5 * 60_000;
const sql = (f, value) => sqliteExec(f.db, value, 'authored automatic recipient fixture');
const query = (f, value) => sqliteQuery(f.db, value, 'inspect authored automatic recipient fixture');
const states = f => query(f, 'SELECT * FROM lark_im_recipient_state ORDER BY chat_id;');
const retries = f => states(f).filter(state => state.retry_at_ms !== Number.MAX_SAFE_INTEGER);
const records = f => query(f, 'SELECT * FROM records ORDER BY id;');
const configs = f => query(f, 'SELECT * FROM sync_scopes ORDER BY id;');
const chat = id => `oc_synthetic_auto_chat_${id}`;
function fixture(t, count = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-auto-recipient-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { db: join(dir, 'authored.sqlite'), now: NOW, elapsed: 0, calls: [], selected: [] };
  ensureInitialized(f.db);
  for (let id = 1; id <= count; id += 1) add(f, id);
  return f;
}
function add(f, id, options = {}) {
  const container = options.chat || chat(id), scopeId = chatScopeId(container);
  const raw = { message_id: `om_synthetic_auto_${id}`, chat_id: container,
    sender: { id: SELF, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'Synthetic text stays exactly unchanged.' }) }, ...options.raw };
  const canonical = { message_id: raw.message_id, chat_id: container, sender_id: SELF,
    sender_id_type: 'open_id', chat_type: 'p2p', ...options.canonical };
  const config = { chat_id: container, chat_type: 'p2p', untouched: ['keep', 7], ...options.config };
  sql(f, `${options.orphan ? '' : `INSERT OR IGNORE INTO sync_scopes(id,source_id,name,enabled,config_json,created_at)
    VALUES(${quoteSql(scopeId)},'lark.im',${quoteSql(`synthetic.scope.${id}`)},${options.enabled ?? 1},
      ${quoteSql(JSON.stringify(config))},${quoteSql(new Date(f.now - 86400000 + id).toISOString())});`}
    INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,actor_id,container_id,direction,body,canonical_json,raw_json)
    VALUES(${id},'lark.im','lark.im.sent_by_me',${quoteSql(raw.message_id)},'opaque-v1','lark.im.message',
      ${quoteSql(SELF)},${quoteSql(container)},${quoteSql(options.direction || 'sent')},'Synthetic text stays exactly unchanged.',
      ${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`);
  return scopeId;
}
function evidence(container, overrides = {}) {
  return { ...makeRecipientEvidence(container, SELF, { id_type: 'open_id', id: PEER }, 'Synthetic Automatic Peer', new Date(NOW).toISOString()), ...overrides };
}
function setEvidence(f, id, value) {
  sql(f, `INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,evidence_json)
    VALUES('lark.im',${quoteSql(recipientAccountKey(SELF))},${quoteSql(chat(id))},${quoteSql(JSON.stringify(value))})
    ON CONFLICT(source_id,account_key,chat_id) DO UPDATE SET evidence_json=excluded.evidence_json;`);
}
function fakeCore(f, settings = {}) {
  return (opts, deps) => {
    assert.equal(opts.dryRun, false);
    assert.ok(opts.recordIds.length <= 20);
    f.selected.push(...opts.recordIds);
    const targets = query(f, `SELECT * FROM records WHERE id IN (${opts.recordIds.join(',')});`);
    assert.equal(retries(f).length >= targets.length, true, 'claim exists before any remote work');
    for (let index = 0; index < (settings.calls ?? 4); index += 1) deps.runLark(['synthetic', String(index)], { retries: 5 });
    if (settings.throwAfterCalls) throw new Error('Synthetic interrupted process');
    let updated = 0;
    for (const row of targets) {
      const outcome = settings.outcome || 'resolved';
      if (['resolved', 'name_missing'].includes(outcome)) {
        const value = evidence(row.container_id, outcome === 'name_missing' ? { name_source: null, recipient: { id_type: 'open_id', id: PEER, name: null } } : {});
        sql(f, `UPDATE lark_im_recipient_state SET evidence_json=${quoteSql(JSON.stringify(value))}
          WHERE account_key=${quoteSql(recipientAccountKey(SELF))} AND chat_id=${quoteSql(row.container_id)};`);
        updated += 1;
      }
      deps.onRecipientResult({ chat_id: row.container_id, outcome });
    }
    return { updated };
  };
}
function run(f, settings = {}, deps = {}) {
  return syncRecipients(f.db, { open_id: SELF }, { now: () => f.now, monotonicNow: () => f.elapsed,
    runLark: (args, options) => {
      f.calls.push(args);
      assert.equal(options.retries, 0);
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
      assert.ok(options.retryBudgetMs > 0 && options.retryBudgetMs <= 10000);
      assert.equal(query(f, 'SELECT count(*) AS n FROM maintenance_locks;')[0].n, 0);
      f.elapsed += settings.callMs || 0;
      return {};
    }, enrichRecipients: fakeCore(f, settings), ...deps });
}
function assertPublic(report) { assert.doesNotMatch(JSON.stringify(report), /ou_synthetic|oc_synthetic|om_synthetic|Synthetic|authored\.sqlite/); }

test('real transport without an inherited sync lease makes no claims or requests', t => {
  const f = fixture(t), before = readFileSync(f.db);
  const report = syncRecipients(f.db, { open_id: SELF });
  assert.equal(report.reason, 'lease_unavailable');
  assert.deepEqual(readFileSync(f.db), before);
});

test('first and historical scopes, including disabled, are repaired without message or enablement changes', t => {
  const f = fixture(t, 2);
  sql(f, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(chatScopeId(chat(2)))};`);
  const before = records(f), source = query(f, 'SELECT * FROM sources;'), scopes = configs(f);
  const report = run(f);
  assert.equal(report.updated, 2);
  assert.equal(report.calls, 4);
  assert.deepEqual(f.selected.slice().sort((a,b)=>a-b), [1, 2]);
  assert.deepEqual(records(f), before);
  assert.deepEqual(query(f, 'SELECT * FROM sources;'), source);
  for (const old of scopes) {
    const current = configs(f).find(row => row.id === old.id);
    for (const key of Object.keys(old)) if (key !== 'config_json') assert.equal(current[key], old[key]);
  }
  assert.equal(retries(f).length, 0);
  assertPublic(report);
});

test('complete names cost zero network calls and zero database writes across a full bounded window', t => {
  const f = fixture(t, 25);
  for (let id = 1; id <= 24; id += 1) setEvidence(f, id, evidence(chat(id)));
  const report = run(f);
  assert.equal(report.updated, 1);
  assert.deepEqual(f.selected, [25], 'completed scopes never occupy the bounded candidate window');
  const before = readFileSync(f.db), next = run(f);
  assert.equal(next.calls, 0);
  assert.deepEqual(readFileSync(f.db), before);
});

test('bounded fair batches admit at most twenty scopes, then service the remainder', t => {
  const f = fixture(t, 25);
  const first = run(f, { outcome: 'unresolved' });
  assert.equal(first.attempted, 20);
  const firstIds = new Set(f.selected);
  f.selected = [];
  run(f, { outcome: 'unresolved' });
  assert.equal(f.selected.length, 5);
  assert.ok(f.selected.every(id => !firstIds.has(id)));
  assert.equal(retries(f).length, 25);
});

test('due failures precede continuously added newer chats and retry_at is only an eligibility gate', t => {
  const f = fixture(t);
  run(f, { outcome: 'failed' });
  f.now += WAIT + 1;
  for (let id = 2; id <= 25; id += 1) {
    add(f, id);
    sql(f, `UPDATE sync_scopes SET created_at=${quoteSql(new Date(f.now).toISOString())} WHERE id=${quoteSql(chatScopeId(chat(id)))};`);
  }
  f.selected = [];
  run(f, { outcome: 'failed' });
  assert.equal(f.selected[0], 1);
  assert.equal(f.selected.length, 20);
});

test('failure claims survive interruption, defer a repeat, and leave history/config context untouched', t => {
  const f = fixture(t);
  sql(f, `INSERT INTO lark_im_history_round(scope_id,round,baseline_sweeps) VALUES(${quoteSql(chatScopeId(chat(1)))},1,0);`);
  const before = configs(f), beforeRecords = records(f);
  const first = run(f, { throwAfterCalls: true });
  assert.equal(first.reason, 'deferred');
  assert.equal(retries(f)[0].failures, 0, 'interruption is not a permission failure');
  assert.equal(run(f).calls, 0);
  assert.deepEqual(configs(f), before);
  assert.deepEqual(records(f), beforeRecords);
  assert.equal(query(f, 'SELECT count(*) AS n FROM lark_im_history_round;')[0].n, 1);
  f.now += WAIT + 1;
  assert.equal(run(f).updated, 1);
});

test('request count and elapsed budget cannot grow beyond four calls and ten seconds', t => {
  const f = fixture(t);
  const first = run(f, { calls: 5 });
  assert.equal(first.reason, 'budget');
  assert.equal(first.calls, 4);
  f.now += WAIT + 1;
  f.calls = [];
  const second = run(f, { callMs: 5000 });
  assert.equal(second.reason, 'budget');
  assert.equal(second.calls, 2);
  assert.equal(retries(f)[0].failures, 0);
});

test('a missing name retries with backoff and recovers; lost evidence invalidates an old future retry', t => {
  const f = fixture(t);
  assert.equal(run(f, { outcome: 'name_missing' }).updated, 1);
  assert.equal(retries(f)[0].failures, 1);
  assert.equal(run(f).calls, 0);
  sql(f, `UPDATE lark_im_recipient_state SET evidence_json=NULL WHERE chat_id=${quoteSql(chat(1))};`);
  assert.equal(run(f).updated, 1, 'changed evidence is due even before prior retry_at');
  assert.equal(retries(f).length, 0);
  sql(f, `DELETE FROM lark_im_recipient_state WHERE chat_id=${quoteSql(chat(1))};`);
  assert.equal(run(f).updated, 1, 'a successful task cannot mask later cache loss');
});

test('native sent scans bypass malformed rows without poisoning valid chats', t => {
  const f = fixture(t, 0);
  for (let id = 1; id <= 9; id += 1) add(f, id, { chat: chat(1), raw: { sender: { id: SELF } } });
  add(f, 10, { chat: chat(1) });
  add(f, 11);
  const before = records(f);
  assert.equal(run(f).updated, 2);
  assert.deepEqual(f.selected.slice().sort((a,b)=>a-b), [10, 11]);
  assert.deepEqual(records(f), before);
});

test('received-only and group scopes never enter the automatic relationship workflow', t => {
  const f = fixture(t, 0);
  add(f, 1, { direction: 'received' });
  add(f, 2, { config: { chat_type: 'group' } });
  const before = configs(f), beforeRecords = records(f);
  assert.equal(run(f).calls, 0);
  assert.equal(retries(f).length, 0);
  assert.deepEqual(configs(f), before);
  assert.deepEqual(records(f), beforeRecords);
});

test('a different account cannot consume or replace local relationship evidence', t => {
  const f = fixture(t), before = readFileSync(f.db);
  const report = syncRecipients(f.db, { open_id: 'ou_synthetic_other_account' }, { runLark: () => assert.fail('no cross-account calls') });
  assert.equal(report.reason, 'unavailable');
  assert.deepEqual(readFileSync(f.db), before);
});

for (const [label, change] of [
  ['Unicode whitespace', e => { e.recipient.name = '\u00a0\u1680\u2003\u2028\u202f\u205f\u3000\ufeff'; }],
  ['peer ID echo', e => { e.recipient.name = `\u2003${PEER}\u00a0`; }],
  ['self ID echo', e => { e.recipient.name = SELF; }],
  ['chat ID echo', e => { e.recipient.name = chat(1); }],
  ['invalid open ID character', e => { e.recipient.id += '!'; }],
  ['embedded open ID NUL', e => { e.recipient.id += '\0!'; }],
  ['oversized open ID', e => { e.recipient.id = `ou_${'a'.repeat(510)}`; }],
  ['nonobject recipient', e => { e.recipient = []; }],
  ['invalid calendar date', e => { e.observed_at = '2025-02-30T06:07:08.000Z'; }],
  ['future observation', e => { e.observed_at = new Date(NOW + 1000).toISOString(); }],
  ['different evidence account', e => { e.account_key = recipientAccountKey('ou_synthetic_other'); }],
  ['malformed conflict', e => { e.conflict = {}; }],
  ['valid conflict', e => { e.conflict = { schema: 'lark_p2p_recipient_conflict/v1', identity_source: 'im.v1.chats.batch_query',
    recipient: { id_type: 'open_id', id: 'ou_synthetic_different_peer' }, observed_at: e.observed_at }; }],
]) test(`${label} is never hidden by SQL completion filtering`, t => {
  const f = fixture(t), value = evidence(chat(1)); change(value);
  assert.ok(!readRecipientEvidence({ chat_id: chat(1), p2p_recipient: value }, SELF, { nowMs: NOW })?.name);
  setEvidence(f, 1, value);
  assert.equal(run(f, { outcome: 'unresolved' }).attempted, 1);
});

test('explicit null conflict and surrounding Unicode whitespace preserve a complete valid cache', t => {
  const f = fixture(t), value = evidence(chat(1), { conflict: null });
  value.recipient.name = '\u2003Synthetic Automatic Peer\u00a0';
  setEvidence(f, 1, value);
  const before = states(f).map(state=>state.evidence_json), beforeScopes = configs(f);
  assert.equal(run(f).calls, 0);
  assert.deepEqual(states(f).map(state=>state.evidence_json), before);
  assert.deepEqual(configs(f), beforeScopes);
});

function coreApi(f, settings = {}) {
  let profiles = 0;
  return (args, options) => {
    f.calls.push(args);
    assert.equal(options.retries, 0);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    assert.equal(query(f, 'SELECT count(*) AS n FROM maintenance_locks;')[0].n, 0);
    settings.onCall?.(args);
    if (args[0] === 'contact' && args[1] === '+get-user') {
      profiles += 1;
      return { open_id: settings.switchAccount && profiles === 2 ? 'ou_synthetic_other_account' : SELF };
    }
    if (args[0] === 'api' && args[1] === 'POST' && args[2] === '/open-apis/im/v1/chats/batch_query') {
      const { chat_ids } = JSON.parse(args[args.indexOf('--data') + 1]);
      assert.ok(chat_ids.length <= 20);
      assert.deepEqual(JSON.parse(args[args.indexOf('--params') + 1]), { user_id_type: 'open_id' });
      if (settings.batchError) throw new Error(typeof settings.batchError === 'string' ? settings.batchError : 'Synthetic permission failure');
      return { code: 0, data: { items: chat_ids.map(chat_id => ({ chat_id, chat_mode: 'p2p',
        p2p_target_type: 'user', p2p_target_id: PEER, ...(settings.batchMode ? { chat_mode: settings.batchMode } : {}) })) } };
    }
    if (args[0] === 'contact' && args[1] === '+search-user') {
      if (settings.nameError) throw new Error('Synthetic name lookup failure');
      return { users: [{ open_id: PEER, name: 'Synthetic Automatic Peer' }] };
    }
    assert.fail('unexpected synthetic automatic request');
  };
}

test('automatic path executes the real shared core for twenty chats with one batch, one contacts lookup and two profiles', t => {
  const f = fixture(t, 20), before = records(f);
  const report = run(f, {}, { enrichRecipients, runLark: coreApi(f) });
  assert.equal(report.reason, 'completed');
  assert.deepEqual([report.updated, report.attempted, report.calls], [20, 20, 4]);
  assert.equal(retries(f).length, 0);
  assert.deepEqual(records(f), before);
  assert.equal(f.calls.filter(args => args[0] === 'api').length, 1);
  assertPublic(report);
});

test('real core name failure persists only verified identity, then repairs the missing name on a due retry', t => {
  const f = fixture(t), before = records(f);
  const first = run(f, {}, { enrichRecipients, runLark: coreApi(f, { nameError: true }) });
  assert.equal(first.updated, 1);
  assert.equal(retries(f)[0].failures, 1);
  f.now += WAIT + 1;
  assert.equal(run(f, {}, { enrichRecipients, runLark: coreApi(f) }).updated, 1);
  assert.equal(retries(f).length, 0);
  assert.deepEqual(records(f), before);
});

test('API permission failure remains bounded and retries without modifying chat configuration or history context', t => {
  const f = fixture(t), before = configs(f);
  const report = run(f, {}, { enrichRecipients, runLark: coreApi(f, { batchError: true }) });
  assert.equal(report.calls, 3);
  assert.equal(report.updated, 0);
  assert.deepEqual(configs(f), before);
  assert.equal(retries(f)[0].failures, 1);
  assert.equal(run(f).calls, 0);
});

for (const kind of ['record', 'scope', 'source', 'profile']) test(`real core fences ${kind} changes during remote lookup`, t => {
  const f = fixture(t);
  const report = run(f, {}, { enrichRecipients, runLark: coreApi(f, { switchAccount: kind === 'profile',
    onCall: args => {
      if (args[0] !== 'api') return;
      if (kind === 'record') sql(f, "UPDATE records SET body='Synthetic concurrent replacement' WHERE id=1;");
      if (kind === 'scope') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.synthetic_race',1) WHERE id=${quoteSql(chatScopeId(chat(1)))};`);
      if (kind === 'source') sql(f, "UPDATE sources SET config_json=json_set(config_json,'$.synthetic_race',1) WHERE id='lark.im';");
    } }) });
  assert.equal(report.updated, 0);
  assert.equal(report.reason, 'deferred');
  const scope = configs(f).find(row => row.id === chatScopeId(chat(1)));
  assert.equal(JSON.parse(scope.config_json).p2p_recipient, undefined);
  assert.equal(retries(f)[0].failures, 0, 'fence rejection does not become a permission failure');
  assertPublic(report);
});

test('an active sync scope lock rejects the short claim without requests or scheduler writes', t => {
  const f = fixture(t);
  sql(f, `INSERT INTO sync_locks(scope_id,locked_by,locked_at,expires_at) VALUES(${quoteSql(chatScopeId(chat(1)))},
    'synthetic-lock',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'));`);
  const report = run(f);
  assert.equal(report.calls, 0);
  assert.equal(retries(f).length, 0);
  assert.equal(report.reason, 'unavailable');
});

test('mismatched chat scope identities cannot poison an eligible later chat', t => {
  const f = fixture(t, 21);
  for (let id = 1; id <= 20; id += 1) sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.chat_id',${quoteSql(chat(21))}) WHERE id=${quoteSql(chatScopeId(chat(id)))};`);
  assert.equal(run(f).updated, 1);
  assert.equal(retries(f).length, 0);
  assert.deepEqual(f.selected, [21]);
});

test('duplicate scope JSON keys cannot hide broken evidence or poison other chats in the batch', t => {
  const f = fixture(t, 2);
  const config = `{"chat_id":${JSON.stringify(chat(1))},"chat_type":"p2p","p2p_recipient":${JSON.stringify(evidence(chat(1)))},"p2p_recipient":null}`;
  sql(f, `UPDATE sync_scopes SET config_json=${quoteSql(config)} WHERE id=${quoteSql(chatScopeId(chat(1)))};`);
  const report = run(f, {}, { enrichRecipients, runLark: coreApi(f) });
  assert.equal(report.updated, 1);
  assert.equal(report.deferred, 0);
  assert.equal(retries(f).length, 0);
  assert.equal(configs(f).find(row => row.id === chatScopeId(chat(1))).config_json, config);
});

test('an inherited shared cooldown is deferred without counting an unrequested permission failure', t => {
  const f = fixture(t), before = configs(f);
  const report = run(f, {}, { enrichRecipients, runLark: coreApi(f,
    { batchError: 'lark-cli failed: kind=rate_limited retry_after_source=shared operation=other retry_exhausted=1' }) });
  assert.equal(report.reason, 'deferred');
  assert.equal(retries(f)[0].failures, 0);
  assert.deepEqual(configs(f), before);
  assert.equal(run(f).calls, 0);
});

test('a deadline reached between readiness and invocation never passes zero as a transport fallback budget', t => {
  const f = fixture(t);
  let edge = false, reads = 0;
  const report = run(f, {}, {
    monotonicNow: () => edge ? (++reads === 1 ? 9999 : 10000) : 0,
    enrichRecipients: (_opts, deps) => { edge = true; deps.runLark(['synthetic']); return { updated: 0 }; },
    runLark: () => assert.fail('expired request must not reach transport'),
  });
  assert.equal(report.reason, 'budget');
  assert.equal(report.calls, 0);
  assert.equal(retries(f)[0].failures, 0);
});

test('never-discovered muted sent chats are repaired without creating a scope or changing existing ingestion state', t => {
  const f = fixture(t, 0);
  add(f, 1, { orphan: true });
  const before = { records: records(f), scopes: configs(f), sources: query(f,'SELECT * FROM sources;'), runs: query(f,'SELECT * FROM sync_runs;') };
  const result = run(f, {}, { enrichRecipients, runLark: coreApi(f) });
  assert.deepEqual([result.updated,result.calls], [1,4]);
  assert.equal(states(f).length, 1);
  assert.equal(JSON.parse(states(f)[0].evidence_json).recipient.name, 'Synthetic Automatic Peer');
  assert.deepEqual({ records: records(f), scopes: configs(f), sources: query(f,'SELECT * FROM sources;'), runs: query(f,'SELECT * FROM sync_runs;') }, before);
  // Later discovery neither removes the independent observation nor causes a refresh.
  sql(f, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(chatScopeId(chat(1)))},'lark.im','synthetic.later.discovery',
    ${quoteSql(JSON.stringify({chat_id:chat(1),chat_type:'p2p'}))});`);
  assert.equal(run(f).calls, 0);
  assert.equal(JSON.parse(states(f)[0].evidence_json).recipient.name, 'Synthetic Automatic Peer');
});

for (const kind of [undefined, null, 'unknown']) test(`scope type ${String(kind)} can be confirmed by the official relationship response`, t => {
  const f = fixture(t, 0); add(f,1,{config:{chat_type:kind}});
  const before = configs(f);
  assert.equal(run(f,{}, {enrichRecipients,runLark:coreApi(f)}).updated,1);
  assert.deepEqual(configs(f),before);
});

test('an orphan whose official response is group never acquires a private recipient', t => {
  const f = fixture(t,0); add(f,1,{orphan:true,canonical:{chat_type:'unknown'}});
  const before = configs(f);
  assert.equal(run(f,{}, {enrichRecipients,runLark:coreApi(f,{batchMode:'group'})}).updated,0);
  assert.equal(states(f)[0].evidence_json,null);
  assert.deepEqual(configs(f),before);
});

test('valid legacy evidence migrates with no network, and later scope cache loss cannot remove it', t => {
  const f=fixture(t), value=evidence(chat(1));
  sql(f,`UPDATE sync_scopes SET config_json=json_set(config_json,'$.p2p_recipient',json(${quoteSql(JSON.stringify(value))})) WHERE id=${quoteSql(chatScopeId(chat(1)))};`);
  const before=configs(f), messages=records(f);
  assert.equal(run(f).calls,0);
  assert.deepEqual(JSON.parse(states(f)[0].evidence_json),value);
  assert.equal(states(f)[0].retry_at_ms,Number.MAX_SAFE_INTEGER);
  assert.deepEqual(configs(f),before);
  sql(f,`UPDATE sync_scopes SET config_json=json_remove(config_json,'$.p2p_recipient') WHERE id=${quoteSql(chatScopeId(chat(1)))};`);
  assert.equal(run(f).calls,0);
  assert.deepEqual(JSON.parse(states(f)[0].evidence_json),value);
  assert.deepEqual(records(f),messages);
});

test('new and historical lanes enqueue skipped chats and keep strict sent-read and remote quotas', t => {
  const f=fixture(t,0);
  for(let id=1;id<=120;id++) add(f,id,{orphan:true});
  let pages=[];
  const reader=(db,statement,label,options)=>{
    const rows=readOnlySqliteJson(db,statement,label,options);
    if(label==='read recipient witness headers') {
      const queue=statement.includes('INDEXED BY records_recipient_sent_container_id');
      const limit=queue?8:40;
      assert.match(statement,new RegExp(`LIMIT ${limit+1};$`));
      assert.ok(rows.length<=limit+1,'lookahead reads at most one additional small header');
      for(const row of rows)assert.deepEqual(Object.keys(row).sort(),['bytes','id'],'lookahead never materializes message payload');
      pages.push({queue,limit,headers:rows.length,payload:0,payloadReads:0});
    } else if(label==='read bounded recipient witness payloads') {
      const page=pages.at(-1);assert.ok(page,'payload belongs to an already bounded header page');
      assert.equal(page.payloadReads,0,'a page cannot repeatedly rematerialize the same payload outside its quota');page.payloadReads+=1;
      assert.ok(rows.length<=page.limit,'full payload never inherits the extra lookahead slot');
      assert.ok(rows.every(row=>row.__recipient_payload_ok===1),'all authored witnesses fit the capacity budget');
      page.payload=rows.length;
    }
    return rows;
  };
  const first=run(f,{}, {readOnlyQuery:reader});
  assert.equal(first.attempted,20);
  assert.equal(first.calls,4);
  assert.equal(pages.length,2);
  assert.ok(pages.every(page=>!page.queue));
  assert.equal(pages.reduce((sum,page)=>sum+page.headers,0),82,'two 40-row pages each inspect one small lookahead header');
  assert.equal(pages.reduce((sum,page)=>sum+page.payload,0),80,'only the original 80 full witnesses are materialized');
  assert.equal(states(f).length,80,'every valid scanned chat is queued even if this call did not query it');
  assert.equal(query(f,'SELECT after_record_id FROM lark_im_recipient_scan;')[0].after_record_id,40);
  assert.ok(f.selected.some(id=>id<=40) && f.selected.some(id=>id>80));
  pages=[];f.selected=[];f.now+=1000;
  const second=run(f,{}, {readOnlyQuery:reader});
  assert.equal(pages.filter(page=>!page.queue).length,2);
  assert.ok(pages.filter(page=>page.queue).length<=10,'due witnesses retain their ten-chat quota');
  assert.ok(pages.reduce((sum,page)=>sum+page.headers,0)<=2*41+10*9);
  assert.ok(pages.reduce((sum,page)=>sum+page.payload,0)<=2*40+10*8,'the full-payload ceiling remains 160, not the header ceiling');
  assert.equal(second.attempted,20);
  assert.equal(second.calls,4);
  assert.equal(states(f).length,120);
  assert.equal(query(f,'SELECT after_record_id FROM lark_im_recipient_scan;')[0].after_record_id,80);
  assert.ok(f.selected.some(id=>id>=41&&id<=80),'historical lane advances despite ready queued and latest chats');
  assert.ok(f.selected.some(id=>id<=40),'earlier unselected history remains fairly queued');
});

test('a deleted old relationship is rediscovered when the bounded historical cursor wraps', t => {
  const f=fixture(t,0);
  for(let id=1;id<=85;id++){ add(f,id,{orphan:true});setEvidence(f,id,evidence(chat(id))); }
  run(f);run(f);run(f);
  sql(f,`DELETE FROM lark_im_recipient_state WHERE chat_id=${quoteSql(chat(1))};`);
  const result=run(f);
  assert.equal(result.updated,1);
  assert.ok(states(f).find(state=>state.chat_id===chat(1))?.evidence_json);
  assert.equal(configs(f).some(scope=>scope.id===chatScopeId(chat(1))),false);
});

for(const kind of ['size','depth','nodes']) test(`a ${kind}-limit violation cannot remain certified complete or poison another chat`,t=>{
  const f=fixture(t,2);
  setEvidence(f,1,evidence(chat(1)));run(f);
  const value=evidence(chat(1));
  if(kind==='size') value.extra='x'.repeat(1024*1024);
  else if(kind==='depth'){let nested={};for(let i=0;i<70;i++)nested={nested};value.extra=nested;}
  else value.extra=Array.from({length:20001},()=>0);
  setEvidence(f,1,value);
  sql(f,`UPDATE lark_im_recipient_state SET evidence_json=NULL WHERE chat_id=${quoteSql(chat(2))};`);
  const report=run(f,{}, {enrichRecipients,runLark:coreApi(f)});
  assert.equal(report.updated,2);
  assert.equal(report.calls,4);
  assert.equal(JSON.parse(states(f).find(state=>state.chat_id===chat(1)).evidence_json).extra,undefined);
});

test('changed evidence has a fixed queue share even while older due failures occupy their lane',t=>{
  const f=fixture(t,25);run(f,{outcome:'failed'});run(f,{outcome:'failed'});
  for(let id=21;id<=25;id++)setEvidence(f,id,evidence(chat(id)));
  run(f);
  for(let id=21;id<=25;id++)sql(f,`UPDATE lark_im_recipient_state SET evidence_json=NULL WHERE chat_id=${quoteSql(chat(id))};`);
  f.now+=WAIT+1;f.selected=[];
  run(f);
  assert.ok(f.selected.filter(id=>id>=21).length>=5);
  assert.ok(f.selected.some(id=>id<21));
});


// Observe the real core's actual sqlite child boundary; do not substitute an
// enrichment stub or fabricate timeout options in the test's reader.
function observeRecipientSqlite(f, onSql = () => {}) {
  const original = childProcess.spawnSync, observed = [];
  let claimed = false;
  childProcess.spawnSync = function(command, args, options = {}) {
    const input = String(options.input || '');
    if (command !== 'sqlite3') return original.call(this, command, args, options);
    if (input.includes('recipient-sync-claim')) claimed = true;
    const event = { readonly: args.includes('-readonly'), claimed, input,
      timeout: options.timeout, elapsed: f.elapsed };
    observed.push(event);
    const result = original.call(this, command, args, options);
    onSql(event);
    return result;
  };
  syncBuiltinESMExports();
  return { observed, restore() { childProcess.spawnSync = original; syncBuiltinESMExports(); } };
}

test('real recipient core SQLite reads share the remaining deadline through result admission', t => {
  const f = fixture(t, 20), before = records(f);
  const probe = observeRecipientSqlite(f, event => { if (event.readonly) f.elapsed += 11; });
  let report;
  try {
    report = run(f, {}, { enrichRecipients, runLark: coreApi(f, { onCall: () => { f.elapsed += 23; } }) });
  } finally { probe.restore(); }
  assert.equal(report.reason, 'completed');
  assert.deepEqual([report.updated, report.attempted, report.calls], [20, 20, 4]);
  assert.equal(retries(f).length, 0);
  assert.deepEqual(records(f), before);
  const reads = probe.observed.filter(row => row.readonly), afterClaim = reads.filter(row => row.claimed);
  assert(afterClaim.length >= 10, 'the actual core and result admission were exercised');
  assert(afterClaim.some(row => row.input.includes('SELECT enabled,config_json FROM sources')));
  assert(afterClaim.some(row => row.input.includes('FROM records') && row.input.includes('WHERE id IN')));
  for (const row of reads) assert.equal(row.timeout, 10000 - row.elapsed,
    'each actual readonly SQLite child retains the enclosing remaining deadline');
  assert(afterClaim.every(row => row.timeout < 10000));
});

for (const point of ['claim_commit', 'core_source', 'core_targets', 'core_scopes', 'core_state',
  'opening_self', 'closing_self', 'commit_admission']) {
  test(`real recipient core expiry at ${point} starts no later read, request or evidence publication`, t => {
    const f = fixture(t), before = records(f); let fired = false, profiles = 0, postClosingReads = 0;
    const expire = () => { fired = true; f.elapsed = 10000; };
    const probe = observeRecipientSqlite(f, row => {
      if (fired || !row.claimed) return;
      if (point === 'claim_commit' && !row.readonly && row.input.includes('UPDATE lark_im_recipient_state SET last_attempt_at_ms=')) expire();
      if (!row.readonly) return;
      if (point === 'core_source' && row.input.includes('SELECT enabled,config_json FROM sources')) expire();
      if (point === 'core_targets' && row.input.includes('FROM records') && row.input.includes('WHERE id IN')) expire();
      if (point === 'core_scopes' && row.input.includes('SELECT id,source_id,enabled,config_json,updated_at FROM sync_scopes')) expire();
      if (point === 'core_state' && row.input.includes('SELECT source_id,account_key,chat_id,evidence_json FROM lark_im_recipient_state')) expire();
      if (profiles === 2) {
        postClosingReads += 1;
        // setSelf, explicit assertCurrent, then the existing commit recheck.
        if (point === 'commit_admission' && postClosingReads === 3) expire();
      }
    });
    let report;
    try {
      report = run(f, {}, { enrichRecipients, runLark: coreApi(f, { onCall(args) {
        assert(f.elapsed < 10000, 'expired optional tail cannot invoke a remote call');
        if (args[0] === 'contact' && args[1] === '+get-user') {
          profiles += 1;
          if (point === 'opening_self' && profiles === 1 || point === 'closing_self' && profiles === 2) expire();
        }
      } }) });
    } finally { probe.restore(); }
    assert(fired, 'the intended real core boundary was reached');
    assert.equal(probe.observed.filter(row => row.readonly && row.elapsed >= 10000).length, 0,
      'no actual read starts after the same enclosing deadline');
    assert.notEqual(report.reason, 'completed');
    assert.equal(report.updated, 0);
    const saved = states(f);
    assert.equal(saved.length, 1);assert.equal(saved[0].generation, 1);
    assert(saved[0].attempt_token, 'the already committed exact claim remains recoverable');
    assert.equal(saved[0].evidence_json, null);assert.equal(saved[0].failures, 0);
    assert.equal(saved[0].retry_at_ms, NOW + WAIT);
    assert.deepEqual(records(f), before);
    assert(f.calls.length <= 4);
  });
}
