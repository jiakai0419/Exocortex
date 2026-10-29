import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';

// Every byte, identity and message is authored here. The only executable named
// LARK_CLI is a fixture-owned Python program with no network or credential code.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'ou_synthetic_cli_resource_author';
const CHAT = 'oc_synthetic_cli_resource_group';
const AUTHOR = 'Synthetic Resource Author';
const CHAT_NAME = 'Synthetic Resource Group';
const IMAGE_KEY = 'synthetic_cli_image_key';
const AT = Date.UTC(2025, 1, 3, 4, 5, 6);
const sha = value => createHash('sha256').update(value).digest('hex');

function png() {
  const crc = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (tag, bytes) => {
    const data = Buffer.concat([Buffer.from(tag), bytes]), length = Buffer.alloc(4), sum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(data));
    return Buffer.concat([length, data, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 30, 110, 220, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

function jpeg(width = 1, height = 1) {
  const segment = (marker, body) => {
    const header = Buffer.from([255, marker, 0, 0]);
    header.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([header, body]);
  };
  const dc = Buffer.alloc(18); dc[1] = 1;
  const ac = Buffer.alloc(18); ac[0] = 16; ac[1] = 1;
  const frame = Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
  frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3);
  // One DC0/EOB block is complete for 1x1; a 16x16 declaration lacks MCUs.
  return Buffer.concat([Buffer.from([255, 216]), segment(0xdb, Buffer.from([0, ...Array(64).fill(1)])),
    segment(0xc0, frame), segment(0xc4, Buffer.concat([dc, ac])),
    segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x3f, 255, 217])]);
}

