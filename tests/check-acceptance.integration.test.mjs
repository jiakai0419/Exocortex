import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { runCheckCommand } from '../src/cli/check-command.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { collectRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { evaluateSample, SAMPLE_POLICY } from '../src/diagnostics/remote-sample-core.mjs';
import { publicRemoteReport } from '../src/diagnostics/remote-sample-cache.mjs';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { textWidth } from '../src/terminal/text-layout.mjs';
import { live, sync } from './helpers/check-fixture.mjs';

// All identities, bodies, counters and times below originate here. The real
// parser/report/collector/evaluator/rendering path receives no account access.
const NOW = Date.parse('2036-01-20T12:00:00Z');
const CREATED = NOW - 3 * 86400000;
const PRIVATE = 'SYNTHETIC_PRIVATE_ACCEPTANCE';
const binding = { state: 'verified', evidence: 'single_sent_actor', database_key: 'a'.repeat(64), account_key: 'b'.repeat(64) };
const original = { message_id: 'synthetic_old_message', chat_id: 'synthetic_history_chat', msg_type: 'text',
  create_time: String(CREATED), update_time: String(CREATED), deleted: false, body: { content: JSON.stringify({ text: PRIVATE }) } };
const local = message => ({ source_id: 'lark.im', record_type: 'lark.im.message', external_id: message.message_id,
  container_id: message.chat_id, external_version: message.update_time, raw_json: JSON.stringify(message),
  canonical_json: '{"source_api":"im.v1.messages"}' });
const edited = { ...original, deleted: true, update_time: String(CREATED + 1000) };
function seedDebts() {
  const evaluate = (remote, previous) => evaluateSample({ messages: [remote], records: new Map([[original.message_id, local(original)]]),
    coverage: {}, binding, previous, now: NOW - 3600000, windowEnd: NOW - SAMPLE_POLICY.stableBufferMs });
  return evaluate(edited, evaluate({ ...original, deleted: true }, {}).observations).observations;
}
function sample(remote, stored, previous) {
  let calls = 0;
  const records = new Map([[original.message_id, local(stored)]]);
  const chats = ['synthetic_current_chat', original.chat_id];
  const result = collectRemoteSample('/synthetic/never-read.sqlite', { previousObservations: previous, accountKey: binding.account_key }, {
    now: () => NOW, context: () => ({ database_key: binding.database_key }), readBinding: () => binding,
    loadInventory: () => chats.map((chat_id, hot_rank) => ({ id: chatScopeId(chat_id), source_id: 'lark.im', enabled: 1, chat_id, hot_rank })),
    sqliteJson: () => assert.fail('scoped synthetic observations need no legacy DB routing'),
    // This synthetic snapshot has no writer ticket or concurrent generation;
    // real ticket fences are exercised by the SQLite integration scenarios.
    inspectSnapshot: (_db, targets) => ({ records, verification: { status: 'ready', blockedKeys: [] }, coverage: Object.fromEntries(targets.map(target => [target.key,
      { covered: true, details_pending: false, latest_finished_ms: NOW - 1, reason: 'covered' }])) }),
    api: { deadline: NOW + 55000, count: () => calls, call(path, params) {
      assert.ok(++calls <= SAMPLE_POLICY.calls);
      if (path.includes('/authen/')) return { code: 0, data: { open_id: 'ou_synthetic_self', tenant_key: 'synthetic_tenant' } };
      const history = Number(params.start_time) * 1000 < NOW - SAMPLE_POLICY.windowMs - SAMPLE_POLICY.stableBufferMs;
      const current = { ...original, message_id: `synthetic_current_${params.container_id}`, chat_id: params.container_id,
        create_time: String(NOW - 3600000), update_time: String(NOW - 3600000) };
      if (!history) records.set(current.message_id, local(current));
      return { code: 0, data: { items: history ? (remote ? [remote] : []) : [current], has_more: false } };
    } },
  });
  return result;
}
async function command(result, { columns = 160, format = 'text', db = '/synthetic/never-read.sqlite', actualLocal = false, remote = true } = {}) {
  let output = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), { columns });
  const code = await runCli(['check', '--db', db, ...(remote ? ['--live'] : []), '--format', format], {
    root: '/synthetic/root', cwd: '/synthetic/cwd', env: { PATH: '' }, now: () => NOW, stdout,
    stderr: { write: text => assert.fail(text) },
    loadCommand: async group => {
      assert.equal(group, 'check');
      return { runCheckCommand: (options, context) => runCheckCommand(options, context, {
        checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
        ...(!actualLocal ? { readDatabaseEvidence: () => ({ ok: true, quick_check: 'ok' }), buildStatus: () => sync(),
          collectQualityReport: () => ({ quality: {} }) } : {}),
        collectRemoteSample: () => { assert.ok(remote); return result; },
        runManualRemoteSample: () => assert.fail('no scheduler or cache write'),
      }) };
    },
  });
  assert.doesNotMatch(output, new RegExp(`${PRIVATE}|synthetic_old_message|synthetic_history_chat|scope_hash|account_key`));
  return { code, output };
}
const flatten = text => text.replace(/\s+/g, ' ');

