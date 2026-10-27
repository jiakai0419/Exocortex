import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { liveProbeContext } from '../src/diagnostics/live-probe-cache.mjs';
import { prepareSidecarFixture } from './helpers/sidecar-fixture.mjs';

// Fully invented records, mapping references and identities. No production
// exports, screenshots or previously stored business data are fixtures here.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 6, 2, 9, 10, 11);
const TENANT = 'synthetic-complete-mapping-tenant';
const CHAT = 'oc_synthetic_complete_mapping_room';
const APP = 'synthetic_application_without_prefix';
const NAME = '应用 Invented Courier';
const TITLE = 'Invented Mapping Workshop';
const SOURCE = { kind: 'user_screenshot', recorded_at: '2025-07-02T09:10:10.000Z',
  evidence_refs: ['invented-mapping-reference-a'] };
const hash = value => createHash('sha256').update(value).digest('hex');
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value);

function message(id, named = false) {
  const actor = named ? 'ou_synthetic_mapping_neighbor' : APP;
  const namespace = named ? 'open_id' : 'app_id';
  const senderType = named ? 'user' : 'app';
  const external = `om_m${String(id).padStart(4, '0')}_synthetic_mapping`;
  const body = `Entirely invented mapping message ${id}.`;
  const raw = { message_id: external, chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(AT + id), sender: { id: actor, id_type: namespace,
      sender_type: senderType, tenant_key: TENANT, ...(named ? { name: 'Invented Neighbor' } : {}) },
    body: { content: JSON.stringify({ text: body }) } };
  const canonical = { message_id: external, chat_id: CHAT, chat_type: 'group', chat_name: TITLE,
    sender_id: actor, sender_id_type: namespace, sender_type: senderType, msg_type: 'text',
    sender_name: named ? 'Invented Neighbor' : null,
    ...(named ? { sender_name_source: 'message_sender' } : {}) };
  return { id, source_id: 'lark.im', first_seen_scope_id: SENT_SCOPE_ID, external_id: external,
    external_version: String(AT + id), record_type: 'lark.im.message',
    occurred_at: new Date(AT + id).toISOString(), occurred_at_ms: AT + id,
    actor_id: actor, container_id: CHAT, direction: 'received', body,
    content_hash: hash(JSON.stringify(raw)), canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw) };
}

function edit(row, field, change) {
  const value = JSON.parse(row[field]);
  change(value);
  row[field] = JSON.stringify(value);
}

