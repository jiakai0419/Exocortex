import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { enrichRow } from '../src/diagnostics/messages-report.mjs';
import { createHistoryCommandBudget } from '../src/maintenance/history-command-budget.mjs';
import { quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { createLegacyCardFixture, snapshot } from './helpers/card-projection-fixture.mjs';

// New fictional events only. Neither captured content nor transformed examples
// are fixtures. All CLI reads use private SQLite and explicit network tripwires.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = '[已撤回/已删除]';
const TYPES = ['text', 'post', 'interactive', 'form', 'image', 'sticker', 'system'];
const LOCATIONS = ['canonical', 'outer', 'native'];
const { row, database } = createLegacyCardFixture({
  start: Date.UTC(2047, 8, 17, 12, 14), scope: 'lark.im.received.chat.invented_recall_boundary',
  chatId: 'oc_invented_recall_glass_garden', tempPrefix: 'exocortex-invented-recall-boundary-',
});
const plain = content => ({ tag: 'plain_text', content });

function event(label, type, location, flag = true) {
  const retained = `RETAINED_ARCHIVE_${label}`;
  const payload = type === 'text' ? { text: retained }
    : type === 'post' ? { content: [[{ tag: 'text', text: retained }]] }
    : type === 'interactive' ? { elements: [plain(retained)] }
    : type === 'form' ? { elements: [{ tag: 'form', elements: [{ tag: 'input', label: plain('Invented input'),
      value: retained, placeholder: plain(`RETAINED_HINT_${label}`) }] }] }
    : type === 'image' ? { image_key: `invented_image_${label}` }
    : type === 'sticker' ? { file_key: `invented_sticker_${label}` }
    : { template: retained };
  const entry = row(`recall_${label}`, payload, { body: retained });
  const nativeType = type === 'form' ? 'interactive' : type;
  entry.raw.msg_type = entry.canonical.msg_type = nativeType;
  entry.raw.content = entry.canonical.content = retained;
  delete entry.raw.content_rendering;
  delete entry.canonical.content_rendering;
  if (location === 'native') {
    entry.raw.raw_api = structuredClone(entry.raw);
    entry.raw.raw_api.deleted = flag;
  } else if (location === 'canonical') entry.canonical.deleted = flag;
  else if (location === 'outer') entry.raw.deleted = flag;
  return entry;
}
function fixture(t, entries) {
  const f = database(t, entries);
  f.guard = join(f.directory, 'no-network.mjs');
  writeFileSync(f.guard, `import {writeFileSync} from 'node:fs'; import {Socket} from 'node:net';
const deny=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('invented recall fixture forbids network');};
globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:180});\n`);
  return f;
}
function messages(f, format, extra = []) {
  const env = { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1',
    LARK_CLI: f.noNetworkCli, SYNTHETIC_NETWORK_MARKER: f.networkMarker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', f.guard, join(ROOT, 'bin/exocortex.mjs'),
    'messages', '--db', f.dbPath, '--format', format, '--limit', '100', ...extra], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(f.networkMarker), false, 'neither CLI nor socket/fetch may run');
  return format === 'json' ? JSON.parse(result.stdout) : result.stdout;
}
const blocks = output => output.split(/(?=^(?:SENT|RECEIVED) )/m).slice(1);
function archived(displayed, original) {
  assert.equal(displayed.external_id, original.raw.message_id);
  assert.equal(displayed.actor_id, original.raw.sender.id);
  assert.equal(displayed.container_id, original.raw.chat_id);
  assert.equal(displayed.body, original.body);
  assert.equal(displayed.raw_json, JSON.stringify(original.raw));
  assert.equal(displayed.canonical_json, JSON.stringify(original.canonical));
  assert.equal(displayed.occurred_at_ms, Number(original.raw.create_time));
  assert.equal(displayed.occurred_at, new Date(Number(original.raw.create_time)).toISOString());
  assert.equal(displayed.direction, 'received');
}
function noAlternateProjection(displayed) {
  for (const key of ['post', 'card', 'media', 'system', 'embedded_media']) {
    assert.equal(Object.hasOwn(displayed.display, key), false, `${key} must not shadow the tombstone`);
  }
}

