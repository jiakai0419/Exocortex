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
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { createLarkCliRunner, createTransportState, getTransportStats, resetTransportStats } from '../src/adapters/lark-im/transport.mjs';
import { createMaintenanceRequestSession } from '../src/maintenance/request-session.mjs';
import { parseArgs, runCycle, runStep, runWorker } from '../src/runtime/worker/worker.mjs';
import { readSharedLarkCooldown, tryAcquireLarkApiLease, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

// All source events, responses and image bytes are authored. The resource lane
// runs the actual guarded maintenance CLI and enrichResources; only the remote
// service and the independent sampling workload are synthetic.
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
  const sent = kind === 'recipient', app = kind === 'app';
  const sender = { id: sent ? SELF.open_id : app ? `cli_synthetic_resource_${label}` : AUTHOR,
    id_type: app ? 'app_id' : 'open_id', sender_type: app ? 'app' : 'user', ...(app ? {} : { name: sent ? SELF.name : AUTHOR_NAME }) };
  return { label, kind, sourceAtMs: atMs, availableAtMs: atMs,
    message: { message_id: `om_${label}`, chat_id: sent ? `oc_synthetic_resource_${label}` : GROUP,
      chat_type: sent ? 'p2p' : 'group', msg_type: kind === 'image' ? 'image' : 'text',
      create_time: String(atMs), update_time: String(atMs + 1), sender,
      body: { content: JSON.stringify(kind === 'image' ? { image_key: `img_synthetic_${label}` } : { text: `Synthetic ${label} body; spacing  stays.` }) } } };
}
function publishTraffic(dir, cycle) {
  const manifest = read(join(dir, 'publisher.json')), atMs = now(dir);
  const fresh = entry(`r${String(cycle).padStart(4, '0')}`, atMs, 'recipient');
  manifest.entries.push(fresh); writeFileSync(join(dir, 'publisher.json'), JSON.stringify(manifest));
  log(dir, { type: 'source_publication', labels: [fresh.label], sourceAtMs: atMs, availableAtMs: atMs });
}
function sessionDeps(dir, { closedPending = false } = {}) {
  const directory = join(dir, 'api-state'); let virtual = 0;
  const light = read(join(dir, 'publisher.json')).light;
  const monotonicClock = () => performance.now() + virtual;
  return { monotonicClock, sleep: ms => {
    if (light) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    else virtual += ms;
  },
    tryAcquireLease: options => {
      const journal = closedPending ? events(dir) : [];
      const started = journal.findLastIndex(x => x.type === 'cli_start' && x.pid === process.pid);
      const acquired = journal.slice(started + 1).filter(x => x.type === 'api' && x.command === 'maintenance:resources');
      if (closedPending && acquired.map(x => x.route).join(',') === 'self,download,self'
          && acquired[1].id !== 'om_deny0' && !existsSync(join(dir, 'closed-pending-once'))) {
        writeFileSync(join(dir, 'closed-pending-once'), 'synthetic contention after original closing');
        log(dir, { type: 'closed_pending_contention' }); return { state: 'busy', release() {} };
      }
      return tryAcquireLarkApiLease(options, { directory, monotonicClock });
    },
    readSharedCooldown: options => readSharedLarkCooldown(options, { directory }),
    writeSharedCooldown: options => writeSharedLarkCooldown(options, { directory }),
  };
}
function observe(dir, context) {
  const db = join(dir, 'synthetic.sqlite'), before = sqliteQuery(db, 'SELECT * FROM records ORDER BY id;');
  // Producers and observations share the fixture's wall clock. The stress case
  // advances idle sleeps virtually; real Date.now() would reject later valid
  // recipient evidence as future-dated. Freeze only the reader's validation
  // clock, not the parent monotonic source/completion measurements.
  const observationClock = join(dir, 'messages-observation-clock.mjs');
  writeFileSync(observationClock, `Date.now = () => ${now(dir)};\n`);
  const invoke = format => {
    const child = spawnSync(process.execPath, ['--import', join(dir, 'deny-network.mjs'), '--import', observationClock, join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', db, '--limit', '100', '--format', format], { cwd: dir, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, LARK_CLI: join(dir, 'reject-lark'), NO_COLOR: '1', TZ: 'UTC' } });
    assert.equal(child.status, 0, child.stderr || child.stdout); assert.equal(child.stderr, '');
    return { text: child.stdout, atMs: now(dir) };
  };
  const json = invoke('json'), rows = JSON.parse(json.text), terminal = invoke('text');
  const sorted = [...before].sort((a, b) => b.occurred_at_ms - a.occurred_at_ms || b.external_id.localeCompare(a.external_id));
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
    if (source.kind === 'app') { assert.notEqual(row.readiness.state, 'ready'); assert(row.readiness.reasons.includes('sender_name_missing')); }
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
function fixture(t, light = false) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-resource-worker-synthetic-')), db = join(dir, 'synthetic.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = Date.now(); writeFileSync(join(dir, 'clock.json'), JSON.stringify({ epochMs: base, anchorNs: String(process.hrtime.bigint()) }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  const initial = light ? [entry('light', base - 30000)] : [
    ...Array.from({ length: 4 }, (_, i) => entry(`a${String(i).padStart(4, '0')}`, base - 180000 + i, 'app')),
    entry('img00', base - 1000), entry('deny0', base - 999), entry('img01', base - 998), entry('r0000', base - 997, 'recipient')];
  writeFileSync(join(dir, 'publisher.json'), JSON.stringify({ light, entries: initial }));
  writeFileSync(join(dir, 'fake-lark'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(HERE)} --remote "$@"\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'reject-lark'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
  writeFileSync(join(dir, 'deny-network.mjs'), "import{Socket}from'node:net';const deny=()=>{throw new Error('synthetic read forbids network')};globalThis.fetch=deny;Socket.prototype.connect=deny;Object.defineProperty(process.stdout,'columns',{value:160});\n");
  ensureInitialized(db); ensureSourceInitialSyncStart(db, 'lark.im', base - 600000, { explicit: true, endMs: base });
  sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(chatScopeId(GROUP))},'lark.im','Synthetic group',${quoteSql(JSON.stringify({ chat_id: GROUP, chat_type: 'group', chat_name: TITLE }))});`);
  assert.equal(sqliteQuery(db, 'SELECT COUNT(*) n FROM records;')[0].n, 0);
  return { dir, db, base, initial };
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
  else if (args[2] === '/open-apis/im/v1/messages/search') { const selected = available.filter(x => x.kind === 'recipient'); call({ route: 'sent', ids: selected.map(x => x.message.message_id) }); respond({ code: 0, data: { items: selected.map(x => ({ meta_data: { message_id: x.message.message_id } })), has_more: false } }); }
  else if (args[2] === '/open-apis/im/v1/messages') {
    const p = param('--params'), selected = available.filter(x => x.message.chat_id === p.container_id && Number(x.message.create_time) >= Number(p.start_time) * 1000 && Number(x.message.create_time) <= Number(p.end_time) * 1000);
    call({ route: 'list', ids: selected.map(x => x.message.message_id) }); respond({ code: 0, data: { items: selected.map(x => x.message), has_more: false } });
  } else if (args[2]?.includes('/resources/')) {
    const [id, key] = args[2].split('/messages/')[1].split('/resources/');
    const source = available.find(x => x.message.message_id === id); assert(source?.kind === 'image'); assert.equal(key, `img_synthetic_${source.label}`);
    call({ route: 'download', id });
    if (source.label === 'deny0') { respond({ code: 210508, msg: 'permission denied: synthetic resource' }); process.exitCode = 1; }
    else { const path = args[args.indexOf('--output') + 1]; assert(/^resource-\d+\.bin$/.test(path)); writeFileSync(path, png(), { mode: 0o600, flag: 'wx' }); respond({ saved_path: path, size_bytes: png().length, content_type: 'image/png' }); }
  } else if (args[2] === '/open-apis/im/v1/messages/mget' || args[2]?.startsWith('/open-apis/im/v1/messages/')) {
    const ids = args[2].endsWith('/mget') ? param('--params').message_ids : [decodeURIComponent(args[2].split('/').at(-1))];
    const selected = available.filter(x => ids.includes(x.message.message_id)); assert.equal(selected.length, ids.length); call({ route: 'detail', ids }); respond({ code: 0, data: { items: selected.map(x => x.message) } });
  } else if (args[2] === '/open-apis/im/v1/chats/batch_query') {
    const ids = param('--data').chat_ids; call({ route: 'recipient', ids }); respond({ code: 0, data: { items: ids.map(chat_id => ({ chat_id, chat_mode: 'p2p', p2p_target_type: 'user', p2p_target_id: `ou_peer_${chat_id.split('_').at(-1)}` })) } });
  } else if (args[0] === 'contact' && args[1] === '+search-user') {
    const ids = args[args.indexOf('--user-ids') + 1].split(','); call({ route: 'contact', ids }); respond({ users: ids.map(open_id => ({ open_id, name: open_id === AUTHOR ? AUTHOR_NAME : `Synthetic Peer ${open_id.split('_').at(-1)}` })) });
  } else if (args.slice(0, 3).join(' ') === 'im chats get') {
    const chat_id = param('--params').chat_id; call({ route: 'chat', chat_id }); respond({ data: { chat_id, chat_mode: chat_id === GROUP ? 'group' : 'p2p', name: chat_id === GROUP ? TITLE : null } });
  } else if (args[2]?.startsWith('/open-apis/application/v6/applications/')) { call({ route: 'app', actor: args[2].split('/').at(-1) }); respond({ code: 210508, msg: 'permission denied: synthetic app' }); process.exitCode = 1; }
  else if (args[0] === 'im' && args[1] === 'chat.members') { call({ route: args[2] }); respond({ items: [], has_more: false }); }
  else { call({ route: 'unexpected', args: args.slice(0, 3) }); process.exitCode = 1; }
} else if (['sync', 'maintenance'].includes(process.argv[2])) {
  denyNetwork(); const dir = ownDir(), args = process.argv.slice(2), db = join(dir, 'synthetic.sqlite'), directory = join(dir, 'api-state');
  process.env.SYNTHETIC_RESOURCE_COMMAND = `${args[0]}:${args[1]}`;
  assert.equal(args[args.indexOf('--db') + 1], db);
  const state = createTransportState(), remote = createLarkCliRunner({ bin: join(dir, 'fake-lark'), state,
    readSharedCooldown: o => readSharedLarkCooldown(o, { directory }), writeSharedCooldown: o => writeSharedLarkCooldown(o, { directory }) });
  const adapter = createLarkImAdapter({ run: remote });
  log(dir, { type: 'cli_start', command: args[0], operation: args[1], args });
  const code = await runCli(args, { now: args[0] === 'sync' || args[1] === 'resources' ? () => now(dir) : Date.now, deps: {
    getSelfProfile: args[0] === 'sync' ? adapter.getSelfProfile : undefined,
    getTransportStats: () => getTransportStats(state), resetTransportStats: () => resetTransportStats(state),
    tryAcquireLarkApiLease: o => tryAcquireLarkApiLease(o, { directory }),
    // Queue metadata uses its real monotonic clock. Only the producer request
    // session elides gaps; crossing those clocks would fabricate lease expiry.
    tryAcquireLease: o => tryAcquireLarkApiLease(o, { directory, monotonicClock: () => performance.now() }),
    requestSessionDeps: sessionDeps(dir, { closedPending: args[1] === 'resources' && !read(join(dir, 'publisher.json')).light }),
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
  const light = read(join(dir, 'publisher.json')).light;
  const opts = parseArgs(['--max-cycles', light ? '1' : '4', '--db', db, '--log-dir', join(dir, 'logs'), ...(light ? ['--remote-sample-interval-seconds', '0'] : [])]);
  const helperDeps = deps => ({ ...deps, tryAcquireLease: (o, leaseDeps) => tryAcquireLarkApiLease(o, { ...leaseDeps, directory: join(dir, 'api-state') }) });
  const result = runWorker(opts, { nowMs: () => now(dir), monotonicNowMs: () => performance.now(),
    sleepSeconds: s => { advance(dir, s * 1000); }, writeScheduler() {},
    ...(light ? { hasHistoryWork: () => false } : {}),
    hasResourceWork: o => { const available = resourceWorkAvailable(o.db, { now: () => now(dir) }); log(dir, { type: 'resource_hint', available }); return available; },
    readIdleFairState: (path, deps) => { const state = readIdleFairState(path, helperDeps(deps)); log(dir, { type: 'fair_read', state }); return state; },
    claimIdleLane: (path, state, lane, eligible, deps) => {
      const next = claimIdleLane(path, state, lane, eligible, helperDeps(deps));
      log(dir, { type: 'lane_claim', lane, eligible, claimed: Boolean(next), sequence: next?.sequence }); return next;
    },
    runResources: (args, limits) => {
      const before = sqliteQuery(db, 'SELECT * FROM records ORDER BY id;');
      const step = runStep('resources', args, { command: 'maintenance', scriptPath: HERE, ...limits,
        nowMs: () => now(dir), monotonicNowMs: () => performance.now() });
      assert.deepEqual(sqliteQuery(db, 'SELECT * FROM records ORDER BY id;'), before,
        'resource work preserves every source column, including version, hash, raw, body, account evidence and clocks');
      log(dir, { type: 'resource_step', step }); observe(dir, 'after_resource'); return step;
    },
    // This counterpart uses the real request session and private executable,
    // consumes the full sample grant, and reports its measured attempts. It is
    // not a claim about the production remote sampling collector's coverage.
    remoteSampleAdmission: () => ({ outcome: 'due' }),
    runRemoteSample: (options) => {
      process.env.SYNTHETIC_RESOURCE_COMMAND = 'synthetic:sample';
      const session = createMaintenanceRequestSession({ db, maxCliAttempts: options.maxApiCalls,
        maxSelfAttempts: options.maxSelfCalls, maxSeconds: 25 }, sessionDeps(dir));
      for (let index = 0; index < options.maxApiCalls; index++) session.runLark(index < 2
        ? ['contact', '+get-user', '--as', 'user', '--format', 'json']
        : ['im', '+chat-list', '--format', 'json']);
      const receipt = session.summary(); log(dir, { type: 'sample_step', receipt });
      return { outcome: 'ok', cooldownsByOperation: {}, budget_receipt: { version: 1, complete: true,
        max_cli_attempts: options.maxApiCalls, max_self_attempts: options.maxSelfCalls,
        cli_attempts: receipt.cli_attempts, self_attempts: receipt.self_attempts } };
    },
    runCycle: (options, cycle, deps) => runCycle(options, cycle, { ...deps, runStep: { scriptPath: HERE }, writeLog: { stdout: { write() {} } },
      onComplete: (steps, payload) => { deps.onComplete?.(steps, payload); log(dir, { type: 'cycle', cycle, ok: payload.ok, steps }); observe(dir, 'cycle'); if (!light) publishTraffic(dir, events(dir).filter(x => x.type === 'cycle').length); } }),
  });
  process.stdout.write(JSON.stringify({ ok: result }));
} else {
  test('real worker acquires synthetic image resources while preserving denied messages and durable idle fairness across restart', t => {
    const { dir, db, initial } = fixture(t);
    // Four acquisition opportunities are necessary: two successful images,
    // one explicit denial and one synthetic post-closing contention. Three
    // continuously eligible lanes promise an opportunity within three slices.
    for (let restart = 0; restart < 3; restart++) {
      assert.equal(typeof worker(dir).ok, 'boolean');
    }
    const journal = events(dir); assert.deepEqual(journal.filter(x => x.type === 'api' && x.route === 'unexpected'), []);
    const resourceSteps = journal.filter(x => x.type === 'resource_step'); assert(resourceSteps.length >= 3, JSON.stringify({ resourceSteps,
      hints: journal.filter(x => ['resource_hint', 'fair_read', 'lane_claim'].includes(x.type)),
      cycles: journal.filter(x => x.type === 'cycle').map(x => ({ ok: x.ok, steps: x.steps.map(s => ({ name: s.name, ok: s.ok, summary: s.summary, stderr: s.stderr })) })) }));
    assert(resourceSteps.every(x => !x.step.guardian_diagnostic));
    assert(journal.some(x => x.type === 'cli_start' && x.operation === 'resources'), 'worker must execute the real resource CLI');
    assert(journal.some(x => x.type === 'sample_step')); assert(journal.some(x => x.type === 'cli_start' && x.operation === 'history'));
    const claims = journal.filter(x => x.type === 'lane_claim');
    assert(claims.every(x => x.claimed === true), 'this workload must retain and reject failed/unknown admissions, not filter them out');
    assert(new Set(claims.map(x => x.pid)).size >= 2, 'persistent fairness is exercised from two worker processes');
    assert(claims.every((x, i) => i === 0 || x.sequence > claims[i - 1].sequence));
    assert.deepEqual(claims.slice(0, 3).map(x => x.lane), ['sample', 'history', 'resources']);
    for (const lane of ['sample', 'history', 'resources']) {
      const eligible = claims.filter(x => x.eligible.includes(lane));
      for (let index = 0; index + 3 <= eligible.length; index++)
        assert(eligible.slice(index, index + 3).some(x => x.lane === lane), `${lane} gets first service within three eligible slices`);
      for (let index = 0; index + 3 <= claims.length; index++) {
        const window = claims.slice(index, index + 3);
        if (window.every(x => x.eligible.includes(lane)))
          assert(window.some(x => x.lane === lane), `${lane} gets first service within three consecutive continuously eligible slices`);
      }
    }
    for (const claim of claims) {
      const start = journal.indexOf(claim), end = journal.findIndex((x, i) => i > start && x.type === 'cycle');
      assert(end > start);
      const firstStarted = journal.slice(start + 1, end).find(x =>
        x.type === 'cli_start' && ['history', 'resources'].includes(x.operation)
        || x.type === 'api' && x.command === 'synthetic:sample');
      assert(firstStarted, 'a committed claim must have an observed first child in this accepted interval');
      assert.equal(firstStarted.type === 'api' ? 'sample' : firstStarted.operation, claim.lane,
        'the claimed lane must be the first actually started guarded CLI or sampling executable');
      const calls = journal.slice(start, end).filter(x => x.type === 'api');
      assert(calls.length <= 12, 'all optional lanes consume one shared twelve-call allowance');
      assert(calls.filter(x => x.route === 'self').length <= 6, 'all optional lanes share six self observations');
    }
    for (const started of journal.filter(x => x.type === 'cli_start' && x.operation === 'resources')) {
      const start = journal.indexOf(started), end = journal.findIndex((x, i) => i > start && x.type === 'cli_end' && x.pid === started.pid);
      assert(end > start);
      const measured = journal.slice(start, end).filter(x => x.type === 'api');
      const step = journal.slice(end).find(x => x.type === 'resource_step'); assert(step);
      assert.equal(step.step.summary.request_budget.complete, true);
      assert.equal(step.step.summary.request_budget.cli_attempts, measured.length);
      assert.equal(step.step.summary.request_budget.self_attempts, measured.filter(x => x.route === 'self').length);
    }
    const final = observe(dir, 'final');
    const jobs = sqliteQuery(db, 'SELECT state,reason,attempts FROM lark_im_resource_work ORDER BY record_id;');
    assert.equal(jobs.filter(job => job.state === 'available').length, 2);
    assert.equal(jobs.filter(job => job.state === 'blocked' && job.reason === 'permission_denied' && job.attempts === 1).length, 1,
      JSON.stringify({ jobs, resourceSteps }));
    assert(journal.some(x => x.type === 'api' && x.route === 'recipient'), 'continuous recipient traffic executes its real identity path');
    const images = final.filter(row => initial.some(x => x.kind === 'image' && x.message.message_id === row.external_id));
    assert.deepEqual(images.filter(row => row.readiness.state === 'ready').map(x => x.external_id).sort(), ['om_img00', 'om_img01']);
    assert.notEqual(images.find(row => row.external_id === 'om_deny0').readiness.state, 'ready');
    for (const id of ['om_img00', 'om_img01', 'om_deny0']) assert.equal(journal.filter(x => x.type === 'api' && x.route === 'download' && x.id === id).length, 1, `${id}: exact denial/closed pending/available never re-downloads`);
    assert(journal.some(x => x.type === 'closed_pending_contention'));
    const manifest = read(join(dir, 'publisher.json'));
    const recipients = manifest.entries.filter(source => source.kind === 'recipient');
    const storedRecipients = final.filter(row => recipients.some(source => source.message.message_id === row.external_id));
    assert.equal(storedRecipients.length, recipients.length - 1, 'only the last post-cycle source event remains uncollected');
    for (const row of storedRecipients) {
      assert.equal(row.readiness.state, 'ready', `${row.external_id}: stored recipient with available authoritative answers must be complete`);
      assert.deepEqual(row.readiness.reasons, []);
      assert.equal(row.display.recipient, `Synthetic Peer ${row.external_id.slice(3)}`);
    }
    // The last publication intentionally waits for the next forward cycle;
    // retain it in the source denominator as not-yet-collected, not success.
    const cohort = manifest.entries.map(source => {
      const observations = journal.filter(x => x.type === 'messages_observation');
      const ready = observations.find(x => x.rows.some(row => row.externalId === source.message.message_id && row.state === 'ready'));
      const collected = journal.find(x => x.type === 'collection_commit' && x.ids.includes(source.message.message_id));
      const prepared = journal.find(x => x.type === 'identity_prepared' && x.ids.includes(source.message.message_id));
      const download = journal.find(x => x.type === 'api' && x.route === 'download' && x.id === source.message.message_id);
      return { label: source.label, sourceAtMs: source.sourceAtMs, availableAtMs: source.availableAtMs,
        identityPreparedAtMs: prepared?.atMs ?? null, collectedAtMs: collected?.atMs ?? null, resourceRequestedAtMs: download?.atMs ?? null,
        completeAtMs: ready ? Math.max(ready.jsonAtMs, ready.textAtMs) : null,
        censored: !ready, observedAtMs: now(dir) };
    });
    assert(cohort.filter(x => x.label.startsWith('img')).every(x => x.collectedAtMs >= x.availableAtMs && x.completeAtMs >= x.collectedAtMs));
    assert(cohort.filter(x => x.label.startsWith('a') || x.label === 'deny0').every(x => x.censored));
    assert.equal(final.length, manifest.entries.length - 1);
    t.diagnostic(JSON.stringify({ workload: 'adversarial: every eligible sample exhausts all twelve CLI calls; continuous recipient traffic and old denied identities',
      clock: 'synthetic worker idle advances; reader Date.now fixed to each shared observation; actual monotonic I/O; inter-request waits elided but charged to each request-session deadline',
      sourceDenominator: cohort.length, storedDenominator: final.length,
      complete: cohort.filter(x => !x.censored).length, unresolved: cohort.filter(x => x.censored).length, cohort,
      limit: 'synthetic service opportunities; no production percentile or unconditional source-to-ready bound' }));
  });
  test('one light-load source image becomes readable in the first real worker resource opportunity', t => {
    const { dir, initial } = fixture(t, true), result = worker(dir), journal = events(dir), source = initial[0];
    assert.equal(result.ok, true);
    const steps = journal.filter(x => x.type === 'resource_step'); assert.equal(steps.length, 1);
    assert.equal(steps[0].step.summary.available, 1); assert.equal(steps[0].step.summary.request_budget.cli_attempts, 3);
    assert.equal(steps[0].step.summary.request_budget.self_attempts, 2);
    assert.equal(journal.filter(x => x.type === 'api' && x.route === 'download').length, 1);
    assert.equal(journal.filter(x => x.type === 'sample_step').length, 0);
    assert.equal(journal.filter(x => x.type === 'cli_start' && x.operation === 'history').length, 0);
    const rows = observe(dir, 'light_final'); assert.equal(rows.length, 1); assert.equal(rows[0].readiness.state, 'ready');
    const collect = journal.find(x => x.type === 'collection_commit' && x.ids.includes(source.message.message_id));
    const prepared = journal.find(x => x.type === 'identity_prepared' && x.ids.includes(source.message.message_id));
    const download = journal.find(x => x.type === 'api' && x.route === 'download');
    const ready = journal.find(x => x.type === 'messages_observation' && x.rows[0]?.state === 'ready');
    assert(collect && prepared && download && ready);
    const completeAtMs = Math.max(ready.jsonAtMs, ready.textAtMs);
    const started = journal.find(x => x.type === 'worker_started'); assert(started);
    assert(prepared.atMs >= source.availableAtMs && collect.atMs >= prepared.atMs && download.atMs >= collect.atMs && completeAtMs >= download.atMs);
    t.diagnostic(JSON.stringify({ workload: 'one authored image; no history or sampling eligibility; source published thirty seconds before worker startup',
      sourceDenominator: 1, storedDenominator: 1, complete: 1, unresolved: 0, sourceAtMs: source.sourceAtMs,
      availableAtMs: source.availableAtMs, identityPreparedAtMs: prepared.atMs, collectedAtMs: collect.atMs,
      resourceRequestedAtMs: download.atMs, completeAtMs, sourceToObservedReadyMs: completeAtMs - source.sourceAtMs,
      workerStartedAtMs: started.atMs, workerStartToObservedReadyMs: completeAtMs - started.atMs,
      clock: 'actual monotonic I/O and actual inter-request pauses; no worker sleep before first opportunity',
      limit: 'one synthetic first-opportunity observation, not a production percentile or agreed SLO' }));
  });
  test('an actual worker resource denial is permanently isolated only after its account bracket closes', t => {
    const { dir, db, base } = fixture(t, true);
    writeFileSync(join(dir, 'publisher.json'), JSON.stringify({ light: true, entries: [entry('deny0', base - 30000)] }));
    worker(dir);
    const journal = events(dir), jobs = sqliteQuery(db, 'SELECT state,reason,attempts FROM lark_im_resource_work;');
    const steps = journal.filter(x => x.type === 'resource_step');
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], { state: 'blocked', reason: 'permission_denied', attempts: 1 }, JSON.stringify({ jobs, steps }));
    assert.equal(steps.length, 1);
    assert.equal(steps[0].step.summary.request_budget.cli_attempts, 3);
    assert.equal(steps[0].step.summary.request_budget.self_attempts, 2);
    assert.equal(observe(dir, 'denied_final')[0].readiness.state, 'blocked');
  });
}
