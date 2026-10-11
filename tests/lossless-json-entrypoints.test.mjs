import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../dist/storage/sqlite/ingestion-store.js';
import { mergeLarkNameProjectionSql } from '../dist/storage/sqlite/lark-name-projection.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { runLarkImSyncCli } from './helpers/sync-command.mjs';
import { patchJsonText } from '../dist/core/json-text-patch.js';

// Authored synthetic records, test-owned SQLite and fake/injected transports only.
const START = Date.parse('2025-08-09T10:11:12.000Z');
const CHAT = 'oc_lossless_fixture', SCOPE = chatScopeId(CHAT), SELF = { open_id: 'ou_lossless_self', name: 'Synthetic Self' };
const NUMBERS = '"unsafe":9007199254740993,"beyond":18446744073709551617,"decimal":0.12345678901234567890123456789,"exponent":1e400,"negative":-0';
const UNKNOWN = `{ "array" : [{${NUMBERS}},null] }`;
const q = store.quoteSql;
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-lossless-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tmp'));
  const db = join(dir, 'synthetic.sqlite'); store.ensureInitialized(db);
  const accountKey = createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex');
  const stamp = new Date(START).toISOString();
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: START,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND, account_key: accountKey, reserved_at: stamp, confirmed_at: stamp } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(SCOPE)},'lark.im','Synthetic scope',
      ${q(`{"chat_id":"${CHAT}","chat_type":"group","chat_name":null,"unknown":${UNKNOWN}}`)});`);
  const native = { message_id: 'om_lossless_fixture', chat_id: CHAT, create_time: String(START + 1000), update_time: String(START + 2000),
    msg_type: 'text', sender: { id: 'ou_lossless_author', id_type: 'open_id', sender_type: 'user', name: 'Synthetic Source Name' },
    body: { content: '{"text":"Synthetic body"}' } };
  const record = recordFromMessage(normalizeApiMessage(native), SCOPE, 'received');
  record.canonical_json = record.canonical_json.slice(0, -1) + `,"unknown":${UNKNOWN},"old_only":1e400}`;
  store.sqliteExec(db, store.upsertRecordsSql([record]));
  const fake = join(dir, 'fake-lark.mjs');
  writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.slice(0,3).join(' ') === 'im chats get') console.log(JSON.stringify({data:{name:'Synthetic Updated Chat'}}));
else if (args[0] === 'contact' && args[1] === '+get-user') console.log(JSON.stringify(${JSON.stringify(SELF)}));
else { process.stderr.write('unexpected synthetic request'); process.exit(1); }
`); chmodSync(fake, 0o700);
  return { dir, db, fake, native, ...extra };
}
const rows = f => store.sqliteQuery(f.db, 'SELECT * FROM records ORDER BY id;');
const scope = f => store.sqliteQuery(f.db, `SELECT * FROM sync_scopes WHERE id=${q(SCOPE)};`)[0];
function cli(f, target, args = []) {
  return spawnSync(process.execPath, ['tests/helpers/enrichment-cli.mjs', f.dir, 'maintenance', 'enrich', '--target', target,
    '--db', f.db, '--format', 'json', ...args], {
    encoding: 'utf8', env: { ...process.env, LARK_CLI: f.fake, TMPDIR: join(f.dir, 'tmp') },
  });
}
function noSourceChange(before, after) {
  for (const field of Object.keys(before)) if (!['canonical_json', 'updated_at'].includes(field)) assert.equal(after[field], before[field], field);
  assert.ok(after.canonical_json.includes(`"unknown":${UNKNOWN}`));
}