test('actual CLI exposes successful collection with remaining history debt and only passes after each dimension is resolved', async () => {
  const first = sample(edited, original, seedDebts());
  assert.equal(first.outcome, 'ok');
  assert.equal(first.report.findings.stale_version, 1);
  assert.equal(first.report.findings.unresolved_prior, 0, 'current listed difference is excluded, not cleared');
  // The newer response repeats the deletion contradiction, so both independent
  // debts require proof at that response's version.
  assert.deepEqual(Object.values(first.observations)[0].debts, { deleted: CREATED + 1000, version: CREATED + 1000 });
  const { deleted, ...partialRemote } = edited;
  const caughtUp = { ...original, update_time: edited.update_time };
  const partial = sample(partialRemote, caughtUp, first.observations);
  assert.equal(partial.outcome, 'ok');
  assert.deepEqual(Object.values(partial.observations)[0].debts, { deleted: CREATED + 1000 });
  assert.equal(partial.report.findings.unresolved_prior, 1);
  const absent = sample(null, caughtUp, partial.observations);
  assert.equal(absent.report.history.messages_checked, 0);
  assert.deepEqual(Object.values(absent.observations)[0].debts, { deleted: CREATED + 1000 });
  const resolved = sample(caughtUp, caughtUp, absent.observations);
  assert.deepEqual(resolved.observations, {});
  for (const [result, expectedCode] of [[first, 2], [partial, 2], [absent, 2], [resolved, 0]]) {
    const json = await command(result, { format: 'json' });
    assert.equal(json.code, expectedCode);
    assert.deepEqual(JSON.parse(json.output).checks.live.evidence, publicRemoteReport(result.report));
    for (const columns of [20, 40, 80, 160]) {
      const text = await command(result, { columns });
      assert.equal(text.code, expectedCode);
      for (const line of text.output.split('\n')) assert.ok(textWidth(line) <= columns, line);
      const compact = flatten(text.output);
      const count = result.report.history.messages_checked;
      assert.match(compact, new RegExp(`2 current messages / 2 chats \\+ ${count} historical target`));
      assert.match(compact, /Historical revisit:.*target observed/);
      assert.match(compact, /History window:/);
      if (result === partial || result === absent) assert.match(compact, /Prior findings unresolved: 1/);
    }
  }
});

for (const mode of ['primary', 'cleanup', 'both']) test(`actual CLI preserves independent ${mode} guardian evidence without raw errors`, async () => {
  const diagnostic = { version: 1, primary: mode === 'cleanup' ? null : { stage: 'watch_register', errno: 1 },
    cleanup: mode === 'primary' ? null : { stage: 'group_kill', errno: 13 } };
  const result = { outcome: 'failed', report: live(), guardian_diagnostic: diagnostic, stderr: PRIVATE };
  for (const columns of [20, 40, 80, 160]) {
    const text = await command(result, { columns });
    assert.equal(text.code, 1);
    const compact = flatten(text.output);
    if (diagnostic.primary) assert.match(compact, /Sample process: watch_register · errno 1/);
    if (diagnostic.cleanup) assert.match(compact, /Sample cleanup: group_kill · errno 13/);
    assert.doesNotMatch(compact, /healthy|PASSED.*Remote sample: healthy/);
    for (const line of text.output.split('\n')) assert.ok(textWidth(line) <= columns, line);
  }
  const json = JSON.parse((await command(result, { format: 'json' })).output);
  assert.deepEqual(json.checks.live.evidence.guardian_diagnostic, diagnostic);
});