function fixture(t, { bytes = png(), mime = 'image/png', resourceSpecs = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-media-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'messages.sqlite'), resourceDir = join(root, 'private-images');
  ensureInitialized(db);
  const rows = ['older', 'image', 'newer'].map((label, index) => {
    const id = index + 1, type = resourceSpecs || label === 'image' ? 'image' : 'text';
    const imageKey = resourceSpecs ? `${IMAGE_KEY}_${index}` : IMAGE_KEY;
    const external = `om_synthetic_cli_resource_${label}`, time = AT + id * 1000;
    const body = type === 'image' ? 'Original synthetic image fallback; no invented description.'
      : `Synthetic ${label} neighbor body  preserves spacing.`;
    const raw = { message_id: external, chat_id: CHAT, chat_type: 'group', msg_type: type,
      create_time: String(time), update_time: String(time + 1),
      sender: { id: SELF, id_type: 'open_id', sender_type: 'user', name: AUTHOR },
      body: { content: JSON.stringify(type === 'image' ? { image_key: imageKey } : { text: body }) } };
    const canonical = { message_id: external, chat_id: CHAT, chat_type: 'group', chat_name: CHAT_NAME,
      msg_type: type, sender_id: SELF, sender_id_type: 'open_id', sender_type: 'user',
      sender_name: AUTHOR, sender_name_source: 'message_sender' };
    const rawJson = JSON.stringify(raw);
    return { id, source_id: 'lark.im', record_type: 'lark.im.message', external_id: external,
      external_version: String(time + 1), first_seen_scope_id: SENT_SCOPE_ID, actor_id: SELF,
      container_id: CHAT, direction: 'sent', occurred_at: new Date(time).toISOString(), occurred_at_ms: time,
      raw_json: rawJson, canonical_json: JSON.stringify(canonical), content_hash: sha(rawJson), body };
  });
  // Insert out of message-time order, so the real messages query determines it.
  sqliteExec(db, [rows[1], rows[0], rows[2]].map(row => {
    const keys = Object.keys(row);
    return `INSERT INTO records(${keys.join(',')}) VALUES(${keys.map(key => quoteSql(row[key])).join(',')});`;
  }).join('\n'));
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  const executable = join(root, 'fake-lark-cli.py'), audit = join(root, 'requests.jsonl');
  const resources = Object.fromEntries(rows.flatMap((row, index) => {
    const native = JSON.parse(row.raw_json);
    if (native.msg_type !== 'image') return [];
    const spec = resourceSpecs?.[index] || { bytes, mime }, key = JSON.parse(native.body.content).image_key;
    return [[`/open-apis/im/v1/messages/${row.external_id}/resources/${key}`,
      { bytes: (spec.bytes || bytes).toString('base64'), mime: spec.mime || mime, denial: spec.denial || false,
        savedPath: spec.savedPath || null }]];
  }));
  const config = { self: SELF, author: AUTHOR, audit, resources,
    tempRoot: realpathSync(tmpdir()) };
  writeFileSync(executable, `#!/usr/bin/env python3
import base64, json, os, resource, sys
config = json.loads(${JSON.stringify(JSON.stringify(config))})
args = sys.argv[1:]
mask = os.umask(0o077)
os.umask(mask)
limits = resource.getrlimit(resource.RLIMIT_FSIZE)
entry = {'args': args, 'cwd': os.getcwd(), 'umask': mask, 'file_size_limit': list(limits)}
with open(config['audit'], 'a') as log:
    log.write(json.dumps(entry) + '\\n')
assert mask == 0o077, 'synthetic CLI must inherit the real Python privacy guard'
assert limits == (16777216, 16777216), 'synthetic CLI must inherit the real file-size limit'
stage = os.path.realpath(os.getcwd())
assert os.path.dirname(stage) == config['tempRoot'] and os.path.basename(stage).startswith('exocortex-media-')
if args == ['contact', '+get-user', '--as', 'user', '--format', 'json']:
    result = {'open_id': config['self'], 'name': config['author']}
else:
    assert args[:2] == ['api', 'GET'] and args[2] in config['resources'], 'only exact synthetic resources can be fetched'
    resource_config = config['resources'][args[2]]
    assert len(args) == 11 and args[3] == '--as' and args[4] == 'user'
    assert args[5] == '--params' and json.loads(args[6]) == {'type': 'image'}
    assert args[7] == '--output' and args[9:] == ['--format', 'json']
    output = args[8]
    assert output == os.path.basename(output) and output.startswith('resource-') and output.endswith('.bin')
    if resource_config['denial']:
        sys.stdout.write(json.dumps({'code': 210508, 'msg': 'permission denied: synthetic resource'}))
        sys.exit(1)
    data = base64.b64decode(resource_config['bytes'])
    with open(output, 'xb') as image:
        image.write(data)
    result = {'saved_path': resource_config['savedPath'] or output, 'size_bytes': len(data), 'content_type': resource_config['mime']}
sys.stdout.write(json.dumps(result))
`, { mode: 0o700 });
  return { root, db, resourceDir, rows, bytes, executable, audit };
}