test('real CLI: strict source tombstones cover seven types and all three sources without losing rows or neighbors', async t => {
  const targets = LOCATIONS.flatMap(location => TYPES.map(type => event(`${location}_${type}`, type, location)));
  const older = event('ordinary_older_card', 'interactive');
  older.body = 'Neighbor archive card body';
  const newer = event('ordinary_newer_post', 'post');
  const entries = [older, ...targets, newer];
  const f = fixture(t, entries), before = snapshot(f);
  const json = messages(f, 'json'), terminal = messages(f, 'text'), rendered = blocks(terminal);
  assert.equal(json.length, 23);
  assert.equal(rendered.length, 23);
  assert.match(terminal, /^Messages \(23\)/);
  assert.deepEqual(json.map(item => item.external_id), [...entries].reverse().map(item => item.raw.message_id));
  for (const original of targets) await t.test(original.name, () => {
    const index = json.findIndex(item => item.external_id === original.raw.message_id), item = json[index];
    archived(item, original);
    assert.equal(item.display.body, MARKER);
    noAlternateProjection(item);
    assert.equal(item.readiness.state, 'ready');
    const content = item.readiness.requirements.find(requirement => requirement.field === 'content');
    assert.equal(content.state, 'satisfied');
    assert.equal(content.evidence, 'source_tombstone');
    assert.equal(rendered[index].split(MARKER).length - 1, 1);
    assert.doesNotMatch(rendered[index], /RETAINED_ARCHIVE_|RETAINED_HINT_|invented_image_|invented_sticker_/);
  });
  // An otherwise identical unflagged database proves normal adjacent card/post
  // projections and their exact terminal blocks did not change with the guard.
  const liveEntries = structuredClone(entries);
  for (const entry of liveEntries) {
    delete entry.canonical.deleted; delete entry.raw.deleted;
    if (entry.raw.raw_api) delete entry.raw.raw_api.deleted;
  }
  const live = fixture(t, liveEntries), liveBefore = snapshot(live);
  const liveJson = messages(live, 'json'), liveText = blocks(messages(live, 'text'));
  for (const original of [older, newer]) {
    const index = json.findIndex(item => item.external_id === original.raw.message_id);
    archived(json[index], original);
    assert.deepEqual(json[index], liveJson[index]);
    assert.equal(rendered[index], liveText[index]);
  }
  assert.deepEqual(snapshot(f), before, 'DB bytes/hash/schema/times/records remain unchanged');
  assert.deepEqual(snapshot(live), liveBefore);
});

test('identity-incomplete recalled records retain their marker and original identity debt in place', async t => {
  for (const location of LOCATIONS) await t.test(location, () => {
    const original = event(`missing_sender_${location}`, 'form', location);
    delete original.canonical.sender_name;
    delete original.canonical.sender_name_source;
    delete original.raw.sender.name;
    if (original.raw.raw_api) delete original.raw.raw_api.sender.name;
    const f = fixture(t, [original]), before = snapshot(f);
    const [json] = messages(f, 'json'), terminal = messages(f, 'text');
    archived(json, original);
    assert.equal(json.readiness.state, 'enriching');
    assert.ok(json.readiness.reasons.includes('sender_name_missing'));
    assert.equal(json.display.body, MARKER);
    noAlternateProjection(json);
    assert.match(terminal, /Messages \(1\)/);
    assert.match(terminal, /等待完整信息/);
    assert.match(terminal, /发送人名称待补全/);
    assert.ok(terminal.includes(MARKER));
    assert.doesNotMatch(terminal, /RETAINED_ARCHIVE_|RETAINED_HINT_/);
    assert.deepEqual(snapshot(f), before);
  });
});

