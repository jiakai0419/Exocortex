import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, fstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runCli } from '../bin/exocortex.mjs';
import { commitBoundedReplayRecords, commitLarkListRun, ensureInitialized, ensureSourceInitialSyncStart, quoteSql, sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { createLarkCliRunner, createTransportState, getTransportStats, resetTransportStats } from '../src/adapters/lark-im/transport.mjs';
import { readRemoteAccountBinding } from '../src/diagnostics/remote-account-binding.mjs';
import { readMessageSnapshot } from '../src/diagnostics/message-read-snapshot.mjs';
import { summarizeMessageCompleteness } from '../src/diagnostics/message-completeness-summary.mjs';
import { parseArgs, runCycle, runWorker } from '../src/runtime/worker/worker.mjs';
import { getLarkApiLeaseStdio, readSharedLarkCooldown, tryAcquireLarkApiLease, writeSharedLarkCooldown } from '../src/runtime/lark-api-lease.mjs';

const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const SELF = { open_id: 'ou_synthetic_worker_owner', name: 'Synthetic Worker Owner' };
const HOT = 'ou_synthetic_worker_hot', COLD = 'ou_synthetic_worker_cold';
const CHAT = 'oc_synthetic_worker_group', TITLE = 'Synthetic Worker Group';
const HOT_NAME = 'Synthetic Hot Author', COLD_NAME = 'Synthetic Cold Author';
const accountKey = createHash('sha256').update(`lark.im\0${SELF.open_id}`).digest('hex');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function dirFromEnv() {
  const dir = process.env.SYNTHETIC_WORKER_ROOT;
  assert(dir?.startsWith(tmpdir()) && dir.includes('/exocortex-name-worker-synthetic-'));
  return dir;
}
function noNetwork() {
  const deny = () => { throw new Error('synthetic worker acceptance forbids network'); };
  globalThis.fetch = deny; Socket.prototype.connect = deny;
}
function epoch(dir) {
  const clock = readJson(join(dir, 'clock.json'));
  return clock.epochMs + Number((process.hrtime.bigint() - BigInt(clock.anchorNs)) / 1_000_000n);
}
function advance(dir, ms) {
  writeFileSync(join(dir, 'clock.json'), JSON.stringify({ epochMs: epoch(dir) + Math.round(ms), anchorNs: String(process.hrtime.bigint()) }));
}
function journal(dir, value) { appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ atMs: epoch(dir), ...value }) + '\n'); }
function events(dir) { return readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function message(label, actor, type, atMs) {
  // Distinct eight-character keys remain distinguishable in the actual
  // terminal's intentionally abbreviated message-id field.
  const id = { hot: 'om_hot00', cold: 'om_cold0', donor: 'om_donr0' }[label]
    || `om_o${label.slice(4).padStart(4, '0')}`;
  return { message_id: id, chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(atMs), update_time: String(atMs + 1),
    sender: { id: actor, id_type: type, sender_type: type === 'app_id' ? 'app' : 'user' },
    body: { content: JSON.stringify({ text: `Synthetic worker body ${label}; spacing  stays.` }) } };
}
function publishFresh(dir) {
  const manifest = readJson(join(dir, 'publisher.json')), atMs = epoch(dir);
  assert.equal(manifest.phase, 1);
  const fresh = [['hot', HOT, HOT_NAME], ['cold', COLD, COLD_NAME]].map(([label, actor, name]) => ({
    label, sourceAtMs: atMs, availableAtMs: atMs, name, message: message(label, actor, 'open_id', atMs),
  }));
  manifest.phase = 2; manifest.fresh = fresh; manifest.entries.push(...fresh);
  writeFileSync(join(dir, 'publisher.json'), JSON.stringify(manifest));
  journal(dir, { type: 'source_publication', sourceAtMs: atMs, availableAtMs: atMs, labels: fresh.map(x => x.label) });
}
function actualMessages(dir, context) {
  const db = join(dir, 'synthetic.sqlite'), snapshot = readMessageSnapshot(db, { direction: 'all', limit: 100, search: '' });
  const before = snapshot.rows, storedBefore = sqliteQuery(db, 'SELECT * FROM records ORDER BY id;');
  const started = performance.now();
  const invoke = format => {
    const response = spawnSync(process.execPath, ['--import', join(dir, 'deny-network.mjs'), join(ROOT, 'bin/exocortex.mjs'),
      'messages', '--db', db, '--limit', '100', '--format', format], {
      cwd: dir, encoding: 'utf8', timeout: 15_000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, LARK_CLI: join(dir, 'reject-lark'), NO_COLOR: '1' },
    });
    assert.equal(response.status, 0, response.stderr || response.stdout);
    assert.equal(response.stderr, '');
    return { value: response.stdout, atMs: epoch(dir) };
  };
  const json = invoke('json'), rows = JSON.parse(json.value), text = invoke('text');
  assert.deepEqual(rows.map(x => x.external_id), before.map(x => x.external_id), 'latest N never drops unresolved rows');
  const textIds = [...text.value.matchAll(/om_(?:o\d{4}|donr0|hot00|cold0)\b/g)];
  assert.deepEqual(textIds.map(match => match[0]), before.map(x => x.external_id), 'text preserves the same latest N order');
  const textLinesFor = id => {
    const index = textIds.findIndex(match => match[0] === id);
    assert(index >= 0);
    return text.value.slice(textIds[index].index, textIds[index + 1]?.index).split('\n');
  };
  const manifest = readJson(join(dir, 'publisher.json'));
  const assertReady = row => {
    assert.equal(row.readiness.version, 1);
    assert.equal(row.readiness.state, 'ready', JSON.stringify(row.readiness));
    assert.deepEqual(row.readiness.requirements.map(x => [x.field, x.state]), [
      ['sender', 'satisfied'], ['recipient', 'not_applicable'], ['conversation', 'satisfied'], ['content', 'satisfied'],
    ]);
    assert.deepEqual(row.readiness.reasons, []); assert.equal(row.readiness.next_action, 'none');
  };
  const donor = rows.find(row => row.external_id === 'om_donr0');
  if (donor) {
    const expected = manifest.entries.find(entry => entry.label === 'donor');
    assert.equal(donor.display.sender, HOT_NAME, 'the donor is verified rather than merely counted as complete');
    assert.equal(donor.actor_id, HOT); assert.equal(donor.canonical.sender_id_type, 'open_id');
    assert.deepEqual(donor.raw.raw_api || donor.raw, expected.message);
    assert.equal(donor.display.body, JSON.parse(expected.message.body.content).text);
    assert.equal(donor.display.chat, TITLE); assert.equal(donor.display.recipient, null);
    assert.equal(donor.container_id, CHAT); assert.equal(donor.direction, 'received');
    assert.equal(donor.occurred_at_ms, expected.sourceAtMs);
    assertReady(donor);
    const donorLines = textLinesFor(donor.external_id);
    assert(donorLines.includes(`  发送人  ${HOT_NAME}`));
    assert(donorLines.includes(`  群      ${TITLE}`));
    assert(donorLines.includes('  消息    Synthetic worker body donor; spacing stays.'));
  }
  for (const old of rows.filter(row => /^cli_synthetic_worker_old_\d+$/.test(row.actor_id))) {
    const expected = manifest.entries.find(entry => entry.message.message_id === old.external_id);
    assert.equal(old.canonical.sender_name ?? null, null);
    assert(!old.display.sender.includes(HOT_NAME) && !old.display.sender.includes(COLD_NAME));
    assert.deepEqual(old.raw.raw_api || old.raw, expected.message);
    assert.equal(old.display.body, JSON.parse(expected.message.body.content).text);
    assert.equal(old.occurred_at_ms, expected.sourceAtMs);
    assert.equal(old.readiness.state, 'enriching', JSON.stringify(old.readiness));
    assert.deepEqual(old.readiness.reasons, ['sender_name_missing']);
    assert.deepEqual(old.readiness.requirements.map(x => [x.field, x.state]), [
      ['sender', 'missing'], ['recipient', 'not_applicable'], ['conversation', 'satisfied'], ['content', 'satisfied'],
    ]);
    const lines = textLinesFor(old.external_id);
    assert(lines.includes('  状态    等待完整信息'));
    assert(lines.some(line => line.startsWith('  原因    ')));
    assert(lines.includes('  查看    messages --format json 可检查已保存内容与原因'));
    assert(!lines.some(line => /^  (发送人|群|消息)\s/.test(line)), 'an unresolved app is an explicit exception, not a normal complete block');
  }
  const observations = manifest.fresh.map(expected => {
    const row = rows.find(x => x.external_id === expected.message.message_id);
    if (!row) return { label: expected.label, present: false };
    const native = row.raw.raw_api || row.raw;
    assert.equal(row.actor_id, expected.message.sender.id);
    assert.equal(row.canonical.sender_id_type, 'open_id'); assert.equal(native.sender.id_type, 'open_id');
    assert.equal(row.canonical.sender_name_account_key, accountKey);
    assert.equal(row.container_id, CHAT); assert.equal(row.direction, 'received');
    assert.equal(row.occurred_at_ms, expected.sourceAtMs);
    assert.equal(before.find(x => x.external_id === row.external_id).external_version, expected.message.update_time);
    assert.deepEqual(native, expected.message, 'source body, identity and clocks remain unchanged');
    const expectedBody = JSON.parse(expected.message.body.content).text;
    assert.equal(row.display.body, expectedBody); assert.equal(row.display.chat, TITLE);
    assert.equal(row.display.recipient, null, 'a group has no invented personal recipient');
    assertReady(row);
    const fullJson = row.readiness.state === 'ready' && row.display.sender === expected.name;
    const textLines = textLinesFor(row.external_id);
    const terminalBody = `Synthetic worker body ${expected.label}; spacing stays.`;
    const fullText = textLines.includes(`  消息    ${terminalBody}`) && textLines.includes(`  发送人  ${expected.name}`)
      && textLines.includes(`  群      ${TITLE}`) && !textLines.some(line => line.startsWith('  接收人'));
    return { label: expected.label, present: true, readinessState: row.readiness.state, fullJson, fullText,
      sourceAtMs: expected.sourceAtMs, availableAtMs: expected.availableAtMs,
      jsonAtMs: json.atMs, textAtMs: text.atMs };
  });
  const completeness = summarizeMessageCompleteness(rows, { ...snapshot, filter: { direction: 'all', search: '' } });
  assert.equal(completeness.evaluation.metadata_valid, true);
  assert.equal(completeness.population.evaluated, rows.length);
  assert.equal(Object.values(completeness.counts).reduce((sum, n) => sum + n, 0), rows.length);
  const populationObservations = manifest.entries.map(expected => {
    const row = rows.find(x => x.external_id === expected.message.message_id);
    return { label: expected.label, sourceAtMs: expected.sourceAtMs, availableAtMs: expected.availableAtMs,
      present: Boolean(row), readinessState: row?.readiness.state ?? null,
      observedAtMs: Math.max(json.atMs, text.atMs),
      complete: row?.readiness.state === 'ready' && textLinesFor(row.external_id).some(line => line.startsWith('  消息    ')) };
  });
  assert.deepEqual(sqliteQuery(db, 'SELECT * FROM records ORDER BY id;'), storedBefore, 'actual JSON/text observation is read-only');
  journal(dir, { type: 'messages_observation', context, count: rows.length, observations,
    populationObservations, completeness, elapsedMs: performance.now() - started });
  return observations;
}