function command(f, args, maintenance = false, expectedStatus = 0) {
  const entry = maintenance
    ? [join(REPO, 'tests/helpers/enrichment-cli.mjs'), f.root]
    : [join(REPO, 'bin/exocortex.mjs')];
  const result = spawnSync(process.execPath, [...entry, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, LARK_CLI: f.executable, NO_COLOR: '1', TZ: 'UTC', LANG: 'en_US.UTF-8' },
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr + result.stdout);
  assert.equal(result.status, expectedStatus, result.stderr + result.stdout);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function assertPublic(f, text) {
  for (const privateValue of [f.root, f.db, f.resourceDir, SELF, CHAT, IMAGE_KEY, AUTHOR, CHAT_NAME,
    ...f.rows.flatMap(row => [row.external_id, row.body])]) {
    assert.equal(text.includes(privateValue), false, `public maintenance output leaked ${privateValue}`);
  }
}

test('real CLI downloads a synthetic image through its guard and publishes a readable sidecar without changing source bytes', t => {
  const f = fixture(t), beforeDb = readFileSync(f.db);
  const readArgs = ['messages', '--db', f.db, '--resource-dir', f.resourceDir, '--limit', '3'];
  const before = JSON.parse(command(f, [...readArgs, '--format', 'json']));
  assert.deepEqual(before.map(row => row.id), [3, 2, 1]);
  assert.equal(before[1].readiness.state, 'blocked');
  assert.ok(before[1].readiness.reasons.includes('content_resource_unavailable'));
  assert.deepEqual(readFileSync(f.db), beforeDb);
  assert.equal(existsSync(f.audit), false, 'messages reads must not invoke the CLI');

  const enrichArgs = ['maintenance', 'enrich', '--target', 'resources', '--db', f.db,
    '--record-id', '2', '--resource-dir', f.resourceDir, '--max-cli-attempts', '3', '--max-seconds', '30', '--format', 'json'];
  const previewText = command(f, enrichArgs, true), preview = JSON.parse(previewText);
  assertPublic(f, previewText);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.planned, 1);
  assert.equal(preview.request_budget, null);
  assert.equal(existsSync(f.audit), false, 'default preview makes zero profile or resource requests');
  assert.equal(existsSync(join(f.root, 'api-state')), false, 'preview never initializes API coordination');
  assert.equal(existsSync(f.resourceDir), false, 'preview creates no resource sidecar');
  assert.deepEqual(readFileSync(f.db), beforeDb);

  const appliedText = command(f, [...enrichArgs, '--apply'], true), applied = JSON.parse(appliedText);
  assertPublic(f, appliedText);
  assert.equal(applied.ok, true);
  assert.equal(applied.dry_run, false);
  assert.equal(applied.available, 1);
  assert.equal(applied.failed, 0);
  assert.equal(applied.partial, false);
  assert.equal(applied.request_budget.cli_attempts, 3);
  assert.equal(applied.request_budget.self_attempts, 2);
  assert.equal(applied.request_budget.max_cli_attempts, 3);
  assert.ok(existsSync(join(f.root, 'api-state')), 'apply uses the real lease implementation in the fixture');
  const auditBytes = readFileSync(f.audit, 'utf8'), calls = auditBytes.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['contact', '+get-user'], ['api', 'GET'], ['contact', '+get-user']]);
  assert.ok(calls.every(call => call.umask === 0o077));
  assert.ok(calls.every(call => JSON.stringify(call.file_size_limit) === '[16777216,16777216]'));
  assert.ok(calls.every(call => !existsSync(call.cwd)), 'private staging is removed after acquisition');
  assert.deepEqual(JSON.parse(calls[1].args[calls[1].args.indexOf('--params') + 1]), { type: 'image' });
  assert.deepEqual(readFileSync(f.db), beforeDb, 'apply leaves SQLite byte-for-byte unchanged');

  const after = JSON.parse(command(f, [...readArgs, '--format', 'json']));
  assert.deepEqual(after.map(row => row.id), [3, 2, 1], 'source message-time order is retained');
  assert.ok(after.every(row => row.readiness.state === 'ready'));
  for (const row of after) {
    const original = before.find(candidate => candidate.id === row.id);
    for (const key of ['body', 'actor_id', 'container_id', 'direction', 'external_id', 'external_version',
      'occurred_at', 'occurred_at_ms', 'raw_json', 'canonical_json', 'content_hash', 'raw', 'canonical']) {
      assert.deepEqual(row[key], original[key], `${key} must preserve the original source`);
    }
    for (const key of ['body', 'sender', 'recipient', 'chat', 'scene', 'external_id', 'sender_type', 'message_type']) {
      assert.deepEqual(row.display[key], original.display[key], `${key} must preserve the prior display projection`);
    }
    assert.equal(row.actor_id, SELF);
    assert.equal(row.display.sender, AUTHOR);
    assert.equal(row.display.chat, CHAT_NAME);
  }
  const image = after.find(row => row.id === 2), resource = image.display.media.resource;
  assert.equal(resource.availability, 'available');
  assert.equal(resource.mime_type, 'image/png');
  assert.equal(resource.size_bytes, f.bytes.length);
  assert.equal(resource.sha256, sha(f.bytes));
  assert.equal(dirname(resource.path), realpathSync(f.resourceDir));
  assert.ok(!relative(realpathSync(f.resourceDir), resource.path).startsWith('..'));
  assert.deepEqual(readFileSync(resource.path), f.bytes, 'the public CLI returns a locally openable image path');
  assert.equal(statSync(f.resourceDir).mode & 0o777, 0o700);
  assert.equal(statSync(resource.path).mode & 0o777, 0o600);

  const terminal = command(f, readArgs).replace(/\x1b\[[0-9;]*m/g, ''), flattened = terminal.replace(/\n +/g, '');
  assert.match(terminal, /Messages \(3\)/);
  assert.ok(flattened.includes(resource.path));
  assert.ok(terminal.includes('image/png'));
  assert.ok(terminal.includes('本地资源已验证'));
  assert.equal(terminal.includes(f.rows[1].body), false, 'resource text must not invent a description from the fallback body');
  // Existing text output compacts whitespace; original double spacing remains
  // covered byte-for-byte in the JSON and unchanged database assertions above.
  for (const neighbor of [after[0], after[2]]) assert.ok(flattened.includes(neighbor.body.replace(/\s+/g, ' ').trim()));
  for (const row of after) {
    assert.ok(flattened.includes(row.display.external_id));
    assert.ok(flattened.includes(new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })));
  }
  // Long IDs can share the same abbreviated header; distinct source times are
  // the unambiguous terminal order markers for these synthetic neighbors.
  const positions = after.map(row => flattened.indexOf(new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
  assert.ok(terminal.includes(AUTHOR));
  assert.ok(terminal.includes(CHAT_NAME));
  assert.deepEqual(readFileSync(f.db), beforeDb, 'both real messages formats keep SQLite unchanged');
  assert.equal(readFileSync(f.audit, 'utf8'), auditBytes, 'both message read formats make no extra resource/profile requests');
});

