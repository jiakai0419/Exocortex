import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { runCli } from '../bin/exocortex.mjs';
import { commitLarkListRun, ensureInitialized, ensureSourceInitialSyncStart, quoteSql, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { chatScopeId, recordFromMessage } from '../src/adapters/lark-im/core.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { createLarkCliRunner, createTransportState, getTransportStats, resetTransportStats } from '../src/adapters/lark-im/transport.mjs';
import { executeResourceWork, resourceWorkIdentity } from '../src/maintenance/resource-work.mjs';
import { RESOURCE_CANDIDATE_INDEX, RESOURCE_CANDIDATE_WHERE } from '../src/maintenance/resource-candidates.mjs';
import { parseArgs, runCycle, runStep, runWorker } from '../src/runtime/worker/worker.mjs';
import { runGuardedWorkerStep } from '../src/runtime/worker/step-process.mjs';
import { readSharedLarkCooldown, tryAcquireLarkApiLease, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

// All source events, responses and image bytes are authored. The resource lane
// runs the actual guarded maintenance CLI and enrichResources; only the remote
// service is synthetic. All coordination paths are private to this fixture.
const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const SELF = { open_id: 'ou_synthetic_resource_worker_owner', name: 'Synthetic Resource Owner' };
const AUTHOR = 'ou_synthetic_resource_worker_author', AUTHOR_NAME = 'Synthetic Image Author';
const GROUP = 'oc_synthetic_resource_worker_group', TITLE = 'Synthetic Resource Group';
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function ownDir() {
  const dir = process.env.SYNTHETIC_RESOURCE_WORKER_ROOT;
  assert(dir?.startsWith(tmpdir()) && dir.includes('/exocortex-resource-worker-synthetic-'));
  return dir;
}
function denyNetwork() { const deny = () => { throw new Error('synthetic resource test forbids network'); }; globalThis.fetch = deny; Socket.prototype.connect = deny; }
function now(dir) { const c = read(join(dir, 'clock.json')); return c.epochMs + Number((process.hrtime.bigint() - BigInt(c.anchorNs)) / 1_000_000n); }
function advance(dir, ms) { writeFileSync(join(dir, 'clock.json'), JSON.stringify({ epochMs: now(dir) + Math.round(ms), anchorNs: String(process.hrtime.bigint()) })); }
function log(dir, event) { appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ atMs: now(dir), pid: process.pid, ...event }) + '\n'); }
function events(dir) { return readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function png() {
  const chunk = (tag, bytes) => {
    const data = Buffer.concat([Buffer.from(tag), bytes]), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    len.writeUInt32BE(bytes.length); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([len, data, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 30, 110, 220, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function entry(label, atMs, kind = 'image') {
  return { label, kind, sourceAtMs: atMs, availableAtMs: atMs,
    message: { message_id: `om_${label}`, chat_id: GROUP, chat_type: 'group', msg_type: kind,
      create_time: String(atMs), update_time: String(atMs + 1),
      sender: { id: AUTHOR, id_type: 'open_id', sender_type: 'user', name: AUTHOR_NAME },
      body: { content: JSON.stringify(kind === 'image' ? { image_key: `img_synthetic_${label}` } : { text: `Synthetic ${label} body; spacing  stays.` }) } } };
}
function publishTraffic(dir, cycle) {
  const manifest = read(join(dir, 'publisher.json')), atMs = now(dir);
  if (cycle === 1 && manifest.invalidPrefix) seedInvalidPrefix(dir);
  const first = manifest.entries.filter(source => source.label.startsWith('n')).length;
  const count = cycle === 1 ? 45 : 2;
  const fresh = Array.from({ length: count }, (_, index) => entry(`n${String(first + index).padStart(4, '0')}`, atMs, 'image'));
  manifest.entries.push(...fresh); writeFileSync(join(dir, 'publisher.json'), JSON.stringify(manifest));
  log(dir, { type: 'source_publication', labels: fresh.map(source => source.label), sourceAtMs: atMs, availableAtMs: atMs });
}
function sessionDeps(dir) {
  const directory = join(dir, 'api-state'); let virtual = 0;
  const monotonicClock = () => performance.now() + virtual;
  return { monotonicClock, sleep: ms => { virtual += ms; },
    tryAcquireLease: options => tryAcquireLarkApiLease(options, { directory, monotonicClock }),
    readSharedCooldown: options => readSharedLarkCooldown(options, { directory }),
    writeSharedCooldown: options => writeSharedLarkCooldown(options, { directory }),
  };
}
function observe(dir, context) {
  const db = join(dir, 'synthetic.sqlite'), before = sqliteQuery(db, 'SELECT * FROM records ORDER BY id;');
  // Producers and observations share the fixture's wall clock. The stress case
  // advances idle sleeps virtually; real Date.now() would reject later valid
  // account evidence as future-dated. Freeze only the reader's validation
  // clock, not the parent monotonic source/completion measurements.
  const observationClock = join(dir, 'messages-observation-clock.mjs');
  writeFileSync(observationClock, `Date.now = () => ${now(dir)};\n`);
  const invoke = format => {
    const child = spawnSync(process.execPath, ['--import', join(dir, 'deny-network.mjs'), '--import', observationClock, join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', db, '--limit', '100', '--direction', 'received', '--format', format], { cwd: dir, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, LARK_CLI: join(dir, 'reject-lark'), NO_COLOR: '1', TZ: 'UTC' } });
    assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.stderr, '');
    return { text: child.stdout, atMs: now(dir) };
  };
  const json = invoke('json'), rows = JSON.parse(json.text), terminal = invoke('text');
  const cohort = before.filter(row => row.direction === 'received');
  const sorted = [...cohort].sort((a, b) => b.occurred_at_ms - a.occurred_at_ms || b.external_id.localeCompare(a.external_id));
  assert.deepEqual(rows.map(row => row.external_id), sorted.map(row => row.external_id));
  const ids = [...terminal.text.matchAll(/om_[a-z0-9]{5}\b/g)];
  assert.deepEqual(ids.map(match => match[0]), rows.map(row => row.external_id), 'text preserves all stored rows and their order');
  for (const row of rows) {
    const stored = before.find(x => x.id === row.id), native = row.raw.raw_api || row.raw;
    const source = read(join(dir, 'publisher.json')).entries.find(x => x.message.message_id === row.external_id);
    assert(source); assert.deepEqual(native, source.message);
    assert.equal(row.occurred_at_ms, source.sourceAtMs); assert.equal(stored.external_version, source.message.update_time);
    for (const key of ['actor_id', 'container_id', 'direction', 'body', 'occurred_at', 'occurred_at_ms']) assert.equal(row[key], stored[key]);
    assert(terminal.text.includes(row.external_id), 'text retains every unresolved message in its denominator');
    if (source.kind === 'image' && row.readiness.state === 'ready') {
      const index = ids.findIndex(match => match[0] === row.external_id);
      const block = terminal.text.slice(ids[index].index, ids[index + 1]?.index);
      assert.equal(row.display.sender, AUTHOR_NAME); assert.equal(row.display.chat, TITLE);
      assert.equal(row.display.media.resource.availability, 'available');
      assert.equal(sha(readFileSync(row.display.media.resource.path)), sha(png()));
      assert(block.includes('本地资源已验证')); assert(block.includes(AUTHOR_NAME)); assert(block.includes(TITLE));
    }
  }
  assert.deepEqual(sqliteQuery(db, 'SELECT * FROM records ORDER BY id;'), before, 'messages is read-only');
  log(dir, { type: 'messages_observation', context, denominator: rows.length,
    rows: rows.map(row => ({ externalId: row.external_id, state: row.readiness.state, reasons: row.readiness.reasons })),
    jsonAtMs: json.atMs, textAtMs: terminal.atMs }); return rows;
}
// Match actual resource invocations to each logical idle slice. A second
// bounded unit is optional; an empty probe is never counted as an acquisition.
function assertResourceSlices(journal) {
  const slices = []; let after = 0;
  for (let end = 0; end < journal.length; end++) {
    const cycle = journal[end]; if (cycle.type !== 'cycle') continue;
    const rows = journal.slice(after, end); after = end + 1;
    const units = rows.filter(x => x.type === 'resource_step');
    const grants = rows.filter(x => x.type === 'resource_spawn');
    const claims = rows.filter(x => x.type === 'lane_claim');
    assert(units.length <= 2, 'at most two resource units in the original idle slice');
    assert.equal(grants.length, units.length);
    assert.equal(claims.length, units.length ? 1 : 0, 'surplus never claims another first-service turn');
    if (!units.length) { slices.push({ cycle, units, grants, claims }); continue; }
    assert(claims[0].claimed && claims[0].lane === 'resources');
    const idle = cycle.steps.find(x => x.name === 'history'); assert(idle);
    assert.equal(idle.ok, true); assert.equal(idle.summary.ok, true);
    assert.equal(idle.summary.idle_outcome, 'completed');
    assert(Number.isFinite(idle.elapsed_ms) && idle.elapsed_ms >= 0 && idle.elapsed_ms <= 25000,
      'measured complete idle work remains inside the unchanged 25-second slice');
    const measured = rows.slice(rows.indexOf(claims[0])).filter(x => x.type === 'api');
    const totals = { cli: 0, self: 0, available: 0 };
    for (let i = 0; i < units.length; i++) {
      const { step } = units[i], grant = grants[i], summary = step.summary, budget = summary.request_budget;
      assert(step.ok && !step.guardian_diagnostic); assert.equal(budget.complete, true);
      assert.equal(budget.max_cli_attempts, 3); assert.equal(budget.max_self_attempts, 2);
      assert.equal(budget.min_interval_ms, 1000); assert.equal(budget.stop_reason, null);
      assert(Number.isSafeInteger(grant.timeoutMs) && grant.timeoutMs > 0 && grant.timeoutMs <= 23000);
      assert(grant.timeoutMs + 2000 <= grant.remainingMs, 'original guardian cleanup is contained in remaining shared time');
      assert(grant.remainingMs <= 25000 && grant.remainingMs > 2000,
        'the final spawn shrinks after local preparation; the six-second scheduler admission is tested separately');
      if (i) {
        assert(grant.timeoutMs < grants[i - 1].timeoutMs, 'surplus shares the original shrinking deadline');
        assert(grant.monotonicMs >= grants[i - 1].monotonicMs, 'observed monotonic time cannot move backwards');
        const gap = journal.slice(journal.indexOf(units[i - 1]) + 1, journal.indexOf(grant))
          .filter(x => x.type === 'worker_sleep');
        assert.deepEqual(gap.map(x => x.seconds), [1], 'the existing one-second inter-unit sleep is requested exactly once');
      }
      const start = journal.indexOf(grant), finish = journal.indexOf(units[i]);
      const calls = journal.slice(start, finish).filter(x => x.type === 'api');
      assert.equal(budget.cli_attempts, calls.length);
      assert.equal(budget.self_attempts, calls.filter(x => x.route === 'self').length);
      if (summary.outcome === 'no_eligible_known_resource') {
        assert.deepEqual(['processed','available','deferred','blocked'].map(key => summary[key]), [0,0,0,0]);
        assert.equal(budget.cli_attempts, 0); assert.equal(budget.self_attempts, 0);
      } else {
        assert.equal(summary.outcome, 'processed');
        assert.deepEqual(['processed','available','deferred','blocked'].map(key => summary[key]), [1,1,0,0]);
        assert.equal(budget.cli_attempts, 3); assert.equal(budget.self_attempts, 2);
      }
      totals.cli += budget.cli_attempts; totals.self += budget.self_attempts; totals.available += summary.available;
    }
    assert(totals.cli <= 12 && totals.self <= 6, 'original shared API budgets remain unchanged');
    assert.equal(totals.cli, measured.length); assert.equal(totals.self, measured.filter(x => x.route === 'self').length);
    assert.equal(idle.summary.resources.available, totals.available);
    assert.equal(idle.summary.resources.request_budget.cli_attempts, totals.cli);
    assert.equal(idle.summary.resources.request_budget.self_attempts, totals.self);
    slices.push({ cycle, units, grants, claims });
  }
  return slices;
}
function fixture(t, invalidPrefix) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-resource-worker-synthetic-')), db = join(dir, 'synthetic.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = Date.now(); writeFileSync(join(dir, 'clock.json'), JSON.stringify({ epochMs: base, anchorNs: String(process.hrtime.bigint()) }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  const initial = [...Array.from({length:4}, (_,i) => entry(`d000${i}`, base - 30000 + i)),
    entry('x0000',base-29990),entry('x0001',base-29989)];
  writeFileSync(join(dir, 'publisher.json'), JSON.stringify({ invalidPrefix, entries: initial }));
  writeFileSync(join(dir, 'fake-lark'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(HERE)} --remote "$@"\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'reject-lark'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
  writeFileSync(join(dir, 'deny-network.mjs'), "import{Socket}from'node:net';const deny=()=>{throw new Error('synthetic read forbids network')};globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:160});\n");
  ensureInitialized(db); ensureSourceInitialSyncStart(db, 'lark.im', base - 600000, { explicit: true, endMs: base });
  sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(chatScopeId(GROUP))},'lark.im','Synthetic group',${quoteSql(JSON.stringify({ chat_id: GROUP, chat_type: 'group', chat_name: TITLE }))});`);
  assert.equal(sqliteQuery(db, 'SELECT COUNT(*) n FROM records;')[0].n, 0);
  seedDeepHistory(dir, db, 'older');
  return { dir, db, base, initial };
}
// Make both legacy discovery windows miss the six worker-collected images:
// 5000 earlier text rows exist before acquisition; 500 later text rows are
// appended after the forward commit, before its first resource opportunity.
function seedDeepHistory(dir, db, phase = 'newer') {
  const marker = join(dir, `deep-seeded-${phase}`);
  if (existsSync(marker)) return;
  const earlier = phase === 'older', count = earlier ? 5000 : 500;
  const initial = read(join(dir, 'publisher.json')).entries.filter(x => x.kind === 'image');
  assert.equal(initial.length, 6);
  const current = sqliteQuery(db, 'SELECT id,external_id FROM records ORDER BY id;');
  assert.equal(current.length, earlier ? 0 : 5006);
  const images = current.filter(row => initial.some(source => source.message.message_id === row.external_id));
  if (!earlier) {
    assert.equal(images.length, 6, 'images must traverse real worker collection before the later text seed');
    assert(images.every(row => row.id > 14998));
  }
  const at = now(dir), scope = chatScopeId(GROUP);
  const sourceStart = earlier ? Math.min(...initial.map(x => x.sourceAtMs)) - 90000
    : Math.max(...initial.map(x => x.sourceAtMs)) + 10000;
  const idStart = earlier ? 1 : current.at(-1).id + 100;
  const records = Array.from({ length: count }, (_, i) => {
    const source = entry(`${earlier ? 'b' : 'c'}${String(i).padStart(4, '0')}`, sourceStart + i, 'text');
    source.message.sender = { id: SELF.open_id, id_type: 'open_id', sender_type: 'user', name: SELF.name };
    const row = recordFromMessage(source.message, scope, 'sent', { self: SELF }, { chat_id: GROUP, chat_type: 'group', chat_name: TITLE });
    return { ...bindAcquiredMessageAccounts([row], SELF, { acquiredAt: new Date(at).toISOString() })[0], id: idStart + i * 3 };
  });
  const keys = Object.keys(records[0]);
  sqliteExec(db, `BEGIN IMMEDIATE; INSERT INTO records(${keys.join(',')}) VALUES ${records.map(row => '(' + keys.map(key => quoteSql(row[key])).join(',') + ')').join(',')}; COMMIT;`);
  writeFileSync(marker, `authored ${count} ${phase} text records`);
  log(dir, { type: 'deep_history_seed', phase, rows: count, lowestId: records[0].id, highestId: records.at(-1).id,
    imageRecordIds: images.map(row => row.id) });
}

function seedInvalidPrefix(dir) {
  const db = join(dir, 'synthetic.sqlite'), at = now(dir), scope = chatScopeId(GROUP);
  const start = sqliteQuery(db, 'SELECT MAX(id) AS id FROM records;')[0].id + 1;
  const rows = Array.from({length:25}, (_, index) => {
    const source = entry(`v${String(index).padStart(4, '0')}`, at);
    source.message.sender = { id: SELF.open_id, id_type: 'open_id', sender_type: 'user', name: SELF.name };
    source.message.body.content = JSON.stringify({ image_key: '' });
    const record = recordFromMessage(source.message, scope, 'sent', { self: SELF }, {chat_id:GROUP, chat_type:'group', chat_name:TITLE});
    return {...bindAcquiredMessageAccounts([record], SELF, {acquiredAt:new Date(at).toISOString()})[0], id:start+index};
  });
  const keys=Object.keys(rows[0]);
  sqliteExec(db, `BEGIN IMMEDIATE; INSERT INTO records(${keys.join(',')}) VALUES ${rows.map(row => '('+keys.map(key=>quoteSql(row[key])).join(',')+')').join(',')}; COMMIT;`);
  assert.equal(sqliteQuery(db, `SELECT count(*) n FROM records INDEXED BY ${RESOURCE_CANDIDATE_INDEX} WHERE ${RESOURCE_CANDIDATE_WHERE} AND id>=${start};`)[0].n,25);
  assert(rows.every(row=>resourceWorkIdentity(db,row)===null), 'every indexed invalid candidate lacks a valid resource identity');
  const positive=sqliteQuery(db, "SELECT * FROM records WHERE external_id='om_d0000';")[0];
  assert(resourceWorkIdentity(db,positive), 'same strict validator accepts a valid original image');
  log(dir,{type:'invalid_prefix_seed',recordIds:rows.map(row=>row.id),count:rows.length});
}
function scanEntry(db, atMs) {
  return {atMs, scan:sqliteQuery(db,'SELECT * FROM lark_im_resource_scan;')[0],
    head:sqliteQuery(db,`SELECT COALESCE(MAX(id),0) id FROM records INDEXED BY ${RESOURCE_CANDIDATE_INDEX} WHERE ${RESOURCE_CANDIDATE_WHERE};`)[0].id};
}

function worker(dir) {
  const child = spawnSync(process.execPath, [HERE, '--worker'], { cwd: dir, encoding: 'utf8', timeout: 180000, maxBuffer: 3 * 1024 * 1024,
    env: { ...process.env, SYNTHETIC_RESOURCE_WORKER_ROOT: dir, LARK_CLI: join(dir, 'fake-lark'), NO_COLOR: '1' } });
  assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.stderr, '');
  return JSON.parse(child.stdout);
}

if (process.argv[2] === '--remote') {
  denyNetwork(); const dir = ownDir(), args = process.argv.slice(3), manifest = read(join(dir, 'publisher.json'));
  const fd = fstatSync(3), lock = statSync(join(dir, 'api-state', 'api.lock')); assert.equal(fd.ino, lock.ino); assert.equal(fd.dev, lock.dev);
  const param = flag => JSON.parse(args[args.indexOf(flag) + 1]);
  const respond = value => process.stdout.write(JSON.stringify(value));
  const call = extra => log(dir, { type: 'api', command: process.env.SYNTHETIC_RESOURCE_COMMAND, inheritedLease: true, ...extra });
  const available = manifest.entries.filter(x => x.availableAtMs <= now(dir));
  if (args[0] === 'contact' && args[1] === '+get-user') { call({ route: 'self' }); respond(SELF); }
  else if (args[0] === 'im' && args[1] === '+chat-list') { call({ route: 'discovery' }); respond({ chats: [{ chat_id: GROUP, chat_mode: 'group', name: TITLE }], has_more: false }); }
  else if (args[2] === '/open-apis/im/v1/messages/search') { const selected = []; call({ route: 'sent', ids: selected.map(x => x.message.message_id) }); respond({ code: 0, data: { items: selected.map(x => ({ meta_data: { message_id: x.message.message_id } })), has_more: false } }); }
  else if (args[2] === '/open-apis/im/v1/messages') {
    const p = param('--params'), selected = available.filter(x => x.message.chat_id === p.container_id && Number(x.message.create_time) >= Number(p.start_time) * 1000 && Number(x.message.create_time) <= Number(p.end_time) * 1000);
    call({ route: 'list', ids: selected.map(x => x.message.message_id) }); respond({ code: 0, data: { items: selected.map(x => x.message), has_more: false } });
  } else if (args[2]?.includes('/resources/')) {
    const [id, key] = args[2].split('/messages/')[1].split('/resources/');
    const source = available.find(x => x.message.message_id === id); assert(source?.kind === 'image'); assert.equal(key, `img_synthetic_${source.label}`);
    call({ route: 'download', id });
    const path = args[args.indexOf('--output') + 1]; assert(/^resource-\d+\.bin$/.test(path)); writeFileSync(path, png(), { mode: 0o600, flag: 'wx' }); respond({ saved_path: path, size_bytes: png().length, content_type: 'image/png' });
  } else if (args[2] === '/open-apis/im/v1/messages/mget' || args[2]?.startsWith('/open-apis/im/v1/messages/')) {
    const ids = args[2].endsWith('/mget') ? param('--params').message_ids : [decodeURIComponent(args[2].split('/').at(-1))];
    const selected = available.filter(x => ids.includes(x.message.message_id)); assert.equal(selected.length, ids.length); call({ route: 'detail', ids }); respond({ code: 0, data: { items: selected.map(x => x.message) } });
  } else if (args[0] === 'contact' && args[1] === '+search-user') {
    const ids = args[args.indexOf('--user-ids') + 1].split(','); call({ route: 'contact', ids }); respond({ users: ids.map(open_id => ({ open_id, name: open_id === AUTHOR ? AUTHOR_NAME : `Synthetic Peer ${open_id.split('_').at(-1)}` })) });
  } else if (args.slice(0, 3).join(' ') === 'im chats get') {
    const chat_id = param('--params').chat_id; call({ route: 'chat', chat_id }); respond({ data: { chat_id, chat_mode: chat_id === GROUP ? 'group' : 'p2p', name: chat_id === GROUP ? TITLE : null } });
  }  else if (args[0] === 'im' && args[1] === 'chat.members') { call({ route: args[2] }); respond({ items: [], has_more: false }); }
  else { call({ route: 'unexpected', args: args.slice(0, 3) }); process.exitCode = 1; }
} else if (['sync', 'maintenance'].includes(process.argv[2])) {
  denyNetwork(); const dir = ownDir(), args = process.argv.slice(2), db = join(dir, 'synthetic.sqlite'), directory = join(dir, 'api-state');
  process.env.SYNTHETIC_RESOURCE_COMMAND = `${args[0]}:${args[1]}`;
  assert.equal(args[args.indexOf('--db') + 1], db);
  const state = createTransportState(), remote = createLarkCliRunner({ bin: join(dir, 'fake-lark'), state,
    readSharedCooldown: o => readSharedLarkCooldown(o, { directory }), writeSharedCooldown: o => writeSharedLarkCooldown(o, { directory }) });
  const adapter = createLarkImAdapter({ run: remote });
  log(dir, { type: 'cli_start', command: args[0], operation: args[1], args });
  const code = await runCli(args, { monotonicNow: () => process.uptime() * 1000, startedMonotonicMs: 0, now: args[0] === 'sync' || args[1] === 'resources' ? () => now(dir) : Date.now, deps: {
    getSelfProfile: args[0] === 'sync' ? adapter.getSelfProfile : undefined,
    getTransportStats: () => getTransportStats(state), resetTransportStats: () => resetTransportStats(state),
    tryAcquireLarkApiLease: o => tryAcquireLarkApiLease(o, { directory }),
    // Queue metadata uses its real monotonic clock. Only the producer request
    // session elides gaps; crossing those clocks would fabricate lease expiry.
    tryAcquireLease: o => tryAcquireLarkApiLease(o, { directory, monotonicClock: () => performance.now() }),
    requestSessionDeps: sessionDeps(dir),
    executeResourceWork(options, deps) {
      let recorded=false;
      return executeResourceWork(options,{...deps,now:()=>{
        const atMs=deps.now();
        // The first now call is executeResourceWork's exact immutable entry wall.
        // Observe it without freezing, advancing, or replacing the clock.
        if(!recorded){recorded=true;log(dir,{type:'resource_entry',...scanEntry(db,atMs)});}
        return atMs;
      }});
    },
    syncRunnerDeps: { ...adapter, nowIso: () => new Date(now(dir)).toISOString(),
      commitLarkListRun(...parameters) {
        log(dir, { type: 'identity_prepared', ids: parameters[3].filter(x => {
          const c = JSON.parse(x.canonical_json); return c.sender_name === AUTHOR_NAME && c.chat_name === TITLE;
        }).map(x => x.external_id) });
        const outcome = commitLarkListRun(...parameters); log(dir, { type: 'collection_commit', ids: parameters[3].map(x => x.external_id) }); return outcome;
      }, syncNames(path, profile) { const report = syncNames(path, profile, { runLark: remote, now: () => now(dir) }); assert(report.calls <= 4); log(dir, { type: 'name_tail', report }); return report; },
    },
  } });
  log(dir, { type: 'cli_end', command: args[0], operation: args[1], code }); process.exitCode = code;
} else if (process.argv[2] === '--worker') {
  denyNetwork(); const dir = ownDir(), db = join(dir, 'synthetic.sqlite');
  log(dir, { type: 'worker_started' });
  const { resourceWorkAvailable } = await import('../src/maintenance/resource-work.mjs');
  const { readIdleFairState, claimIdleLane } = await import('../src/runtime/worker/idle-fair-state.mjs');
  const opts = parseArgs(['--max-cycles','2','--db',db,'--log-dir',join(dir,'logs'),'--remote-sample-interval-seconds','0']);
  const helperDeps = deps => ({ ...deps, tryAcquireLease: (o, leaseDeps) => tryAcquireLarkApiLease(o, { ...leaseDeps, directory: join(dir, 'api-state') }) });
  const result = runWorker(opts, { nowMs: () => now(dir), monotonicNowMs: () => performance.now(),
    // Preserve this fixture's virtual worker sleeps. Actual elapsed I/O and the
    // requested fixed gap are observed separately; neither is a production SLO.
    sleepSeconds: s => { log(dir, { type: 'worker_sleep', seconds: s }); advance(dir, s * 1000); }, writeScheduler() {},
    hasHistoryWork: () => false,
    hasResourceWork: o => { const available = resourceWorkAvailable(o.db, { now: () => now(dir) }); log(dir, { type: 'resource_hint', available }); return available; },
    readIdleFairState: (path, deps) => { const state = readIdleFairState(path, helperDeps(deps)); log(dir, { type: 'fair_read', state }); return state; },
    claimIdleLane: (path, state, lane, eligible, deps) => {
      const next = claimIdleLane(path, state, lane, eligible, helperDeps(deps));
      log(dir, { type: 'lane_claim', lane, eligible, claimed: Boolean(next), sequence: next?.sequence }); return next;
    },
    runResources: (args, limits) => {
      const before = sqliteQuery(db, 'SELECT * FROM records ORDER BY id;');
      let remainingMs;
      const step = runStep('resources', args, { command: 'maintenance', scriptPath: HERE, ...limits,
        remainingTimeMs: () => (remainingMs = limits.remainingTimeMs()),
        nowMs: () => now(dir), monotonicNowMs: () => performance.now(),
        runProcess(command, argv, settings) {
          log(dir, { type: 'resource_spawn', timeoutMs: settings.timeout, remainingMs, monotonicMs: performance.now() });
          return runGuardedWorkerStep(command, argv, settings);
        } });
      assert.deepEqual(sqliteQuery(db, 'SELECT * FROM records ORDER BY id;'), before,
        'resource work preserves every source column, including version, hash, raw, body, account evidence and clocks');
      log(dir, { type: 'resource_step', step });
      log(dir, { type: 'deep_resource_checkpoint', tasks: sqliteQuery(db,
        'SELECT record_id,state,enqueued_at_ms,attempts FROM lark_im_resource_work ORDER BY record_id;'), scan: sqliteQuery(db, 'SELECT after_id,horizon_id,last_head_id,next_scan_at_ms,priority_streak,generation FROM lark_im_resource_scan;')[0] });
      observe(dir, 'after_resource'); return step;
    },
    runCycle: (options, cycle, deps) => runCycle(options, cycle, { ...deps,
      beforeHistory: (steps, history) => { seedDeepHistory(dir, db); return deps.beforeHistory(steps, history); }, runStep: { scriptPath: HERE }, writeLog: { stdout: { write() {} } },
      onComplete: (steps, payload) => { deps.onComplete?.(steps, payload); log(dir, { type: 'cycle', cycle, ok: payload.ok, steps }); observe(dir, 'cycle'); publishTraffic(dir, events(dir).filter(x => x.type === 'cycle').length); } }),
  });
  process.stdout.write(JSON.stringify({ ok: result }));
 } else {
  for(const invalidPrefix of [false,true]) test(`continuous images${invalidPrefix ? ' with 25 invalid candidates' : ''}: due discovery and oldest service survive worker restarts`, t => {
    const { dir, db, initial } = fixture(t, invalidPrefix);
    for (let restart = 0; restart < 3; restart++) worker(dir);
    const journal = events(dir), final = observe(dir, 'continuous_image_final');
    const starts = journal.filter(event => event.type === 'worker_started');
    const steps = journal.filter(event => event.type === 'resource_step');
    const checkpoints = journal.filter(event => event.type === 'deep_resource_checkpoint');
    const downloads = journal.filter(event => event.type === 'api' && event.route === 'download');
    const claims = journal.filter(event => event.type === 'lane_claim');
    const sources = read(join(dir, 'publisher.json')).entries;
    const stored = sqliteQuery(db, "SELECT id,external_id FROM records WHERE direction='received' ORDER BY id;");
    assert.equal(starts.length, 3); assert.equal(new Set(starts.map(event => event.pid)).size, 3);
    const slices = assertResourceSlices(journal); assert.equal(slices.length, 6);
    assert(slices.every(slice => slice.units.length >= 1), 'each eligible cycle retains its first resource service');
    assert.equal(checkpoints.length, steps.length); assert.equal(downloads.length, steps.length);
    assert.equal(new Set(downloads.map(event => event.id)).size, downloads.length, 'no completed image is downloaded twice');
    assert.equal(claims.length, 6); assert(claims.every(event => event.claimed && event.lane === 'resources'));
    assert.deepEqual(claims.map(event => event.sequence), [1,2,3,4,5,6]);
    for (const claim of claims) {
      const start = journal.indexOf(claim), end = journal.findIndex((event, index) => index > start && event.type === 'cycle');
      assert(end > start);
      const first = journal.slice(start + 1, end).find(event => event.type === 'cli_start' && ['resources','history'].includes(event.operation));
      assert(first); assert.equal(first.operation, 'resources');
      const calls = journal.slice(start, end).filter(event => event.type === 'api');
      assert(calls.length <= 12); assert(calls.filter(event => event.route === 'self').length <= 6);
    }
    assert(steps.every(event => event.step.ok && !event.step.guardian_diagnostic && event.step.summary.available === 1));
    assert(steps.every(event => event.step.summary.request_budget.complete
      && event.step.summary.request_budget.cli_attempts === 3 && event.step.summary.request_budget.self_attempts === 2));
    assert.deepEqual(checkpoints.map(event => event.scan.priority_streak), steps.map((_step, index) => (index + 1) % 3));
    assert.equal(downloads[2].id, initial[0].message.message_id, 'oldest original is served on the third actual resource unit');
    assert.equal(downloads[5].id, initial[1].message.message_id, 'next oldest original is served under continuing new images');
    assert(journal.indexOf(downloads[5]) > journal.indexOf(starts[1]), 'oldest service continues after an actual process restart');
    for (let index = 2; index < downloads.length; index += 3)
      assert.equal(downloads[index].id, initial[(index - 2) / 3].message.message_id, 'each third unit retains exact oldest original priority');
    const oldestId = stored.find(row => row.external_id === initial[0].message.message_id).id;
    const originalAge = checkpoints[0].tasks.find(task => task.record_id === oldestId).enqueued_at_ms;
    assert(checkpoints.every(event => event.tasks.find(task => task.record_id === oldestId).enqueued_at_ms === originalAge),
      'new arrivals and restarts cannot reset original enqueue age');
    const burst = sources.filter(source => /^n00[0-3]\d$/.test(source.label) || /^n004[0-4]$/.test(source.label));
    assert.equal(burst.length, 45);
    const burstIds = burst.map(source => stored.find(row => row.external_id === source.message.message_id)?.id);
    assert(burstIds.every(Number.isSafeInteger), 'all 45 images traverse the actual forward CLI');
    const entries=journal.filter(event=>event.type==='resource_entry');
    assert.equal(entries.length,steps.length);
    const burstEntry = entries.findIndex(event => event.head >= Math.max(...burstIds));
    assert(burstEntry >= 1, 'post-burst scan is located from the committed candidate head, not the unit number');
    const missingAfterBurst = burstIds.filter(id => !checkpoints[burstEntry].tasks.some(task => task.record_id === id));
    assert.equal(missingAfterBurst.length, invalidPrefix ? 25 : 11,
      'bounded newest/history pages must leave a real unqueued middle cohort');

    const scanKeys=['after_id','horizon_id','last_head_id','next_scan_at_ms'];
    const trace=checkpoints.map((checkpoint,index)=>{
      const before=entries[index],due=before.scan.next_scan_at_ms<=before.atMs||before.head>before.scan.last_head_id;
      if(index)for(const key of scanKeys)assert.equal(before.scan[key],checkpoints[index-1].scan[key],`persisted ${key} survives cycle/process restart`);
      if(due){
        assert.equal(checkpoint.scan.next_scan_at_ms,before.atMs+60000);
        assert.equal(checkpoint.scan.last_head_id,before.head);
        if(before.scan.horizon_id>before.scan.after_id){
          assert.equal(checkpoint.scan.horizon_id,before.scan.horizon_id,'new arrivals retain unfinished fixed horizon');
          assert(checkpoint.scan.after_id>before.scan.after_id,'this nonempty due historical page advances');
        }
      }else for(const key of scanKeys)assert.equal(checkpoint.scan[key],before.scan[key],`non-due service preserves ${key}`);
      return {opportunity:index+1,due,entryAtMs:before.atMs,entryHead:before.head,
        beforeScan:before.scan,afterScan:checkpoint.scan,queued:checkpoint.tasks.length,
        burstUnqueued:burstIds.filter(id=>!checkpoint.tasks.some(task=>task.record_id===id)).length};
    });
    assert(trace.some(row=>!row.due),'an existing task must actually be served between due scans');
    const continued=trace.findIndex((row,index)=>index>burstEntry&&row.burstUnqueued===0);
    assert(continued>burstEntry,'all 45 original burst images require and receive a later due scan');
    assert(trace.slice(0,continued+1).filter(row=>row.due).length<=6,
      'burst completion retains the original six-cycle bound, independent of surplus units');
    assert(trace[continued].due,'burst discovery follows a due scan, not merely a selection turn');
    const invalid=journal.filter(event=>event.type==='invalid_prefix_seed');
    assert.equal(invalid.length,invalidPrefix?1:0);
    const invalidIds=invalid.flatMap(event=>event.recordIds);
    assert.equal(invalidIds.length,invalidPrefix?25:0);
    assert(checkpoints.every(checkpoint=>checkpoint.tasks.every(task=>!invalidIds.includes(task.record_id))),
      'invalid candidates must never enroll or displace stable valid work');
    assert(downloads.every(event=>!event.id.startsWith('om_v')),'no invalid resource reaches the API boundary');
    if(invalidPrefix){
      assert(trace[burstEntry].afterScan.after_id>=invalidIds[0]&&trace[burstEntry].afterScan.after_id<invalidIds.at(-1),
        'first post-burst history page stops inside the invalid prefix');
      const crossed=trace.find(row=>row.afterScan.after_id>=invalidIds.at(-1));
      assert(crossed&&crossed.opportunity>burstEntry+1,'a later due page crosses the invalid prefix');
      assert(journal.indexOf(checkpoints[crossed.opportunity-1])>journal.indexOf(starts[1]),
        'the unfinished invalid-prefix horizon survives a process restart');
    }
    t.diagnostic(JSON.stringify({phase:'verified-due-scan-trace',invalidCandidates:invalidIds.length,trace}));
    const observations = journal.filter(event => event.type === 'messages_observation');
    const originals = initial.slice(0,4).map(source => source.message.message_id);
    assert(observations.every(event => originals.every(id => event.rows.some(row => row.externalId === id))),
      'unready original targets remain in every real JSON/text cohort');
    assert.equal(sources.length, 61); assert.equal(stored.length, 59); assert.equal(final.length, 59);
    assert.deepEqual(checkpoints.at(-1).tasks.map(task=>task.record_id),stored.map(row=>row.id),
      'every collected image has exactly one final task; no invalid candidate joins the denominator');
    assert.equal(final.filter(row => row.readiness.state === 'ready').length, downloads.length);
    assert.equal(final.filter(row => row.readiness.state !== 'ready').length, 59-downloads.length);
    assert.deepEqual(final.filter(row=>row.readiness.state==='ready').map(row=>row.external_id).sort(),
      downloads.map(event=>event.id).sort(), 'each real ready image corresponds exactly to one verified acquisition');
    assert.equal(sqliteQuery(db, 'SELECT COUNT(*) n FROM records;')[0].n, 5559+(invalidPrefix?25:0));
    assert.deepEqual(journal.filter(event => event.type === 'api' && event.route === 'unexpected'), []);
    t.diagnostic(JSON.stringify({ scenario:invalidPrefix?'continuous-images-invalid-prefix-restarts':'continuous-images-after-deep-history', sourceImages:61, collectedImages:59,queuedImages:checkpoints.at(-1).tasks.length,
      imageReady:downloads.length, imageUnready:59-downloads.length, notYetCollected:2, unrelatedTexts:5500, firstNewBurst:45,
      burstMissingAfterFirstPage:missingAfterBurst.length, burstMissingAfterContinuation:0,burstCompleteOpportunity:continued+1,invalidCandidates:invalidIds.length,
      idleSlices:6, resourceUnits:steps.length, workerProcesses:3, oldestServiceOpportunities:downloads.map((_event,index)=>index+1).filter(n=>n%3===0), initialAgePreserved:true,
      sourceColumnsPreservedByRealResourceAndMessagesReads:true,
      bound:'conditional synthetic candidate-discovery and queue-order proof; resources-only eligible; not three-lane fairness or production latency' }));
  });
}