test('real names-only CLI succeeds with large unknown numbers; dry run, explicit deletion and repeat preserve source', t => {
  const f = fixture(t);
  const canonical = rows(f)[0].canonical_json.replace(/"sender_name":"[^"]*"/, '"sender_name":null')
    .slice(0, -1) + ',"sender_name_resolution_status":"unresolved_app_sender","sender_name_resolution_reason":"synthetic old reason"}';
  store.sqliteExec(f.db, `UPDATE records SET canonical_json=${q(canonical)};`);
  const before = rows(f)[0], bytes = readFileSync(f.db);
  const preview = cli(f, 'records', ['--names-only', '--record-id', String(before.id)]);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).planned, 1); assert.deepEqual(readFileSync(f.db), bytes);
  const applied = cli(f, 'records', ['--names-only', '--record-id', String(before.id), '--apply']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr); assert.equal(JSON.parse(applied.stdout).updated, 1);
  const after = rows(f)[0]; noSourceChange(before, after);
  assert.equal(JSON.parse(after.canonical_json).sender_name, 'Synthetic Source Name');
  assert.equal(JSON.parse(after.canonical_json).sender_name_resolution_status, undefined);
  assert.equal(JSON.parse(after.canonical_json).sender_name_resolution_reason, undefined);
  const repeated = cli(f, 'records', ['--names-only', '--record-id', String(before.id), '--apply']);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr); assert.equal(JSON.parse(repeated.stdout).updated, 0);
  assert.deepEqual(rows(f)[0], after);
});

test('real ordinary enrich edits nested partner fields without serializing unknown partner children', t => {
  const f = fixture(t), before = rows(f)[0];
  const canonical = patchJsonText(before.canonical_json, [{ path: ['chat_partner'],
    value: '{"open_id":"ou_lossless_partner","name":"Synthetic Partner","name_state":"cleared","unknown":18446744073709551617}' }], [['chat_partner']]);
  store.sqliteExec(f.db, `UPDATE records SET canonical_json=${q(canonical)};`);
  const result = cli(f, 'records', ['--apply']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const after = rows(f)[0]; noSourceChange({ ...before, canonical_json: canonical }, after);
  assert.match(after.canonical_json, /"unknown":18446744073709551617/);
  assert.equal(JSON.parse(after.canonical_json).chat_partner.name, 'Synthetic Partner');
  assert.equal(JSON.parse(after.canonical_json).chat_partner.name_state, undefined);
});

test('real scope CLI preserves every unknown numeric token and cursor in dry run and apply', t => {
  const f = fixture(t), before = scope(f), bytes = readFileSync(f.db);
  const preview = cli(f, 'scopes'); assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.equal(JSON.parse(preview.stdout).planned, 1); assert.deepEqual(readFileSync(f.db), bytes);
  const result = cli(f, 'scopes', ['--apply']); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const after = scope(f); assert.ok(after.config_json.includes(`"unknown":${UNKNOWN}`));
  assert.equal(JSON.parse(after.config_json).chat_name, 'Synthetic Updated Chat');
  for (const key of Object.keys(before)) if (!['config_json', 'updated_at'].includes(key)) assert.equal(after[key], before[key], key);
});

for (const target of ['records', 'scopes']) test(`real ${target} CLI rejects nested duplicate keys without changing the row`, t => {
  const f = fixture(t);
  const table = target === 'records' ? 'records' : 'sync_scopes', field = target === 'records' ? 'canonical_json' : 'config_json';
  const before = target === 'records' ? rows(f)[0] : scope(f);
  const duplicate = before[field].slice(0, -1) + ',"ambiguous":[{"key":1,"\\u006bey":2}]}';
  store.sqliteExec(f.db, `UPDATE ${table} SET ${field}=${q(duplicate)} ${target === 'scopes' ? `WHERE id=${q(SCOPE)}` : ''};`);
  const result = cli(f, target, target === 'records' ? ['--names-only', '--record-id', String(before.id), '--apply'] : ['--apply']);
  if (target === 'records') { assert.equal(result.status, 1); assert.match(result.stdout, /enrichment failed/); }
  else { assert.equal(JSON.parse(result.stdout).failed, 1); assert.equal(JSON.parse(result.stdout).updated, 0); }
  assert.equal((target === 'records' ? rows(f)[0] : scope(f))[field], duplicate);
});

function syncCli(f, moreDeps = {}) {
  let stdout = '', stderr = '';
  const code = runLarkImSyncCli(['--db', f.db, '--scope', 'received', '--start', new Date(START).toISOString(),
    '--end', new Date(START + 60000).toISOString()], { stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } }, deps: { getSelfProfile: () => SELF,
      syncRunnerDeps: { fetchChatMessageList: () => ({ messages: [normalizeApiMessage(f.native)], pages: 1, detailRoots: [] }),
        buildPeopleContext: () => ({ self: SELF, contacts: new Map(), chat_members: new Map(), apps: new Map(), app_fallbacks: new Map() }),
        ...moreDeps } } });
  return { code, stdout, stderr };
}