if (process.argv[2] === '--synthetic-remote') {
  noNetwork();
  const dir = dirFromEnv(), args = process.argv.slice(3), manifest = readJson(join(dir, 'publisher.json'));
  const held = fstatSync(3), lock = statSync(join(dir, 'api-state', 'api.lock'));
  assert.equal(held.dev, lock.dev); assert.equal(held.ino, lock.ino);
  const params = () => JSON.parse(args[args.indexOf('--params') + 1]);
  const respond = value => process.stdout.write(JSON.stringify(value));
  const record = value => journal(dir, { type: 'api', phase: manifest.phase, inheritedLease: true, ...value });
  const available = manifest.entries.filter(x => x.availableAtMs <= epoch(dir));
  if (args[0] === 'contact' && args[1] === '+get-user') { record({ route: 'self' }); respond(SELF); }
  else if (args[0] === 'im' && args[1] === '+chat-list') {
    record({ route: 'discovery' }); respond({ chats: [{ chat_id: CHAT, chat_mode: 'group', name: TITLE }], has_more: false });
  } else if (args[0] === 'api' && args[1] === 'POST' && args[2] === '/open-apis/im/v1/messages/search') {
    record({ route: 'sent' }); respond({ code: 0, data: { items: [], has_more: false } });
  } else if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/im/v1/messages') {
    const p = params(); assert.equal(p.container_id, CHAT);
    const selected = available.filter(x => Number(x.message.create_time) >= Number(p.start_time) * 1000
      && Number(x.message.create_time) <= Number(p.end_time) * 1000);
    record({ route: 'messages', messageIds: selected.map(x => x.message.message_id) });
    respond({ code: 0, data: { items: selected.map(x => x.message), has_more: false } });
  } else if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/im/v1/messages/mget') {
    const ids = params().message_ids, selected = available.filter(x => ids.includes(x.message.message_id));
    assert.equal(selected.length, ids.length); record({ route: 'mget', count: ids.length });
    respond({ code: 0, data: { items: selected.map(x => x.message), has_more: false } });
  } else if (args[0] === 'api' && args[1] === 'GET' && args[2].startsWith('/open-apis/im/v1/messages/')) {
    const id = decodeURIComponent(args[2].split('/').at(-1)), selected = available.filter(x => x.message.message_id === id);
    assert.equal(selected.length, 1); record({ route: 'detail', messageIds: [id] });
    respond({ code: 0, data: { items: selected.map(x => x.message), has_more: false } });
  } else if (args[0] === 'contact' && args[1] === '+search-user') {
    const actors = args[args.indexOf('--user-ids') + 1].split(',');
    assert(actors.every(x => [HOT, COLD].includes(x))); record({ route: 'contact', actors });
    respond({ users: actors.map(open_id => ({ open_id, name: open_id === HOT ? HOT_NAME : COLD_NAME })) });
  } else if (args[0] === 'im' && args[1] === 'chats' && args[2] === 'get') {
    assert.equal(params().chat_id, CHAT); record({ route: 'chat' });
    respond({ data: { chat_id: CHAT, chat_mode: 'group', name: TITLE } });
  } else if (args[0] === 'api' && args[1] === 'GET' && args[2].startsWith('/open-apis/application/v6/applications/')) {
    const actor = args[2].split('/').at(-1); assert(/^cli_synthetic_worker_old_\d+$/.test(actor));
    record({ route: 'application', actor, code: 210508 });
    process.stderr.write(JSON.stringify({ error: { code: 210508, message: 'Synthetic denied application' } })); process.exitCode = 1;
  } else if (args[0] === 'im' && args[1] === 'chat.members' && args[2] === 'bots') {
    assert.equal(params().chat_id, CHAT); record({ route: 'bots' }); respond({ items: [], has_more: false });
  } else if (args[0] === 'im' && args[1] === 'chat.members' && args[2] === 'get') {
    assert.equal(params().chat_id, CHAT); record({ route: 'members' });
    respond({ items: [{ member_id: HOT, member_id_type: 'open_id', name: HOT_NAME },
      { member_id: COLD, member_id_type: 'open_id', name: COLD_NAME }], has_more: false });
  } else { record({ route: 'unexpected', command: args.slice(0, 3) }); process.exitCode = 1; }
} else if (['sync', 'maintenance'].includes(process.argv[2])) {
  noNetwork();
  const dir = dirFromEnv(), db = join(dir, 'synthetic.sqlite'), directory = join(dir, 'api-state');
  const state = createTransportState(), remote = createLarkCliRunner({ bin: join(dir, 'fake-lark'), state,
    readSharedCooldown: options => readSharedLarkCooldown(options, { directory }),
    writeSharedCooldown: options => writeSharedLarkCooldown(options, { directory }),
  });
  const adapter = createLarkImAdapter({ run: remote });
  const args = process.argv.slice(2); assert.equal(args[args.indexOf('--db') + 1], db);
  let virtualElapsed = 0;
  const monotonicClock = () => performance.now() + virtualElapsed;
  // History's SQL review fence uses SQLite wall time. Do not fabricate a
  // future review ticket when the test advances only the worker idle clock.
  process.exitCode = await runCli(args, { now: args[0] === 'sync' ? () => epoch(dir) : Date.now, deps: {
    getSelfProfile: args[0] === 'sync' ? adapter.getSelfProfile : undefined,
    getTransportStats: () => getTransportStats(state), resetTransportStats: () => resetTransportStats(state),
    commit(...parameters) {
      try { return commitBoundedReplayRecords(...parameters); }
      catch (error) { journal(dir, { type: 'history_commit_error', message: error.message }); throw error; }
    },
    tryAcquireLarkApiLease: options => {
      const lease = tryAcquireLarkApiLease(options, { directory });
      if (lease.state === 'acquired') {
        const contender = tryAcquireLarkApiLease({ role: 'probe', db }, { directory });
        assert.equal(contender.state, 'busy'); contender.release();
      }
      return lease;
    },
    syncRunnerDeps: { ...adapter, nowIso: () => new Date(epoch(dir)).toISOString(),
      commitLarkListRun(...parameters) {
        actualMessages(dir, 'before_commit');
        const manifest = readJson(join(dir, 'publisher.json'));
        for (const record of parameters[3]) {
          const expected = manifest.fresh.find(x => x.message.message_id === record.external_id);
          if (!expected) continue;
          const canonical = JSON.parse(record.canonical_json);
          assert.equal(record.actor_id, expected.message.sender.id);
          assert.equal(record.external_version, expected.message.update_time);
          assert.equal(canonical.sender_name, expected.name, 'normal fresh identity is prepared before publication');
          journal(dir, { type: 'identity_prepared', messageId: record.external_id });
        }
        const started = performance.now(), outcome = commitLarkListRun(...parameters);
        journal(dir, { type: 'content_commit', messageIds: parameters[3].map(x => x.external_id), elapsedMs: performance.now() - started });
        actualMessages(dir, 'after_commit');
        return outcome;
      },
      syncNames(path, profile) {
        assert.equal(path, db); assert(getLarkApiLeaseStdio());
        const started = performance.now(), report = syncNames(path, profile, { runLark: remote, now: () => epoch(dir) });
        journal(dir, { type: 'name_tail', report, elapsedMs: performance.now() - started });
        assert(report.calls <= 4);
        return report;
      },
    },
    requestSessionDeps: { monotonicClock, sleep: ms => { virtualElapsed += ms; },
      tryAcquireLease: options => tryAcquireLarkApiLease(options, { directory, monotonicClock }),
      readSharedCooldown: options => readSharedLarkCooldown(options, { directory }),
      writeSharedCooldown: options => writeSharedLarkCooldown(options, { directory }),
    },
  } });
} else if (process.argv[2] === '--synthetic-worker') {
  noNetwork();
  const dir = dirFromEnv(), opts = parseArgs(['--max-cycles', '2', '--db', join(dir, 'synthetic.sqlite'),
    '--log-dir', join(dir, 'logs'), '--remote-sample-interval-seconds', '0']);
  assert.equal(opts.intervalSeconds, 60);
  const ok = runWorker(opts, { nowMs: () => epoch(dir), monotonicNowMs: () => performance.now(),
    sleepSeconds: seconds => { journal(dir, { type: 'worker_idle', seconds }); advance(dir, seconds * 1000); },
    runCycle: (options, cycle, deps) => runCycle(options, cycle, { ...deps,
      runStep: { scriptPath: HERE }, writeLog: { stdout: { write() {} } },
      onComplete: (steps, payload) => {
        deps.onComplete?.(steps, payload);
        journal(dir, { type: 'worker_cycle', cycle, ok: payload.ok, steps: steps.map(x => ({ name: x.name, ok: x.ok, stderr: x.stderr, summary: x.summary })) });
        actualMessages(dir, `cycle_${cycle}`);
        if (cycle === 1) publishFresh(dir);
      },
    }),
  });
  process.stdout.write(JSON.stringify({ ok }));
} else {
  test('real worker publishes hot local and cold fresh messages accurately despite twelve old denied identities', t => {
    const dir = mkdtempSync(join(tmpdir(), 'exocortex-name-worker-synthetic-')), db = join(dir, 'synthetic.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const base = Date.now();
    writeFileSync(join(dir, 'clock.json'), JSON.stringify({ epochMs: base, anchorNs: String(process.hrtime.bigint()) }));
    writeFileSync(join(dir, 'events.jsonl'), '');
    const entries = Array.from({ length: 12 }, (_, index) => ({ label: `old_${index}`, sourceAtMs: base - 180_000 + index,
      availableAtMs: base - 180_000 + index, message: message(`old_${index}`, `cli_synthetic_worker_old_${index}`, 'app_id', base - 180_000 + index) }));
    entries.push({ label: 'donor', sourceAtMs: base - 120_000, availableAtMs: base - 120_000,
      message: message('donor', HOT, 'open_id', base - 120_000) });
    writeFileSync(join(dir, 'publisher.json'), JSON.stringify({ phase: 1, entries, fresh: [] }));
    writeFileSync(join(dir, 'fake-lark'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(HERE)} --synthetic-remote "$@"\n`, { mode: 0o700 });
    writeFileSync(join(dir, 'reject-lark'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
    writeFileSync(join(dir, 'deny-network.mjs'), "import {Socket} from 'node:net'; const deny=()=>{throw new Error('synthetic message read attempted network')}; globalThis.fetch=deny; Socket.prototype.connect=deny;\n");
    ensureInitialized(db); ensureSourceInitialSyncStart(db, 'lark.im', base - 600_000, { explicit: true, endMs: base });
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(chatScopeId(CHAT))},'lark.im',
      'Synthetic known group',${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group', chat_name: TITLE }))});`);
    assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM records;')[0].n, 0, 'no completed messages are prewritten');
    const worker = spawnSync(process.execPath, [HERE, '--synthetic-worker'], { cwd: dir, encoding: 'utf8',
      timeout: 120_000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, SYNTHETIC_WORKER_ROOT: dir, LARK_CLI: join(dir, 'fake-lark'), NO_COLOR: '1' } });
    assert.equal(worker.status, 0, worker.stderr || worker.stdout);
    assert.equal(worker.stderr, '');
    const log = events(dir);
    assert.deepEqual(log.filter(x => x.type === 'api' && x.route === 'unexpected'), []);
    assert.equal(JSON.parse(worker.stdout).ok, true, JSON.stringify(log.filter(x => x.type === 'history_commit_error' || x.type === 'worker_cycle' && !x.ok)));
    const cycles = log.filter(x => x.type === 'worker_cycle');
    assert.equal(cycles.length, 2);
    assert(cycles.every(x => x.steps.length === 7 && x.steps.every(step => step.ok)));
    assert.equal(readRemoteAccountBinding({ db, selfOpenId: SELF.open_id }).account_key, accountKey);
    const manifest = readJson(join(dir, 'publisher.json'));
    assert.equal(manifest.entries.length, 15, 'the full workload is retained');
    assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM records;')[0].n, manifest.entries.length);
    assert.equal(sqliteQuery(db, "SELECT COUNT(*) AS n FROM records WHERE actor_id LIKE 'cli_synthetic_worker_old_%' AND json_extract(canonical_json,'$.sender_name') IS NULL;")[0].n, 12);
    assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM sync_locks;')[0].n, 0);
    assert.equal(sqliteQuery(db, 'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n, 0);
    const calls = log.filter(x => x.type === 'api'); assert(calls.every(x => x.inheritedLease));
    assert.equal(calls.filter(x => x.phase === 2 && x.route === 'contact' && x.actors.includes(HOT)).length, 0);
    assert(calls.some(x => x.phase === 2 && x.route === 'contact' && x.actors.includes(COLD)));
    const tails = log.filter(x => x.type === 'name_tail'); assert(tails.every(x => x.report.calls <= 4));
    const freshDiscovery = calls.find(x => x.route === 'messages' && x.messageIds.includes('om_cold0'));
    const freshCommit = log.find(x => x.type === 'content_commit' && x.messageIds.includes('om_cold0'));
    assert(freshDiscovery && freshCommit);
    assert.deepEqual(calls.filter(x => x.atMs >= freshDiscovery.atMs && x.atMs <= freshCommit.atMs
      && ['contact', 'application', 'members', 'bots', 'chat'].includes(x.route))
      .map(x => ({ route: x.route, actors: x.actors })), [{ route: 'contact', actors: [COLD] }],
    'the fresh batch performs only one required cold lookup and no hot actor or known-title lookup');
    const outcomes = [];
    for (const expected of manifest.fresh) {
      const seen = log.filter(x => x.type === 'messages_observation').flatMap(x => x.observations
        .filter(o => o.label === expected.label).map(o => ({ ...o, sampleAtMs: x.atMs, readElapsedMs: x.elapsedMs })));
      const first = seen.find(x => x.present); assert(first, `${expected.label} must be observed`);
      assert.equal(first.readinessState, 'ready');
      assert(first.fullJson && first.fullText, `${expected.label} must be accurate on the first visible read: ${JSON.stringify(first)}`);
      const discovered = calls.find(x => x.route === 'messages' && x.messageIds.includes(expected.message.message_id));
      const prepared = log.find(x => x.type === 'identity_prepared' && x.messageId === expected.message.message_id);
      const committed = log.find(x => x.type === 'content_commit' && x.messageIds.includes(expected.message.message_id));
      assert(discovered && prepared && committed); assert(discovered.atMs >= expected.availableAtMs);
      const fullAtMs = Math.max(first.jsonAtMs, first.textAtMs);
      assert(fullAtMs >= committed.atMs && committed.atMs >= prepared.atMs && prepared.atMs >= discovered.atMs);
      const absent = seen.slice(0, seen.indexOf(first)).findLast(x => !x.present);
      assert(absent && absent.sampleAtMs <= committed.atMs, 'bound first visibility by the preceding absent CLI read');
      assert(fullAtMs - expected.sourceAtMs <= 120_000, 'proposed synthetic end-to-end upper bound');
      assert(fullAtMs - committed.atMs <= 2000, 'first actual JSON and text read follows commit within proposed two seconds');
      outcomes.push({ label: expected.label, upstreamMs: expected.availableAtMs - expected.sourceAtMs,
        collectionMs: discovered.atMs - expected.availableAtMs, preparationMs: prepared.atMs - discovered.atMs,
        commitMs: committed.atMs - prepared.atMs, readMs: fullAtMs - committed.atMs,
        endToEndMs: fullAtMs - expected.sourceAtMs,
        firstVisibilityIntervalMs: [absent.sampleAtMs - expected.sourceAtMs, fullAtMs - expected.sourceAtMs] });
    }
    const finalRead = log.findLast(x => x.type === 'messages_observation');
    assert.deepEqual(finalRead.completeness.population, { total: 15, evaluated: 15, not_evaluated: 0 });
    assert.deepEqual(finalRead.completeness.counts, { captured: 0, enriching: 12, ready: 3, blocked: 0 });
    assert.equal(finalRead.completeness.incomplete, 12);
    const cohort = manifest.entries.map(expected => {
      const samples = log.filter(x => x.type === 'messages_observation').flatMap(x => x.populationObservations)
        .filter(x => x.label === expected.label);
      const firstComplete = samples.find(x => x.complete), last = samples.at(-1);
      assert(last?.present, 'every source publication remains in the end-to-end denominator');
      return { label: expected.label, complete: Boolean(firstComplete), censored: !firstComplete,
        sourceToFirstCompleteUpperMs: firstComplete ? firstComplete.observedAtMs - expected.sourceAtMs : null,
        sourceToLastObservationMs: last.observedAtMs - expected.sourceAtMs,
        remainingLatencyUpperMs: null };
    });
    assert.equal(cohort.filter(x => x.complete).length, 3);
    assert.equal(cohort.filter(x => x.censored).length, 12);
    assert(cohort.filter(x => x.censored).every(x => x.sourceToFirstCompleteUpperMs === null && x.sourceToLastObservationMs >= 180_000));
    t.diagnostic(JSON.stringify({ profile: 'synthetic_epoch_with_real_monotonic_io', samples: outcomes, cohort,
      denominator: manifest.entries.length, completeFresh: 2, completeTotal: 3,
      unresolvedHistorical: 12, censoredTotal: 12, statisticalPercentiles: false }));
  });
}
