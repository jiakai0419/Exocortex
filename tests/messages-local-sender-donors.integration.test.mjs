import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';

// Invented from scratch. No worker, source API or writeback runs before reading.
// Donor authority lives outside the selected page, in a different conversation.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 7, 9, 10, 11, 12), OBSERVED = new Date(AT + 1_000).toISOString();
const SELF = 'ou_synthetic_donor_owner', ACCOUNT = recipientAccountKey(SELF);
const OTHER_ACCOUNT = recipientAccountKey('ou_synthetic_donor_foreign_owner');
const CHAT = 'oc_synthetic_donor_selected', OTHER_CHAT = 'oc_synthetic_donor_history';
const TITLE = 'Invented Local Evidence Room', NAME = 'Invented Proven Owner';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const edit = (row, field, change) => { const parsed = JSON.parse(row[field]); change(parsed); row[field] = JSON.stringify(parsed); };

function record(id, { actor = SELF, chat = CHAT, name = null, offset = 0, direction = 'received' } = {}) {
  const external = `om_d${String(id).padStart(4, '0')}_synthetic_donor`, body = `Authored donor-test body ${id}.`;
  const raw = { message_id: external, chat_id: chat, chat_type: 'group', msg_type: 'text',
    create_time: String(AT + offset), update_time: String(AT + offset + 9),
    sender: { id: actor, id_type: 'open_id', sender_type: 'user', ...(name ? { name } : {}) },
    body: { content: JSON.stringify({ text: body }) } };
  const canonical = { message_id: external, chat_id: chat, chat_type: 'group', chat_name: TITLE,
    sender_id: actor, sender_id_type: 'open_id', sender_type: 'user', msg_type: 'text',
    sender_name: name, ...(name ? { sender_name_source: 'message_sender' } : {}) };
  return { id, source_id: 'lark.im', record_type: 'lark.im.message', first_seen_scope_id: SENT_SCOPE_ID,
    external_id: external, external_version: String(AT + offset + 9), actor_id: actor, container_id: chat,
    direction, body, occurred_at: new Date(AT + offset).toISOString(), occurred_at_ms: AT + offset,
    raw_json: JSON.stringify(raw), canonical_json: JSON.stringify(canonical), content_hash: hash(JSON.stringify(raw)) };
}

function inputs() {
  const target = record(3, { direction: 'sent' });
  edit(target, 'canonical_json', value => { value.sender_name = NAME; value.sender_name_source = 'self'; value.sender_name_confidence = 'high'; });
  const neighbors = [record(2, { actor: 'ou_synthetic_donor_neighbor_b', name: 'Invented Neighbor Birch' }),
    record(1, { actor: 'ou_synthetic_donor_neighbor_a', name: 'Invented Neighbor Alder', offset: -10_000 })];
  const donor = record(4, { chat: OTHER_CHAT, offset: -60_000 });
  edit(donor, 'canonical_json', value => {
    value.sender_name = NAME; value.sender_name_source = 'contact'; value.sender_name_confidence = 'high';
    value.sender_name_account_key = ACCOUNT; value.sender_name_observed_at = OBSERVED;
  });
  return { target, neighbors, donors: [donor] };
}

function additionalDonor(data, change) {
  const other = clone(data.donors[0]); other.id = 5; other.external_id = 'om_d0005_synthetic_donor';
  edit(other, 'canonical_json', value => { value.message_id = other.external_id; });
  edit(other, 'raw_json', value => { value.message_id = other.external_id; });
  change(other); data.donors.push(other);
}

function fixture(t, data) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-messages-local-donors-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network');
  const cli = join(directory, 'reject-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import {writeFileSync} from 'node:fs';import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('synthetic donor test forbids network');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:100});\n`);
  ensureInitialized(db);
  for (const row of [data.target, ...data.neighbors, ...data.donors]) {
    row.content_hash = hash(row.raw_json);
    const columns = Object.keys(row);
    sqliteExec(db, `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key => row[key] === null ? 'NULL'
      : typeof row[key] === 'number' ? String(row[key]) : quoteSql(row[key])).join(',')});`);
  }
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard };
}

