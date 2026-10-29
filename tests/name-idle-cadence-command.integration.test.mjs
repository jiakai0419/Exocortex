import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { sqliteExec, sqliteQuery } from '../dist/storage/sqlite/ingestion-store.js';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';
import { syncNames } from '../src/adapters/lark-im/name-sync.mjs';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { getLarkApiLeaseStdio, tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';
import { renderMessagesText } from '../src/terminal/messages-view.mjs';

const HERE = fileURLToPath(import.meta.url), ROOT = dirname(dirname(HERE));
const SELF = { open_id: 'ou_synthetic_idle_owner', name: 'Invented Cadence Owner' };
const PEER = { open_id: 'ou_synthetic_idle_peer', name: 'Invented Cadence Peer' };
const CHAT = 'oc_synthetic_idle_private', AT = Date.parse('2025-06-12T08:00:00Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const denyNetwork = () => { throw new Error('authored cadence fixture forbids external network'); };
globalThis.fetch = denyNetwork; Socket.prototype.connect = denyNetwork;
process.env.TZ = 'UTC';

// Each invocation starts a genuine public sync command in a fresh process.
// Only API answers and, for retry tests, the coordinator's wall clock are
// injected. Account admission, private flock, source normalization, SQLite,
// name selection/claims and the actual messages JSON/text reader are real.
if (process.argv[2] === '--synthetic-cycle') {
  const [directory, mode, clockText = ''] = process.argv.slice(3);
  assert(directory.startsWith(tmpdir()) && directory.includes('exo-idle-cadence-synthetic-'));
  const db = join(directory, 'synthetic.sqlite'), calls = [], tails = [];
  const scope = mode === 'discover' ? 'discover' : 'sent';
  const group = mode === 'sent-group-cas', chat = group ? `${CHAT}_group` : mode === 'sent-new' ? `${CHAT}_new` : CHAT;
  const message = { message_id: `om_synthetic_idle_${mode === 'sent-new' ? 'new' : 'first'}`,
    chat_id: chat, chat_type: group ? 'group' : 'p2p', msg_type: 'text', create_time: String(AT + (mode === 'sent-new' ? 601000 : 1000)),
    update_time: String(AT + (mode === 'sent-new' ? 601001 : 1001)),
    sender: { id: SELF.open_id, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: 'Invented cadence body; preserve  spacing.' }) } };
  let tail = false, contention = false, raceInjected = false;
  const response = items => ({ code: 0, data: { items, has_more: false } });
  const remote = (args, options = {}) => {
    assert(getLarkApiLeaseStdio(), 'real sync owns the API lease before all injected responses');
    if (tail) { assert.equal(options.retries, 0); assert(options.timeoutMs <= 5000); assert(options.retryBudgetMs <= 10000); }
    const record = route => calls.push({ route, tail });
    const data = () => JSON.parse(args[args.indexOf('--data') + 1]);
    const params = () => JSON.parse(args[args.indexOf('--params') + 1]);
    if (args[0] === 'contact' && args[1] === '+get-user') { record('self'); return SELF; }
    if (args[0] === 'im' && args[1] === '+chat-list') {
      record('discovery'); return { chats: [{ chat_id: CHAT, chat_type: 'p2p', name: 'Invented Private Conversation' }], has_more: false };
    }
    if (args[0] === 'api' && args[1] === 'POST' && args[2] === '/open-apis/im/v1/messages/search') {
      record('search'); assert.deepEqual(data().filter.from_ids, [SELF.open_id]);
      return response(mode === 'sent-empty' ? [] : [{ meta_data: { message_id: message.message_id } }]);
    }
    if (args[0] === 'api' && args[1] === 'GET' && args[2] === '/open-apis/im/v1/messages/mget') {
      record('mget'); assert.deepEqual(params().message_ids, [message.message_id]); return response([message]);
    }
    if (args[0] === 'api' && args[1] === 'POST' && args[2] === '/open-apis/im/v1/chats/batch_query') {
      record('relationship'); assert(data().chat_ids.every(id => [CHAT, `${CHAT}_new`].includes(id)));
      if (mode === 'sent-denied') throw new Error('lark-cli failed: kind=api code=99991672 operation=p2p_batch');
      return response(data().chat_ids.map(id => ({ chat_id: id, chat_mode: 'p2p', p2p_target_type: 'user', p2p_target_id: PEER.open_id })));
    }
    if (args[0] === 'contact' && args[1] === '+search-user') {
      record('contact'); assert.equal(args[args.indexOf('--user-ids') + 1], PEER.open_id);
      return { users: [PEER], has_more: false };
    }
    if (args[0] === 'im' && args[1] === 'chats' && args[2] === 'get') {
      record('chat'); assert.equal(params().chat_id, `${CHAT}_group`);
      return { data: { chat_id: `${CHAT}_group`, chat_mode: 'group', name: 'Invented Cadence Group' } };
    }
    assert.fail(`unexpected authored route ${args.slice(0, 3).join(' ')}`);
  };
  const adapter = createLarkImAdapter({ run: remote });
  const deps = { getSelfProfile: adapter.getSelfProfile,
    tryAcquireLarkApiLease: options => {
      const lease = tryAcquireLarkApiLease(options, { directory: join(directory, 'private-api-state') });
      if (lease.state === 'acquired') {
        const rival = tryAcquireLarkApiLease({ role: 'probe', db }, { directory: join(directory, 'private-api-state') });
        contention = rival.state === 'busy'; rival.release(); assert(contention);
      }
      return lease;
    },
    syncRunnerDeps: { ...adapter, syncNames: (path, self) => {
      tail = true;
      const report = syncNames(path, self, { runLark: remote,
        ...(clockText ? { now: () => Number(clockText) } : {}),
        readOnlyQuery: (path, sql, label, options) => {
          const rows = readOnlySqliteJson(path, sql, label, options);
          if (mode === 'sent-cas' && label === 'read exact recipient states') {
            assert(!raceInjected); raceInjected = true;
            sqliteExec(path, `UPDATE lark_im_name_scan SET generation=generation+1,
              schedule_sequence=schedule_sequence+1,next_attempt_at_ms=${Number(clockText) + 60000};`);
          }
          if (mode === 'sent-group-cas' && label === 'read exact name scope') {
            assert(!raceInjected); raceInjected = true;
            sqliteExec(path, "UPDATE lark_im_name_tasks SET generation=generation+1 WHERE kind='chat';");
          }
          return rows;
        },
      });
      tails.push(report); tail = false; return report;
    } },
  };
  let stdout = '', stderr = '';
  const code = await runCli(['sync', '--db', db, '--scope', scope, '--start', new Date(AT).toISOString(),
    '--end', new Date(AT + (mode === 'sent-new' ? 1200000 : 600000)).toISOString(), '--chat-types', group ? 'group' : 'p2p', '--retries', '1', '--format', 'json'], {
    root: ROOT, cwd: directory, env: {}, deps,
    stdout: { write: value => stdout += value }, stderr: { write: value => stderr += value },
  });
  assert.equal(getLarkApiLeaseStdio(), undefined, 'real command releases its lease');
  process.stdout.write(JSON.stringify({ code, stdout, stderr, calls, tails, contention, raceInjected, pid: process.pid }));
} else {
  function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'exo-idle-cadence-synthetic-')), db = join(directory, 'synthetic.sqlite');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const guard = join(directory, 'deny-network.mjs');
    writeFileSync(guard, "import {Socket} from 'node:net';const deny=()=>{throw Error('no external network')};globalThis.fetch=deny;Socket.prototype.connect=deny;\n");
    const query = sql => sqliteQuery(db, sql, 'inspect invented cadence fixture');
    function cycle(mode, now) {
      const result = spawnSync(process.execPath, [HERE, '--synthetic-cycle', directory, mode, now === undefined ? '' : String(now)], {
        cwd: directory, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LARK_CLI: '/usr/bin/false', TZ: 'UTC', NO_COLOR: '1' },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.stderr, '');
      const value = JSON.parse(result.stdout); assert.equal(value.code, 0, value.stderr || value.stdout);
      assert.equal(value.stderr, ''); assert.equal(JSON.parse(value.stdout).ok, true);
      assert(value.contention); assert.equal(value.tails.length, 1);
      assert(value.tails[0].calls <= 4); assert(value.calls.filter(call => call.tail).length <= 4);
      assert.equal(value.tails[0].calls, value.calls.filter(call => call.tail).length);
      return value;
    }
    function show() {
      const before = Object.fromEntries([db, `${db}-wal`].filter(existsSync).map(path => [path, hash(readFileSync(path))]));
      const read = format => {
        const result = spawnSync(process.execPath, ['--import', guard, join(ROOT, 'bin/exocortex.mjs'), 'messages',
          '--db', db, '--limit', '10', '--format', format], { cwd: directory, encoding: 'utf8', timeout: 10000,
          env: { ...process.env, LARK_CLI: '/usr/bin/false', TZ: 'UTC', NO_COLOR: '1' } });
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); return result.stdout;
      };
      const rows = JSON.parse(read('json')), text = read('text');
      assert.equal(text, renderMessagesText(rows, { columns: 100 }));
      for (const [path, value] of Object.entries(before)) assert.equal(hash(readFileSync(path)), value);
      return { rows, text };
    }
    return { directory, db, query, cycle, show, scan: () => query('SELECT * FROM lark_im_name_scan;')[0] };
  }

  test('real idle discovery then a new sent private message is ready on first JSON/text read across restart', t => {
    const f = fixture(t), discovered = f.cycle('discover'), idle = f.scan();
    assert.deepEqual(discovered.tails[0], { attempted: 0, updated: 0, calls: 0, reason: 'idle' });
    assert.equal(idle.next_attempt_at_ms, 0); assert.equal(idle.schedule_sequence, 0); assert.equal(idle.schedule_slot, 0);
    assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 0);
    const sent = f.cycle('sent'); assert.notEqual(sent.pid, discovered.pid);
    assert.equal(sent.tails[0].reason, 'completed'); assert.equal(sent.tails[0].calls, 4);
    assert.deepEqual(sent.calls.filter(call => call.tail).map(call => call.route), ['self', 'relationship', 'contact', 'self']);
    const stored = f.query('SELECT * FROM records;'), { rows, text } = f.show();
    assert.equal(stored.length, 1); assert.equal(rows.length, 1); assert.equal(rows[0].readiness.state, 'ready');
    assert.equal(rows[0].display.sender, SELF.name); assert.equal(rows[0].display.recipient, PEER.name);
    assert.equal(rows[0].actor_id, SELF.open_id); assert.equal(rows[0].occurred_at_ms, AT + 1000);
    assert.equal(rows[0].body, 'Invented cadence body; preserve  spacing.'); assert(text.includes(PEER.name));
    assert.deepEqual(f.query('SELECT * FROM records;'), stored);
    assert(f.scan().next_attempt_at_ms > 0); assert.equal(f.scan().schedule_sequence, 1);
  });

  test('actual work reserves one shared opportunity and fresh arrival cannot add a second budget', t => {
    const f = fixture(t), now = Date.now() - 86400000; f.cycle('discover', now);
    const first = f.cycle('sent', now + 1), admitted = f.scan(); assert.equal(first.tails[0].calls, 4);
    const next = f.cycle('sent-new', now + 2); assert.equal(next.tails[0].reason, 'cadence'); assert.equal(next.tails[0].calls, 0);
    assert.deepEqual(f.scan(), admitted); assert.equal(f.query('SELECT COUNT(*) AS n FROM records;')[0].n, 2);
    const { rows } = f.show(); const fresh = rows.find(row => row.external_id === 'om_synthetic_idle_new');
    assert.equal(fresh.readiness.state, 'enriching'); assert(fresh.readiness.reasons.includes('recipient_identity_unknown'));
  });

  test('empty successful source cycle still recovers due old recipient debt after restart', t => {
    const f = fixture(t), now = Date.now() - 86400000; f.cycle('discover', now);
    const failed = f.cycle('sent-denied', now + 1), before = f.query('SELECT * FROM records;');
    assert(failed.tails[0].calls > 0); assert.notEqual(f.show().rows[0].readiness.state, 'ready');
    const state = f.query('SELECT * FROM lark_im_recipient_state;'); assert.equal(state.length, 1);
    const admission = f.scan();
    const noDue = f.cycle('sent-empty', admission.next_attempt_at_ms + 1);
    assert.equal(noDue.tails[0].reason, 'idle'); assert.equal(noDue.tails[0].calls, 0);
    assert.equal(f.scan().next_attempt_at_ms, admission.next_attempt_at_ms);
    assert.equal(f.scan().schedule_sequence, admission.schedule_sequence);
    const due = Math.max(f.scan().next_attempt_at_ms, state[0].retry_at_ms) + 1;
    const recovery = f.cycle('sent-empty', due); assert.notEqual(recovery.pid, failed.pid);
    assert.equal(JSON.parse(recovery.stdout).sent.scanned, 0); assert.equal(JSON.parse(recovery.stdout).sent.list_complete, true);
    assert.equal(recovery.tails[0].calls, 4); assert.equal(recovery.tails[0].updated, 1);
    const shown = f.show(); assert.equal(shown.rows[0].readiness.state, 'ready'); assert(shown.text.includes(PEER.name));
    const after = f.query('SELECT * FROM records;'); assert.equal(after.length, before.length);
    for (const key of Object.keys(before[0]).filter(key => key !== 'canonical_json')) assert.equal(after[0][key], before[0][key]);
    assert.equal(f.scan().schedule_sequence, 2);
  });

  test('a concurrent admission winner prevents the losing selected recipient from making any API call', t => {
    const f = fixture(t), now = Date.now() - 86400000; f.cycle('discover', now);
    const losing = f.cycle('sent-cas', now + 1); assert(losing.raceInjected);
    assert.equal(losing.tails[0].reason, 'unavailable'); assert.equal(losing.tails[0].calls, 0);
    assert.equal(f.scan().next_attempt_at_ms, now + 60001); assert.equal(f.scan().schedule_sequence, 1);
    // Local enrollment now precedes remote selection. The losing remote CAS
    // preserves that durable need, but may neither claim it nor start a call.
    const pending = f.query('SELECT * FROM lark_im_recipient_state;');
    assert.equal(pending.length, 1); assert.equal(pending[0].attempt_token, null);
    assert.equal(pending[0].last_attempt_at_ms, 0); assert.equal(pending[0].evidence_json, null);
    assert.notEqual(f.show().rows[0].readiness.state, 'ready');
    const afterDue = f.cycle('sent-empty', now + 60002); assert.equal(afterDue.tails[0].calls, 4);
    assert.equal(f.show().rows[0].readiness.state, 'ready'); assert.equal(f.scan().schedule_sequence, 2);
  });

  test('a stale selected task rolls back cadence, fair rotation and task claim together', t => {
    const f = fixture(t), now = Date.now() - 86400000; f.cycle('discover', now);
    const losing = f.cycle('sent-group-cas', now + 1); assert(losing.raceInjected);
    assert.equal(losing.tails[0].reason, 'unavailable'); assert.equal(losing.tails[0].calls, 0);
    assert.equal(f.scan().next_attempt_at_ms, 0); assert.equal(f.scan().schedule_sequence, 0); assert.equal(f.scan().schedule_slot, 0);
    const tasks = f.query('SELECT * FROM lark_im_name_tasks;'); assert.equal(tasks.length, 1);
    assert.equal(tasks[0].attempt_token, null); assert.equal(tasks[0].last_attempt_at_ms, 0);
    const retry = f.cycle('sent-empty', now + 2); assert.equal(retry.tails[0].calls, 2);
    assert.deepEqual(retry.calls.filter(call => call.tail).map(call => call.route), ['chat', 'self']);
    assert.equal(f.scan().schedule_sequence, 1); assert.equal(f.show().rows[0].readiness.state, 'ready');
  });
}