test('real CLI rejects both complete and missing-MCU JPEG resources as an unsupported local format', async t => {
  for (const size of [1, 16]) await t.test(`${size}x${size}`, t => {
    const f = fixture(t, { bytes: jpeg(size, size), mime: 'image/jpeg' }), beforeDb = readFileSync(f.db);
    const readArgs = ['messages', '--db', f.db, '--resource-dir', f.resourceDir, '--limit', '3'];
    const before = JSON.parse(command(f, [...readArgs, '--format', 'json']));
    const appliedText = command(f, ['maintenance', 'enrich', '--target', 'resources', '--db', f.db,
      '--record-id', '2', '--resource-dir', f.resourceDir, '--max-cli-attempts', '3', '--max-seconds', '30',
      '--format', 'json', '--apply'], true, 2);
    const applied = JSON.parse(appliedText);
    assertPublic(f, appliedText);
    assert.equal(applied.ok, false);
    assert.equal(applied.available, 0);
    assert.equal(applied.stop_reason, undefined, 'one unsupported format is an item outcome, not a remote batch stop');
    assert.equal(applied.results[0].reason, 'resource_format_unsupported');
    assert.equal(applied.request_budget.cli_attempts, 2);
    assert.equal(existsSync(f.resourceDir), false, 'unsupported JPEG must never publish available cache evidence');
    const auditBytes = readFileSync(f.audit, 'utf8');
    const calls = auditBytes.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['contact', '+get-user'], ['api', 'GET']]);
    assert.ok(calls.every(call => !existsSync(call.cwd)), 'failed acquisition still cleans its private staging');
    const after = JSON.parse(command(f, [...readArgs, '--format', 'json']));
    assert.deepEqual(after, before, 'failed acquisition cannot change source or its existing display projection');
    assert.equal(after[1].readiness.state, 'blocked');
    assert.ok(after[1].readiness.reasons.includes('content_resource_unavailable'));
    assert.deepEqual(readFileSync(f.db), beforeDb);
    assert.equal(readFileSync(f.audit, 'utf8'), auditBytes, 'messages must remain local after failed acquisition');
  });
});