function fixture(t, mutate = () => {}, { sidecar = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-local-mapping-complete-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  const sidecarPath = `${db}.chat-app-names.json`;
  const marker = join(directory, 'unexpected-network');
  const cli = join(directory, 'reject-network-cli');
  const guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
const reject=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('network forbidden');};
globalThis.fetch=reject;Socket.prototype.connect=reject;
Object.defineProperty(process.stdout,'columns',{value:100,configurable:true});
`);
  ensureInitialized(db);
  const row = message(2), neighbor = message(1, true);
  const entry = { tenant_key: TENANT, chat_id: CHAT, app_id: APP, name: NAME, source: structuredClone(SOURCE) };
  const config = { kind: 'lark_im_chat_app_names/v1', context: {
    database_key: liveProbeContext(db).database_key, source_id: 'lark.im' }, entries: [entry] };
  const values = { row, neighbor, entry, config, sidecarText: null };
  mutate(values);
  for (const record of [neighbor, row]) {
    const columns = Object.keys(record);
    sqliteExec(db, `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key => sql(record[key])).join(',')});`);
  }
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  if (sidecar) {
    writeFileSync(sidecarPath, values.sidecarText ?? JSON.stringify(config), { mode: 0o600 });
    prepareSidecarFixture(sidecarPath);
  }
  return { directory, db, sidecarPath, marker, cli, guard, row, neighbor };
}

function snapshot(f) {
  const files = readdirSync(f.directory).sort();
  return files.map(name => {
    const path = join(f.directory, name), stat = statSync(path);
    return { name, hash: hash(readFileSync(path)), mode: stat.mode & 0o777, modified: stat.mtimeMs };
  });
}

function cli(f, format, limit = 2, expectedFailure = false) {
  const env = { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1',
    LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', f.guard, join(ROOT, 'bin/exocortex.mjs'),
    'messages', '--db', f.db, '--format', format, '--limit', String(limit)], {
    cwd: f.directory, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(existsSync(f.marker), false, 'read-only CLI cannot call an API or a network socket');
  if (expectedFailure) {
    assert.notEqual(result.status, 0);
    for (const privateValue of [NAME, TENANT, CHAT, APP, SOURCE.evidence_refs[0], f.directory]) {
      assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false, 'mapping failure must not disclose private values');
    }
    return result;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return format === 'json' ? JSON.parse(result.stdout) : result.stdout;
}

test('exact current file-bound app mapping becomes ready on first actual CLI read without changing source or neighbors', t => {
  const f = fixture(t), before = snapshot(f);
  const rows = cli(f, 'json');
  const text = cli(f, 'text');
  assert.deepEqual(rows.map(row => row.id), [2, 1]);
  const [mapped, neighbor] = rows;
  assert.equal(mapped.display.sender, `应用：${NAME}`);
  assert.equal(mapped.readiness.state, 'ready', JSON.stringify(mapped.readiness));
  assert.equal(mapped.readiness.requirements.find(item => item.field === 'sender').evidence, 'local_chat_app_name');
  assert.equal(mapped.canonical.sender_name, null, 'mapped display never mutates the stored canonical name');
  assert.deepEqual(mapped.display.sender_name_source, { kind: 'local_chat_app_name', source_kind: SOURCE.kind,
    recorded_at: SOURCE.recorded_at, evidence_refs: SOURCE.evidence_refs });
  for (const [actual, original] of [[mapped, f.row], [neighbor, f.neighbor]]) {
    for (const field of ['external_id', 'body', 'raw_json', 'canonical_json', 'occurred_at', 'occurred_at_ms',
      'actor_id', 'container_id', 'direction']) assert.equal(actual[field], original[field], field);
    assert.equal(actual.display.body, original.body);
    assert.equal(actual.display.chat, TITLE);
    assert.equal(actual.display.recipient, null);
    assert.equal(actual.readiness.state, 'ready');
  }
  assert.equal(neighbor.display.sender, 'Invented Neighbor');
  assert.match(text, /发送人  应用：应用 Invented Courier/);
  assert.match(text, /发送人  Invented Neighbor/);
  assert.match(text, /类型    app \/ 文本/);
  assert.match(text, /消息    Entirely invented mapping message 2\./);
  assert.doesNotMatch(text, /等待完整信息|准备受阻|待补全/);
  assert.deepEqual(snapshot(f), before, 'reading must not write the DB, sidecar or other files');
});

test('mapping cannot cross missing or conflicting exact identities and cannot revive clears', async t => {
  const cases = [
    ['missing native tenant', ({ row }) => edit(row, 'raw_json', raw => { delete raw.sender.tenant_key; })],
    ['different native tenant', ({ row }) => edit(row, 'raw_json', raw => { raw.sender.tenant_key = 'synthetic-other-tenant'; })],
    ['different mapped chat', ({ entry }) => { entry.chat_id = 'oc_synthetic_other_mapping_room'; }],
    ['different mapped app', ({ entry }) => { entry.app_id = 'synthetic_other_application'; }],
    ['canonical clear', ({ row }) => edit(row, 'canonical_json', canonical => { canonical.sender_name_state = 'cleared'; })],
    ['native clear', ({ row }) => edit(row, 'raw_json', raw => { raw.sender.name_state = 'cleared'; })],
    ['duplicate raw keys', ({ row }) => { row.raw_json = row.raw_json.replace('"sender":', '"sender":{"tenant_key":"synthetic-other-tenant"},"sender":'); }],
    ['duplicate canonical keys', ({ row }) => { row.canonical_json = row.canonical_json.replace('"sender_id":', '"sender_id":"synthetic_other_application","sender_id":'); }],
    ['canonical source label without file evidence', ({ row, config }) => {
      config.entries = [];
      edit(row, 'canonical_json', canonical => { canonical.sender_name = NAME; canonical.sender_name_source = 'local_chat_app_name';
        canonical.sender_name_confidence = 'high'; });
    }],
  ];
  for (const [label, mutate] of cases) await t.test(label, t => {
    const f = fixture(t, mutate), before = snapshot(f);
    const rows = cli(f, 'json', 1), text = cli(f, 'text', 1);
    assert.deepEqual(rows.map(row => row.id), [2], 'an incomplete latest row is not skipped to fill limit');
    assert.notEqual(rows[0].readiness.state, 'ready');
    assert.equal(rows[0].display.sender_name_source, undefined, 'unmatched data cannot claim current mapping provenance');
    assert.doesNotMatch(text, /^  发送人 /m);
    assert.match(text, /等待完整信息|准备受阻/);
    assert.deepEqual(snapshot(f), before);
  });
});

test('invalid database binding and ambiguous mapping JSON fail closed without data disclosure', async t => {
  const cases = [
    ['different database', ({ config }) => { config.context.database_key = 'b'.repeat(64); }],
    ['missing database', ({ config }) => { delete config.context.database_key; }],
    ['duplicate source', values => { values.sidecarText = JSON.stringify(values.config).replace('"source_id":"lark.im"',
      '"source_id":"invented.foreign","source_id":"lark.im"'); }],
    ['duplicate app', values => { values.sidecarText = JSON.stringify(values.config).replace(`"app_id":"${APP}"`,
      `"app_id":"synthetic_other_application","app_id":"${APP}"`); }],
  ];
  for (const [label, mutate] of cases) await t.test(label, t => {
    const f = fixture(t, mutate), before = snapshot(f);
    cli(f, 'json', 2, true);
    cli(f, 'text', 2, true);
    assert.deepEqual(snapshot(f), before);
  });
});

test('an absent mapping preserves an explicit latest exception and requires no created config', t => {
  const f = fixture(t, undefined, { sidecar: false }), before = snapshot(f);
  const [row] = cli(f, 'json', 1), text = cli(f, 'text', 1);
  assert.equal(row.id, 2);
  assert.equal(row.readiness.state, 'enriching');
  assert.ok(row.readiness.reasons.includes('sender_name_missing'));
  assert.match(text, /等待完整信息/);
  assert.doesNotMatch(text, /^  发送人 /m);
  assert.deepEqual(snapshot(f), before);
});