test('CLI truthiness negatives never create a tombstone from nonboolean deletion flags', async t => {
  const falseFlags = [['string', 'true'], ['number', 1], ['false', false], ['null', null], ['array', []]];
  const entries = LOCATIONS.flatMap(location => falseFlags.map(([label, flag]) => event(`${location}_${label}`, 'text', location, flag)));
  const f = fixture(t, entries), before = snapshot(f);
  const json = messages(f, 'json'), terminal = messages(f, 'text');
  assert.equal(json.length, 15);
  assert.equal(blocks(terminal).length, 15);
  assert.equal(terminal.includes(MARKER), false);
  for (const original of entries) await t.test(original.name, () => {
    const item = json.find(item => item.external_id === original.raw.message_id);
    archived(item, original);
    assert.notEqual(item.display.body, MARKER);
    assert.notEqual(item.readiness.requirements.find(requirement => requirement.field === 'content').evidence, 'source_tombstone');
  });
  assert.deepEqual(snapshot(f), before);
});

test('malformed native wrappers cannot manufacture a recalled state', async t => {
  for (const [label, wrapper] of [['null', null], ['array', []], ['string', 'true'], ['number', 1], ['false', false]]) {
    await t.test(label, () => {
      const original = event(`invalid_wrapper_${label}`, 'text');
      const f = fixture(t, [original]);
      original.raw.raw_api = wrapper;
      // The shared fixture assigns source clocks to native objects. Author a
      // malformed wrapper only after that construction, before the snapshot.
      const rawJson = JSON.stringify(original.raw);
      sqliteExec(f.dbPath, `UPDATE records SET raw_json=${quoteSql(rawJson)},
        content_hash=${quoteSql(createHash('sha256').update(rawJson).digest('hex'))};`);
      const before = snapshot(f);
      const [json] = messages(f, 'json'), terminal = messages(f, 'text');
      archived(json, original);
      assert.notEqual(json.display.body, MARKER);
      assert.equal(terminal.includes(MARKER), false);
      assert.deepEqual(snapshot(f), before);
    });
  }
});

test('recalled projections do not enter resource readers even with an expired trusted budget', () => {
  for (const location of LOCATIONS) for (const type of TYPES) {
    const original = event(`budget_${location}_${type}`, type, location);
    const stored = { id: 1, source_id: 'lark.im', record_type: 'lark.im.message', direction: 'received',
      external_id: original.raw.message_id, actor_id: original.raw.sender.id, container_id: original.raw.chat_id,
      occurred_at_ms: Number(original.raw.create_time), occurred_at: new Date(Number(original.raw.create_time)).toISOString(),
      body: original.body, raw_json: JSON.stringify(original.raw), canonical_json: JSON.stringify(original.canonical) };
    let now = 0, clockReads = 0;
    const budget = createHistoryCommandBudget({ maxSeconds: 1 }, { monotonicClock() { clockReads++; return now; } });
    now = 2000;
    const priorReads = clockReads;
    const projected = enrichRow(stored, undefined, true, undefined, undefined, null, true, undefined,
      { db: '/tmp/invented-recall-resource-db-must-not-be-opened', executionBudget: budget });
    assert.equal(projected.display.body, MARKER);
    noAlternateProjection(projected);
    assert.equal(clockReads, priorReads, 'resource boundary must not even test/open the cache');
    // Same source without deletion must still enter the guarded resource path;
    // the tripwire is active and did not become an inert fake budget.
    const canonical = JSON.parse(stored.canonical_json), raw = JSON.parse(stored.raw_json);
    delete canonical.deleted; delete raw.deleted;
    if (raw.raw_api) delete raw.raw_api.deleted;
    assert.throws(() => enrichRow({ ...stored, canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw) },
      undefined, true, undefined, undefined, null, true, undefined,
      { db: '/tmp/invented-recall-resource-db-must-not-be-opened', executionBudget: budget }), /time_budget/);
  }
});