test('real messages CLI never trusts legacy JPEG cache and preserves neighboring messages', async t => {
  for (const size of [1, 16]) await t.test(`${size}x${size}`, t => {
    const f = fixture(t), beforeDb = readFileSync(f.db);
    const readArgs = ['messages', '--db', f.db, '--resource-dir', f.resourceDir, '--limit', '3'];
    const before = JSON.parse(command(f, [...readArgs, '--format', 'json']));
    command(f, ['maintenance', 'enrich', '--target', 'resources', '--db', f.db, '--record-id', '2',
      '--resource-dir', f.resourceDir, '--max-cli-attempts', '3', '--max-seconds', '30', '--format', 'json', '--apply'], true);
    // Reproduce an old cache from a tolerant decoder, retaining the exact source binding.
    const manifestFile = readdirSync(f.resourceDir).find(name => name.endsWith('.json'));
    assert.ok(manifestFile);
    const manifestPath = join(f.resourceDir, manifestFile), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bytes = jpeg(size, size), sha256 = sha(bytes);
    writeFileSync(join(f.resourceDir, `${sha256}.blob`), bytes, { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256, size_bytes: bytes.length, mime_type: 'image/jpeg' }));
    const cacheBefore = new Map(readdirSync(f.resourceDir).map(name => [name, readFileSync(join(f.resourceDir, name))]));
    const auditBytes = readFileSync(f.audit, 'utf8');
    const after = JSON.parse(command(f, [...readArgs, '--format', 'json']));
    assert.deepEqual(after.map(row => row.id), [3, 2, 1]);
    assert.deepEqual(after[0], before[0]); assert.deepEqual(after[2], before[2]);
    const image = after[1], resource = image.display.media.resource;
    assert.equal(image.readiness.state, 'blocked');
    assert.ok(image.readiness.reasons.includes('content_resource_invalid'));
    assert.equal(resource.availability, 'invalid');
    assert.equal(resource.verification_reason, 'resource_format_unsupported');
    assert.equal(resource.path, undefined, 'unsupported cache is not exposed as a usable local image');
    for (const key of ['body', 'actor_id', 'container_id', 'direction', 'external_id', 'external_version',
      'occurred_at', 'occurred_at_ms', 'raw_json', 'canonical_json', 'content_hash', 'raw', 'canonical']) {
      assert.deepEqual(image[key], before[1][key], `${key} must preserve source data`);
    }
    for (const key of ['body', 'sender', 'recipient', 'chat', 'scene', 'external_id', 'sender_type', 'message_type']) {
      assert.deepEqual(image.display[key], before[1].display[key], `${key} must preserve source display`);
    }
    const terminal = command(f, readArgs).replace(/\x1b\[[0-9;]*m/g, ''), flattened = terminal.replace(/\n +/g, '');
    assert.match(terminal, /Messages \(3\)/);
    assert.equal(terminal.includes('本地资源已验证'), false);
    assert.equal(flattened.includes(f.resourceDir), false);
    for (const neighbor of [after[0], after[2]]) assert.ok(flattened.includes(neighbor.body.replace(/\s+/g, ' ').trim()));
    const positions = after.map(row => flattened.indexOf(new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' })));
    assert.ok(positions.every(position => position >= 0));
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
    assert.deepEqual(readFileSync(f.db), beforeDb);
    assert.deepEqual(new Map(readdirSync(f.resourceDir).map(name => [name, readFileSync(join(f.resourceDir, name))])), cacheBefore,
      'reading unsupported cached JPEG never rewrites or deletes sidecar bytes');
    assert.equal(readFileSync(f.audit, 'utf8'), auditBytes, 'both message formats make no extra API requests');
  });
});

test('real resource CLI distinguishes individual content failures from stopped or unpublished batch items', async t => {
  const valid = () => ({ bytes: png(), mime: 'image/png' });
  for (const scenario of [
    { name: 'unsupported JPEG does not prevent later independent PNG',
      specs: [valid(), { bytes: jpeg(16, 16), mime: 'image/jpeg' }, valid()], attempts: 5,
      reasons: [null, 'resource_format_unsupported', null], available: 2 },
    { name: 'invalid image bytes do not prevent later independent PNG',
      specs: [{ bytes: Buffer.from('<html>synthetic invalid image</html>') }, valid(), valid()], attempts: 5,
      reasons: ['download_image_invalid', null, null], available: 2 },
    { name: 'denial stops without attributing it to prior or unrequested resources',
      specs: [valid(), { denial: true }, valid()], attempts: 3, stop: 'permission_denied',
      reasons: ['publication_not_attempted', 'permission_denied', 'batch_stopped'], available: 0 },
    { name: 'first denial leaves every later resource unrequested',
      specs: [{ denial: true }, valid(), valid()], attempts: 2, stop: 'permission_denied',
      reasons: ['permission_denied', 'batch_stopped', 'batch_stopped'], available: 0 },
    { name: 'a later denial cannot overwrite an earlier local content diagnosis',
      specs: [{ bytes: jpeg(16, 16), mime: 'image/jpeg' }, { denial: true }, valid()], attempts: 3, stop: 'permission_denied',
      reasons: ['resource_format_unsupported', 'permission_denied', 'batch_stopped'], available: 0 },
    { name: 'unsafe response path stops rather than continuing content work',
      specs: [{ ...valid(), savedPath: '../unrelated-resource' }, valid(), valid()], attempts: 2, stop: 'download_response_invalid',
      reasons: ['download_response_invalid', 'batch_stopped', 'batch_stopped'], available: 0 },
    { name: 'budget stop preserves fetched versus never-started distinctions',
      specs: [valid(), valid(), valid()], attempts: 2, maxAttempts: 2, stop: 'cli_budget',
      reasons: ['publication_not_attempted', 'batch_stopped', 'batch_stopped'], available: 0 },
  ]) await t.test(scenario.name, t => {
    const f = fixture(t, { resourceSpecs: scenario.specs }), beforeDb = readFileSync(f.db);
    const readArgs = ['messages', '--db', f.db, '--resource-dir', f.resourceDir, '--limit', '3'];
    const before = JSON.parse(command(f, [...readArgs, '--format', 'json']));
    const text = command(f, ['maintenance', 'enrich', '--target', 'resources', '--db', f.db,
      '--record-id', '1', '--record-id', '2', '--record-id', '3', '--resource-dir', f.resourceDir,
      '--max-cli-attempts', String(scenario.maxAttempts || 5), '--max-seconds', '30', '--format', 'json', '--apply'], true, 2);
    const result = JSON.parse(text);
    assertPublic(f, text);
    assert.deepEqual(result.results.map(item => item.reason), scenario.reasons);
    assert.equal(result.stop_reason, scenario.stop);
    assert.equal(result.available, scenario.available);
    assert.equal(result.request_budget.cli_attempts, scenario.attempts);
    const auditBytes = readFileSync(f.audit, 'utf8'), calls = auditBytes.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, scenario.attempts);
    assert.ok(calls.every(call => !existsSync(call.cwd)));
    const after = JSON.parse(command(f, [...readArgs, '--format', 'json']));
    assert.equal(after.filter(row => row.readiness.state === 'ready').length, scenario.available);
    assert.deepEqual(after.map(row => row.id), [3, 2, 1]);
    for (const row of after) {
      const original = before.find(candidate => candidate.id === row.id);
      for (const key of ['body', 'actor_id', 'container_id', 'direction', 'external_id', 'external_version',
        'occurred_at', 'occurred_at_ms', 'raw_json', 'canonical_json', 'content_hash']) assert.deepEqual(row[key], original[key]);
    }
    assert.deepEqual(readFileSync(f.db), beforeDb);
    assert.equal(readFileSync(f.audit, 'utf8'), auditBytes, 'messages never retries a stopped resource batch');
  });
});