test('normal sync CLI path retains unknown old canonical text while refreshing an equivalent projection', t => {
  const f = fixture(t), before = rows(f)[0];
  store.sqliteExec(f.db, `UPDATE records SET body='Synthetic outdated renderer';`);
  const { code, stdout, stderr } = syncCli(f);
  assert.equal(code, 0, stdout + stderr);
  assert.equal(JSON.parse(stdout).received[0].updated, 1);
  const after = rows(f)[0];
  assert.equal(after.body, before.body); assert.equal(after.raw_json, before.raw_json); assert.equal(after.content_hash, before.content_hash);
  assert.ok(after.canonical_json.includes(`"unknown":${UNKNOWN}`)); assert.match(after.canonical_json, /"old_only":1e400/);
});

test('normal sync commits incoming unknown text, retains old-only fields and deletes only absent derived fields', t => {
  const f = fixture(t), before = rows(f)[0];
  // Invent a future adapter output at the normal list commit boundary.
  const { code, stdout, stderr } = syncCli(f, { commitLarkListRun: (...args) => {
    args[3] = args[3].map(record => ({ ...record, canonical_json: patchJsonText(record.canonical_json,
      [{ path: ['unknown'], value: '{"new":18446744073709551617}' }, { path: ['new_only'], value: '0.12345678901234567890123456789' },
        { path: ['content_rendering'] }], [['unknown'], ['new_only'], ['content_rendering']]) }));
    return store.commitLarkListRun(...args);
  } });
  assert.equal(code, 0, stdout + stderr); assert.equal(JSON.parse(stdout).received[0].updated, 1);
  const after = rows(f)[0];
  assert.equal(after.raw_json, before.raw_json); assert.equal(after.content_hash, before.content_hash);
  assert.match(after.canonical_json, /"unknown":\{"new":18446744073709551617\}/);
  assert.match(after.canonical_json, /"old_only":1e400/);
  assert.match(after.canonical_json, /"new_only":0\.12345678901234567890123456789/);
  assert.equal(JSON.parse(after.canonical_json).content_rendering, undefined);
});

for (const side of ['stored', 'incoming']) test(`normal sync rejects ${side} nested duplicate canonical keys without writing the record`, t => {
  const f = fixture(t);
  const duplicate = json => json.slice(0, -1) + ',"bad":{"one":1,"one":2}}';
  if (side === 'stored') store.sqliteExec(f.db, `UPDATE records SET canonical_json=${q(duplicate(rows(f)[0].canonical_json))};`);
  const before = rows(f)[0];
  const result = syncCli(f, side === 'incoming' ? { commitLarkListRun: (...args) => {
    args[3] = args[3].map(record => ({ ...record, canonical_json: duplicate(record.canonical_json) }));
    return store.commitLarkListRun(...args);
  } } : {});
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(JSON.parse(result.stdout).received[0].error, /json_patch_duplicate_key/);
  assert.deepEqual(rows(f)[0], before);
});

test('SQL name merge compares unknown numeric tokens without rounding or accepting formatting-only churn', t => {
  const f = fixture(t);
  const merged = (old, next) => store.sqliteQuery(f.db, `SELECT ${mergeLarkNameProjectionSql(q(old), q(next), "'ou_fixture'", "'ou_fixture'", "'oc_fixture'", "'oc_fixture'")} AS value;`)[0].value;
  for (const [old, next] of [['18446744073709551616', '18446744073709551617'],
    ['0.12345678901234567890123456789', '0.12345678901234567890123456788'], ['1e400', '2e400'], ['0', '-0']]) {
    const nextJson = `{"unknown":${next}}`;
    assert.equal(merged(`{"unknown":${old}}`, nextJson), nextJson);
  }
  const old = '{ "first": {"n":18446744073709551617}, "text":"Synthetic" }';
  assert.equal(merged(old, '{"text":"Synthetic","first":{"n":18446744073709551617}}'), old);
});