test('failed collector result and rejected diagnostic cannot be presented as a healthy sample', async () => {
  for (const additions of [{}, { guardian_diagnostic: { version: 1, primary: { stage: PRIVATE, errno: 1 }, cleanup: null } }]) {
    const text = await command({ outcome: 'failed', report: live(), ...additions });
    assert.equal(text.code, 1);
    assert.doesNotMatch(text.output, /Remote sample: healthy/);
    assert.doesNotMatch(text.output, /Sample process:|Sample cleanup:/);
  }
});

test('contradictory historical scope is unverified rather than clamped into an apparent observation', async () => {
  const result = sample(edited, original, seedDebts());
  const report = { ...result.report, ok: false, status: 'inconclusive', reason: 'unresolved_observations' };
  for (const change of [
    { probe: { ...report.probe, remote_messages_checked: 0 } },
    { history: { ...report.history, window: { start: report.window.start,
      end: new Date(Date.parse(report.window.start) + 3000).toISOString() } } },
    { history: { ...report.history, private: PRIVATE } },
  ]) {
    const changed = { ...result, report: { ...report, ...change } };
    for (const columns of [20, 40, 80, 160]) {
      const text = await command(changed, { columns });
      assert.equal(text.code, 2);
      assert.match(flatten(text.output), /sample scope unverified/);
      assert.doesNotMatch(text.output, /current messages|historical target|Historical revisit|History window/);
      for (const line of text.output.split('\n')) assert.ok(textWidth(line) <= columns, line);
    }
    const json = JSON.parse((await command(changed, { format: 'json' })).output);
    assert.deepEqual(json.checks.live.evidence, publicRemoteReport(changed.report));
  }
});

test('actual SQLite quality gaps remain visible after successful sync without writing the stored evidence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-check-acceptance-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  const canonical = { sender_id: 'ou_synthetic_missing_name', chat_id: 'synthetic_group', chat_type: 'group', sender_name: '', chat_name: '' };
  sqliteExec(db, `INSERT INTO sync_runs(source_id,scope_id,status) VALUES('lark.im','lark.im.sent_by_me','succeeded');
    UPDATE sync_scopes SET last_success_run_id=last_insert_rowid(),cursor_json='{"kind":"time_message_cursor/v1","created_at_ms":1893492000000}' WHERE id='lark.im.sent_by_me';
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';
    INSERT INTO records(source_id,first_seen_scope_id,record_type,external_id,body,raw_json,canonical_json)
      VALUES('lark.im','lark.im.sent_by_me','lark.im.message','synthetic_gap','[Invalid JSON]','{}',${quoteSql(JSON.stringify(canonical))});
    INSERT INTO records(source_id,first_seen_scope_id,record_type,external_id,body,raw_json,canonical_json)
      VALUES('lark.im','lark.im.sent_by_me','lark.im.message','synthetic_system',${quoteSql(PRIVATE)},'{}','{"msg_type":"system"}');
    PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;`);
  const hash = () => createHash('sha256').update(readFileSync(db)).digest('hex');
  const before = hash();
  const text = await command(null, { db, actualLocal: true, remote: false });
  assert.equal(text.code, 2);
  assert.match(text.output, /sync: PASSED/);
  assert.match(text.output, /Stored sender gaps: 1 actionable message records/);
  assert.match(text.output, /Stored chat gaps: 1 group\/topic message records/);
  assert.match(text.output, /Invalid bodies: 1 message records/);
  const json = JSON.parse((await command(null, { db, actualLocal: true, remote: false, format: 'json' })).output);
  assert.equal(json.checks.quality.evidence.quality.actionable_missing_sender_name, 1);
  assert.equal(json.checks.quality.evidence.quality.missing_chat_name, 1);
  assert.equal(json.checks.quality.evidence.quality.missing_sender_name, 2);
  assert.equal(json.checks.quality.evidence.quality.missing_system_sender_name, 1);
  assert.equal(json.checks.sync.status, 'passed');
  assert.equal(hash(), before);
});