function snapshot(f) {
  const dump = spawnSync('sqlite3', ['-readonly', f.db, '.dump'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(dump.status, 0, dump.stderr);
  const stat = statSync(f.db);
  return { hash: hash(readFileSync(f.db)), dump: dump.stdout, mtime: stat.mtimeMs,
    mode: stat.mode & 0o777, files: readdirSync(f.directory).sort() };
}

function messages(f, format, limit = 3) {
  const env = { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1',
    LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', f.guard, join(ROOT, 'bin/exocortex.mjs'),
    'messages', '--db', f.db, '--limit', String(limit), '--format', format], {
    cwd: f.directory, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
  assert.equal(existsSync(f.marker), false);
  return format === 'json' ? JSON.parse(result.stdout) : result.stdout;
}

function header(row) {
  return `${row.direction.toUpperCase()} ${new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })}  ${row.external_id.slice(0, 8)}...  群聊`;
}
const readyBlock = (row, name) => `${header(row)}\n  发送人  ${name}\n  群      ${TITLE}\n  类型    user / 文本\n  消息    ${row.body}`;

function assertSelected(rows, data) {
  const expected = [data.target, ...data.neighbors];
  assert.deepEqual(rows.map(row => row.id), expected.map(row => row.id));
  for (let index = 0; index < rows.length; index++) {
    for (const field of ['id', 'source_id', 'record_type', 'external_id', 'actor_id', 'container_id', 'direction',
      'occurred_at', 'occurred_at_ms', 'raw_json', 'canonical_json', 'body']) assert.equal(rows[index][field], expected[index][field], field);
    assert.deepEqual(rows[index].raw, JSON.parse(expected[index].raw_json));
    assert.deepEqual(rows[index].canonical, JSON.parse(expected[index].canonical_json));
    assert.equal(rows[index].display.body, expected[index].body);
  }
  assert(rows.slice(1).every(row => row.readiness.state === 'ready'));
}

test('first real CLI read proves a nonempty legacy self name from exact local contact history outside its selected page', t => {
  const data = inputs(), f = fixture(t, data), before = snapshot(f);
  const rows = messages(f, 'json'); assertSelected(rows, data);
  assert.equal(rows[0].canonical.sender_name_source, 'self'); assert.equal(rows[0].canonical.sender_name_account_key, undefined);
  assert.equal(rows[0].display.sender, NAME); assert.equal(rows[0].readiness.state, 'ready');
  assert.deepEqual(rows[0].readiness.reasons, []);
  assert.equal(rows[0].readiness.requirements.find(item => item.field === 'sender').evidence, 'local_history');
  const text = messages(f, 'text');
  assert.equal(text, `Messages (3)\n\n${[readyBlock(data.target, NAME), readyBlock(data.neighbors[0], 'Invented Neighbor Birch'),
    readyBlock(data.neighbors[1], 'Invented Neighbor Alder')].join('\n\n')}\n`);
  assert.deepEqual(messages(f, 'json', 1), [rows[0]], 'limit one uses page-external donor and keeps the newest selected record');
  assert.equal(messages(f, 'text', 1), `Messages (1)\n\n${readyBlock(data.target, NAME)}\n`);
  assert.deepEqual(messages(f, 'json'), rows);
  assert.deepEqual(snapshot(f), before, 'neither records nor tasks, clocks, source bytes, schema or files are changed');
});

const invalidDonors = [
  ['foreign account', data => edit(data.donors[0], 'canonical_json', value => { value.sender_name_account_key = OTHER_ACCOUNT; })],
  ['different actor', data => { const donor = data.donors[0]; donor.actor_id = 'ou_synthetic_donor_wrong_actor';
    edit(donor, 'canonical_json', value => { value.sender_id = donor.actor_id; }); edit(donor, 'raw_json', value => { value.sender.id = donor.actor_id; }); }],
  ['different namespace', data => { edit(data.donors[0], 'canonical_json', value => { value.sender_id_type = 'user_id'; });
    edit(data.donors[0], 'raw_json', value => { value.sender.id_type = 'user_id'; }); }],
  ['scoped member in another chat', data => edit(data.donors[0], 'canonical_json', value => { value.sender_name_source = 'chat_member'; })],
  ['missing own account despite a title account', data => edit(data.donors[0], 'canonical_json', value => {
    delete value.sender_name_account_key; value.chat_name_account_key = ACCOUNT; })],
  ['low-confidence value', data => edit(data.donors[0], 'canonical_json', value => { value.sender_name_confidence = 'medium'; })],
  ['local-history copy cannot seed more history', data => edit(data.donors[0], 'canonical_json', value => {
    value.sender_name_source = 'local_history'; value.sender_name_authority_source = 'contact'; })],
  ['cleared canonical source', data => edit(data.donors[0], 'canonical_json', value => { value.sender_name_state = 'cleared'; })],
  ['cleared native source', data => edit(data.donors[0], 'raw_json', value => { value.sender.name_state = 'cleared'; })],
  ['latest identity conflict', data => edit(data.donors[0], 'canonical_json', value => {
    value.sender_name_verification = { status: 'conflict', source: 'contact', account_key: ACCOUNT }; })],
  ['duplicate canonical authority key', data => { data.donors[0].canonical_json = data.donors[0].canonical_json
    .replace('"sender_name_account_key":', `"sender_name_account_key":"${ACCOUNT}","sender_name_account_key":`); }],
  ['duplicate raw identity key', data => { data.donors[0].raw_json = data.donors[0].raw_json
    .replace('"sender":{', `"sender":{"id":"${SELF}",`); }],
  ['raw actor contradicts canonical', data => edit(data.donors[0], 'raw_json', value => { value.sender.id = 'ou_synthetic_donor_conflicting_actor'; })],
  ['canonical app kind contradicts native human', data => edit(data.donors[0], 'canonical_json', value => { value.sender_type = 'app'; })],
  ['wrapper and native aliases disagree despite identical open ID', data => edit(data.donors[0], 'raw_json', value => {
    value.raw_api = clone(value); value.sender.user_id = 'synthetic_outer_user_alias';
    value.raw_api.sender.user_id = 'synthetic_inner_user_alias';
  })],
  ['a matching clear blocks an otherwise valid donor', data => additionalDonor(data,
    other => edit(other, 'canonical_json', value => { value.sender_name_state = 'cleared'; }))],
  ['a matching conflict blocks an otherwise valid donor', data => additionalDonor(data,
    other => edit(other, 'canonical_json', value => { value.sender_name_verification = { status: 'conflict', source: 'contact', account_key: ACCOUNT }; }))],
  ['an unbound clear in the exact target chat blocks an otherwise valid donor', data => additionalDonor(data, other => {
    other.container_id = CHAT;
    edit(other, 'canonical_json', value => { value.chat_id = CHAT; delete value.sender_name_account_key; value.sender_name_state = 'cleared'; });
    edit(other, 'raw_json', value => { value.chat_id = CHAT; });
  })],
  ['trusted names conflict', data => { const other = clone(data.donors[0]); other.id = 5;
    other.external_id = 'om_d0005_synthetic_donor';
    edit(other, 'canonical_json', value => { value.message_id = other.external_id; value.sender_name = 'Invented Conflicting Owner'; });
    edit(other, 'raw_json', value => { value.message_id = other.external_id; }); data.donors.push(other); }],
];

test('real CLI cannot publish legacy known names from invalid or conflicting local donor evidence', async t => {
  for (const [label, change] of invalidDonors) await t.test(label, t => {
    const data = inputs(); change(data);
    const f = fixture(t, data), before = snapshot(f), rows = messages(f, 'json');
    assertSelected(rows, data); assert.equal(rows[0].readiness.state, 'enriching');
    assert.deepEqual(rows[0].readiness.reasons, ['sender_name_unverified']);
    const exception = `${header(data.target)}\n  状态    等待完整信息\n  原因    发送人名称待核验\n  查看    messages --format json 可检查已保存内容与原因`;
    assert.equal(messages(f, 'text'), `Messages (3)\n完整 2 · 待补全 1 · 受阻 0\n\n${exception}\n\n${readyBlock(data.neighbors[0], 'Invented Neighbor Birch')}\n\n${readyBlock(data.neighbors[1], 'Invented Neighbor Alder')}\n`);
    assert.deepEqual(messages(f, 'json', 1), [rows[0]], 'an exception cannot be replaced by an older ready row');
    assert.deepEqual(snapshot(f), before);
  });
});

test('foreign or unrelated scoped evidence does not poison an exact valid global donor', async t => {
  for (const source of ['foreign_contact', 'other_chat_member']) await t.test(source, t => {
    const data = inputs(), other = clone(data.donors[0]); other.id = 5; other.external_id = 'om_d0005_synthetic_donor';
    edit(other, 'canonical_json', value => { value.message_id = other.external_id; value.sender_name = 'Invented Unrelated Name';
      if (source === 'foreign_contact') value.sender_name_account_key = OTHER_ACCOUNT; else value.sender_name_source = 'chat_member'; });
    edit(other, 'raw_json', value => { value.message_id = other.external_id; }); data.donors.push(other);
    const f = fixture(t, data), before = snapshot(f), rows = messages(f, 'json'); assertSelected(rows, data);
    assert.equal(rows[0].readiness.state, 'ready'); assert.equal(rows[0].display.sender, NAME);
    assert(messages(f, 'text').includes(readyBlock(data.target, NAME))); assert.deepEqual(snapshot(f), before);
  });
});

test('a target explicit clear remains blocked even when exact local contact authority exists', t => {
  const data = inputs(); edit(data.target, 'canonical_json', value => { value.sender_name_state = 'cleared'; });
  const f = fixture(t, data), before = snapshot(f), rows = messages(f, 'json'); assertSelected(rows, data);
  assert.equal(rows[0].readiness.state, 'blocked'); assert.deepEqual(rows[0].readiness.reasons, ['name_explicitly_cleared']);
  const text = messages(f, 'text'); assert(text.includes(`${header(data.target)}\n  状态    准备受阻\n  原因    来源已清除名称\n`));
  assert(text.includes(readyBlock(data.neighbors[0], 'Invented Neighbor Birch')));
  assert(text.includes(readyBlock(data.neighbors[1], 'Invented Neighbor Alder')));
  assert.deepEqual(snapshot(f), before);
});
