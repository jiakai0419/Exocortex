import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { executeMessages } from '../src/cli/messages-command.mjs';
import { readMessagesMetadata } from '../src/diagnostics/messages-report.mjs';
import { hasQualityIssues, sanitizeQualityReportForPublicOutput } from '../src/diagnostics/lark-im-quality-report.mjs';
import { summarizeMessageCompleteness } from '../src/diagnostics/message-completeness-summary.mjs';
import { liveProbeContext } from '../src/diagnostics/live-probe-cache.mjs';
import { prepareSidecarFixture } from './helpers/sidecar-fixture.mjs';

// Authored synthetic data only. All readers below use the production projection,
// shared readiness evaluator, sidecar validation and actual SQLite/CLI paths.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 4, 12, 10, 11, 12);
const CHAT = 'oc_synthetic_quality_workshop';
const TENANT = 'synthetic-quality-tenant';
const APP = 'synthetic_quality_app_without_prefix';
const NAME = 'Invented Quality Courier';
const hash = value => createHash('sha256').update(value).digest('hex');
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value);

function message(id, { direction = 'received', named = true, app = false, system = false, partial = false } = {}) {
  const actor = system ? null : app ? APP : `ou_synthetic_quality_${id}`;
  const namespace = app ? 'app_id' : 'open_id', kind = system ? 'system' : app ? 'app' : 'user';
  const name = named && !system ? `Invented Quality Person ${id}` : null;
  const body = `Authored quality message ${id}.`;
  const external = `om_synthetic_quality_${String(id).padStart(5, '0')}`;
  const type = system ? 'system' : 'text';
  const raw = { message_id: external, chat_id: CHAT, chat_type: 'group', msg_type: type,
    create_time: String(AT + id), sender: system ? {} : { id: actor, id_type: namespace,
      sender_type: kind, tenant_key: TENANT, ...(name ? { name } : {}) },
    body: { content: JSON.stringify(system ? { template: body } : { text: body }) } };
  const canonical = { message_id: external, chat_id: CHAT, chat_type: 'group', chat_name: 'Invented Quality Workshop',
    sender_id: actor, ...(system ? {} : { sender_id_type: namespace, sender_type: kind }),
    sender_name: name, ...(name ? { sender_name_source: 'message_sender' } : {}), msg_type: type,
    ...(partial ? { content_rendering: { status: 'partial', reason: 'render_limit_exceeded' } } : {}) };
  return { id, source_id: 'lark.im', first_seen_scope_id: SENT_SCOPE_ID, external_id: external,
    external_version: String(AT + id), record_type: 'lark.im.message',
    occurred_at: new Date(AT + id).toISOString(), occurred_at_ms: AT + id,
    actor_id: actor, container_id: CHAT, direction, body, content_hash: hash(JSON.stringify(raw)),
    canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw) };
}

function fixture(t, rows) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-quality-completeness-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), marker = join(directory, 'unexpected-network');
  const cli = join(directory, 'reject-network-cli'), guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
const reject=()=>{writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER,'called');throw Error('network forbidden');};
globalThis.fetch=reject;Socket.prototype.connect=reject;
`);
  ensureInitialized(db);
  sqliteExec(db, `INSERT INTO sources(id,kind,display_name) VALUES('synthetic.other','synthetic','Invented Other Source');\n`
    + rows.map(row => {
      const columns = Object.keys(row);
      return `INSERT INTO records(${columns.join(',')}) VALUES(${columns.map(key => sql(row[key])).join(',')});`;
    }).join('\n'));
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard };
}

function snapshot(f) {
  return readdirSync(f.directory).sort().map(name => {
    const path = join(f.directory, name), stat = statSync(path);
    return { name, hash: hash(readFileSync(path)), mode: stat.mode & 0o777, modified: stat.mtimeMs };
  });
}

function command(f, args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ['--import', f.guard, ...args], {
    cwd: f.directory, env: { ...process.env, LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker },
    encoding: 'utf8', timeout: 20_000, maxBuffer: 12 * 1024 * 1024,
  });
  assert.equal(existsSync(f.marker), false, 'quality/messages must not use network or Lark');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  (f.timings ||= []).push({ command: args[0] === '--input-type=module' ? 'quality' : 'messages',
    elapsed_ms: Math.round((performance.now() - started) * 1000) / 1000 });
  return JSON.parse(result.stdout);
}

function quality(f) {
  const url = pathToFileURL(join(ROOT, 'src/diagnostics/lark-im-quality-report.mjs')).href;
  return command(f, ['--input-type=module', '-e', `import {collectQualityReport} from ${JSON.stringify(url)};
process.stdout.write(JSON.stringify(collectQualityReport(process.argv[1])));`, f.db]);
}

function messages(f, { direction = 'all', limit = 1000, search = '' } = {}) {
  return command(f, [join(ROOT, 'bin/exocortex.mjs'), 'messages', '--db', f.db,
    '--format', 'json', '--direction', direction, '--limit', String(limit), '--search', search]);
}

function sameSharedSummary(report, rows) {
  const summary = summarizeMessageCompleteness(rows, { population: report.completeness.population,
    as_of: report.completeness.as_of, filter: { direction: 'all', search: '' } });
  assert.deepEqual(report.completeness, summary, 'quality must reduce actual mapped CLI readiness, without a second classifier');
  assert.equal(Object.values(summary.counts).reduce((a, b) => a + b, 0), summary.population.evaluated);
  assert.equal(summary.population.total, summary.population.evaluated + summary.population.not_evaluated);
  assert.equal(summary.incomplete, summary.population.evaluated - summary.counts.ready);
}

test('quality uses actual all-direction messages, keeps overlapping missing/partial reasons and legitimate system readiness', t => {
  const rows = [message(1), message(2, { direction: 'sent' }), message(3, { named: false, partial: true }),
    message(4, { system: true })];
  const f = fixture(t, rows), before = snapshot(f), report = quality(f), selected = messages(f);
  assert.deepEqual(selected.map(row => row.id), [4, 3, 2, 1]);
  assert.deepEqual(selected.map(row => row.readiness.state), ['ready', 'enriching', 'ready', 'ready']);
  assert.equal(selected[0].readiness.requirements.find(item => item.field === 'sender').evidence, 'system_event');
  assert.deepEqual(report.completeness.counts, { captured: 0, enriching: 1, ready: 3, blocked: 0 });
  assert.equal(report.completeness.incomplete, 1);
  assert.equal(report.completeness.reasons.sender_name_missing, 1);
  assert.equal(report.completeness.reasons.content_partial, 1, 'one incomplete message can contribute two reasons');
  assert.deepEqual(report.completeness.filter, { direction: 'all', has_search: false });
  assert.deepEqual(report.completeness.population, { total: 4, evaluated: 4, not_evaluated: 0 });
  assert.equal(report.quality.missing_system_sender_name, 1, 'legacy canonical meaning remains visible');
  assert.equal(report.messages.sent, 1); assert.equal(report.messages.received, 3);
  assert.equal(hasQualityIssues(report), true, 'the missing human still follows the original gate');
  sameSharedSummary(report, selected);
  assert.deepEqual(snapshot(f), before);
});

test('bounded latest page does not replace incomplete rows or treat unevaluated messages as zero', t => {
  const rows = Array.from({ length: 1003 }, (_, index) => message(index + 1,
    { direction: index % 2 ? 'sent' : 'received', named: index >= 3 }));
  rows.push({ ...message(1004), source_id: 'synthetic.other' });
  rows.push({ ...message(1005), record_type: 'synthetic.other.type' });
  const f = fixture(t, rows), before = snapshot(f), report = quality(f), selected = messages(f);
  assert.equal(selected.length, 1000); assert.equal(selected[0].id, 1003); assert.equal(selected.at(-1).id, 4);
  assert.ok(selected.every(row => row.readiness.state === 'ready'));
  assert.equal(report.messages.total, 1003);
  assert.equal(report.completeness.as_of.source_max_record_id, 1003);
  assert.deepEqual(report.completeness.population, { total: 1003, evaluated: 1000, not_evaluated: 3 });
  assert.equal(report.completeness.limit, 1000); assert.equal(report.completeness.counts.ready, 1000);
  assert.equal(report.completeness.reasons.sender_name_missing, 0);
  assert.equal(report.completeness.evaluation.status, 'bounded'); assert.equal(report.completeness.evaluation.complete, false);
  assert.equal(report.quality.actionable_missing_sender_name, 3, 'canonical counters cover a different population');
  sameSharedSummary(report, selected);
  const filtered = messages(f, { direction: 'sent', limit: 2, search: 'quality message 10' });
  assert.deepEqual(filtered.map(row => row.id), [1002, 1000]);
  t.diagnostic(JSON.stringify({ stored: 1003, quality_limit: 1000, measurements: f.timings }));
  assert.deepEqual(snapshot(f), before);
});

test('quality and actual CLI agree after one exact tenant/chat/app sidecar mapping, retaining safe metadata', t => {
  const exact = message(2, { app: true, named: false }), other = message(1, { app: true, named: false });
  const raw = JSON.parse(other.raw_json); raw.sender.tenant_key = 'synthetic-other-quality-tenant'; other.raw_json = JSON.stringify(raw);
  const f = fixture(t, [other, exact]);
  const path = `${f.db}.chat-app-names.json`;
  writeFileSync(path, JSON.stringify({ kind: 'lark_im_chat_app_names/v1',
    context: { database_key: liveProbeContext(f.db).database_key, source_id: 'lark.im' },
    entries: [{ tenant_key: TENANT, chat_id: CHAT, app_id: APP, name: NAME,
      source: { kind: 'user_screenshot', recorded_at: new Date(AT).toISOString(), evidence_refs: ['invented-quality-reference'] } }] }), { mode: 0o600 });
  prepareSidecarFixture(path);
  const before = snapshot(f), report = quality(f), selected = messages(f);
  assert.equal(selected[0].display.sender, `应用：${NAME}`);
  assert.equal(selected[0].readiness.state, 'ready'); assert.equal(selected[0].canonical.sender_name, null);
  assert.equal(selected[1].readiness.state, 'enriching'); assert.notEqual(selected[1].display.sender, `应用：${NAME}`);
  assert.deepEqual(report.completeness.counts, { captured: 0, enriching: 1, ready: 1, blocked: 0 });
  assert.equal(report.quality.missing_sender_name, 2, 'legacy storage counters are not overwritten by display mappings');
  sameSharedSummary(report, selected);
  const mapped = executeMessages({ db: f.db, direction: 'all', limit: 1000, search: '' });
  assert.deepEqual(mapped, selected);
  const metadata = readMessagesMetadata(mapped);
  assert.deepEqual(metadata.population, { total: 2, evaluated: 2, not_evaluated: 0 });
  assert.deepEqual(metadata.filter, { direction: 'all', has_search: false });
  assert.deepEqual(sanitizeQualityReportForPublicOutput(report), report, 'public sanitization is idempotent');
  for (const privateValue of [NAME, TENANT, CHAT, APP, 'invented-quality-reference', f.directory, exact.body]) {
    assert.equal(JSON.stringify(report).includes(privateValue), false);
  }
  assert.deepEqual(snapshot(f), before);
});

test('unknown source clocks and unattested completion clocks remain unknown in a real SQLite report', t => {
  const unknown = message(1, { named: false }); unknown.occurred_at_ms = null;
  const f = fixture(t, [unknown, message(2)]), before = snapshot(f), report = quality(f), selected = messages(f);
  assert.equal(selected[1].readiness.state, 'blocked');
  assert.ok(selected[1].readiness.reasons.includes('message_time_invalid'));
  assert.equal(report.completeness.timing.oldest_source_at, null);
  assert.equal(report.completeness.timing.oldest_source_age_ms, null);
  assert.equal(report.identity_work.name_tasks.total, 0); assert.equal(report.identity_work.recipient_state.total, 0);
  assert.ok(Date.parse(report.identity_work.as_of.read_at) > AT, 'empty task tables still have an actual snapshot clock');
  assert.equal(report.completeness.timing.source_time_unknown_count, 1);
  assert.equal(report.completeness.timing.source_age_unknown_count, 1);
  assert.deepEqual(report.completeness.timing.first_missing, { oldest_at: null, oldest_age_ms: null, unknown_count: 1 });
  assert.deepEqual(report.completeness.timing.completion, { latest_at: null, latency_ms: null, unknown_count: 1 });
  sameSharedSummary(report, selected);
  assert.deepEqual(snapshot(f), before);
});

test('a new normal message and valid senderless system event are ready without changing the advisory exit contract', t => {
  const f = fixture(t, [message(1), message(2, { system: true })]), before = snapshot(f), report = quality(f);
  assert.equal(report.completeness.counts.ready, 2); assert.equal(report.completeness.incomplete, 0);
  assert.equal(report.completeness.evaluation.complete, true);
  assert.equal(report.quality.missing_sender_name, 1); assert.equal(report.quality.missing_system_sender_name, 1);
  assert.equal(report.quality.actionable_missing_sender_name, 0); assert.equal(hasQualityIssues(report), false);
  sameSharedSummary(report, messages(f));
  assert.deepEqual(snapshot(f), before);
});

test('empty report has a complete zero stored population without manufacturing time evidence', t => {
  const f = fixture(t, []), before = snapshot(f), report = quality(f);
  assert.deepEqual(report.completeness.population, { total: 0, evaluated: 0, not_evaluated: 0 });
  assert.equal(report.completeness.evaluation.complete, true); assert.equal(hasQualityIssues(report), false);
  assert.equal(report.completeness.timing.oldest_source_at, null);
  assert.equal(report.completeness.timing.oldest_source_age_ms, null);
  sameSharedSummary(report, messages(f)); assert.deepEqual(snapshot(f), before);
});

test('public completeness sanitization drops arbitrary content/identity and does not turn invalid counts into zeros', () => {
  const secret = 'PRIVATE_SYNTHETIC_PAYLOAD';
  const report = { completeness: { ...summarizeMessageCompleteness([], {}), body: secret, identity: secret,
    population: { total: secret, evaluated: -1, not_evaluated: null, body: secret },
    counts: { ready: Infinity, enriching: NaN, captured: '0', blocked: null, [secret]: 1 },
    reasons: { sender_name_missing: 3, [secret]: 9 },
    filter: { direction: secret, has_search: secret, search: secret },
    as_of: { read_at: secret, source_max_record_id: secret, actor_id: secret },
    evaluation: { status: secret, complete: true, metadata_valid: secret, content: secret },
    timing: { oldest_source_at: secret, oldest_source_age_ms: secret, first_missing: { oldest_at: secret },
      completion: { latest_at: secret, latency_ms: -1 },
      first_missing_observed: { oldest_at: secret, known_count: secret, unknown_count: -1, [secret]: secret },
      first_ready_observed: { latest_at: secret, known_count: Infinity },
      observed_regressions: { regression_count: secret, known_count: '0' }, [secret]: secret } } };
  const actual = sanitizeQualityReportForPublicOutput(report).completeness;
  assert.equal(JSON.stringify(actual).includes(secret), false);
  assert.deepEqual(actual.population, { total: null, evaluated: null, not_evaluated: null });
  assert.deepEqual(actual.counts, { captured: null, enriching: null, ready: null, blocked: null });
  assert.equal(actual.reasons.sender_name_missing, 3); assert.equal(actual.reasons.content_partial, null);
  assert.equal(actual.evaluation.status, 'invalid'); assert.equal(actual.evaluation.complete, false);
  assert.equal(actual.evaluation.metadata_valid, false); assert.equal(actual.as_of.read_at, null);
  assert.equal(actual.timing.first_missing.oldest_at, null); assert.equal(actual.timing.completion.latency_ms, null);
  assert.equal(actual.timing.first_missing_observed.known_count, null);
  assert.equal(actual.timing.first_ready_observed.latest_at, null);
  assert.equal(actual.timing.observed_regressions.regression_count, null);
  assert.equal(sanitizeQualityReportForPublicOutput({}).completeness.population.not_evaluated, null);
});

test('identity work aggregates exact persisted source populations and preserves recipient unknown categories', t => {
  const f = fixture(t, [message(1)]), secret = 'PRIVATE_SYNTHETIC_TASK_DETAILS';
  const names = [
    ['pending', 0, null, AT], ['resolved', 0, null, AT - 1000], ['applying', 1, null, AT + 1000],
    ['failed', 0, 'permission_denied', 0], ['failed', 0, 'retry_exhausted', Date.now() + 86400000],
    ['capacity_deferred', 1, secret, AT + 2000],
  ];
  sqliteExec(f.db, 'PRAGMA ignore_check_constraints=ON;' + names.map(([outcome, projection, blocked, at], index) =>
    `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,actor_id,namespace,
      latest_record_id,outcome,projection_deferred,blocked_reason,enqueued_at_ms,evidence_json)
      VALUES('lark.im',${quoteSql(secret)},'synthetic_task_${index}','sender',${quoteSql(CHAT)},${quoteSql(secret)},'open_id',
      1,${quoteSql(outcome)},${projection},${sql(blocked)},${at},${quoteSql(JSON.stringify({ error: secret }))});`).join('')
    + `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,latest_record_id,outcome)
      VALUES('synthetic.other','synthetic','foreign','chat','synthetic',1,'pending');
      INSERT INTO lark_im_recipient_state(source_id,account_key,chat_id,retry_at_ms,evidence_json,attempt_evidence_json,enqueued_at_ms)
      VALUES('lark.im','synthetic','recipient_pending',0,NULL,NULL,${AT - 5000}),
      ('lark.im','synthetic','recipient_scheduler_complete',9007199254740991,'{}','{}',${AT - 10000}),
      ('lark.im','synthetic','recipient_changed',9007199254740991,'{"version":2}','{"version":1}',0),
      ('synthetic.other','synthetic','foreign',0,NULL,NULL,0);`);
  const before = snapshot(f), report = quality(f), work = report.identity_work;
  assert.equal(work.source_id, 'lark.im'); assert.equal(work.account_scope, 'all_stored_accounts');
  assert.equal(work.basis, 'scheduler_state_not_message_readiness');
  assert.ok(Date.parse(work.as_of.read_at) > AT);
  assert.equal(work.name_tasks.table, 'lark_im_name_tasks'); assert.equal(work.name_tasks.total, 6);
  assert.equal(work.name_tasks.unresolved, 5); assert.equal(work.name_tasks.pending_projection, 2);
  assert.deepEqual(work.name_tasks.blocked_reasons, { permission_denied: 1, command_unavailable: 0,
    routes_blocked: 0, retry_exhausted: 1, unknown: 1 });
  assert.equal(work.name_tasks.oldest_known_enqueued_at, new Date(AT).toISOString());
  assert.equal(work.name_tasks.enqueue_time_unknown_count, 2);
  assert.equal(work.recipient_state.total, 3); assert.equal(work.recipient_state.unresolved, 2);
  assert.equal(work.recipient_state.pending_projection, null); assert.equal(work.recipient_state.blocked_status, 'unknown');
  assert(Object.values(work.recipient_state.blocked_reasons).every(value => value === null));
  assert.equal(work.recipient_state.oldest_known_enqueued_at, new Date(AT - 5000).toISOString());
  assert.equal(work.recipient_state.enqueue_time_unknown_count, 1);
  assert.equal(JSON.stringify(work).includes(secret), false); assert.equal(JSON.stringify(work).includes(CHAT), false);
  assert.deepEqual(snapshot(f), before);
});

test('legacy identity schemas retain known totals while unavailable scheduling fields remain unknown', t => {
  const f = fixture(t, []);
  sqliteExec(f.db, `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,latest_record_id,outcome)
    VALUES('lark.im','synthetic','legacy','chat','synthetic',1,'pending');
    DROP INDEX lark_im_name_tasks_fair; DROP INDEX lark_im_name_tasks_fresh; DROP INDEX lark_im_name_tasks_blocked_due;
    ALTER TABLE lark_im_name_tasks DROP COLUMN enqueued_at_ms;
    ALTER TABLE lark_im_name_tasks DROP COLUMN blocked_reason;
    DROP TABLE lark_im_recipient_state;`);
  const before = snapshot(f), work = quality(f).identity_work;
  assert.equal(work.name_tasks.availability, 'partial'); assert.equal(work.name_tasks.total, 1);
  assert.equal(work.name_tasks.unresolved, 1); assert.equal(work.name_tasks.enqueue_status, 'unknown');
  assert.equal(work.name_tasks.oldest_known_enqueued_at, null); assert.equal(work.name_tasks.enqueue_time_unknown_count, null);
  assert.equal(work.name_tasks.blocked_status, 'unknown');
  assert(Object.values(work.name_tasks.blocked_reasons).every(value => value === null));
  assert.equal(work.recipient_state.availability, 'unavailable'); assert.equal(work.recipient_state.total, null);
  assert.equal(work.recipient_state.unresolved, null); assert.equal(work.recipient_state.enqueue_time_unknown_count, null);
  assert.deepEqual(snapshot(f), before);
});

test('identity work public whitelist exposes no keys, payloads or arbitrary blocked reasons', () => {
  const secret = 'PRIVATE_SYNTHETIC_IDENTITY_WORK';
  const row = { table: secret, availability: secret, total: secret, unresolved: -1, pending_projection: Infinity,
    projection_status: secret, blocked_status: 'recorded', blocked_reasons: { permission_denied: 2, [secret]: 9 },
    enqueue_status: 'recorded', oldest_known_enqueued_at: secret, oldest_known_enqueue_age_ms: -1,
    enqueue_time_unknown_count: '0', task_key: secret, account_key: secret, evidence_json: secret };
  const actual = sanitizeQualityReportForPublicOutput({ identity_work: { source_id: secret, basis: secret,
    as_of: { read_at: secret, [secret]: secret }, name_tasks: row, recipient_state: row, [secret]: secret } }).identity_work;
  assert.equal(JSON.stringify(actual).includes(secret), false);
  assert.equal(actual.name_tasks.total, null); assert.equal(actual.name_tasks.unresolved, null);
  assert.equal(actual.name_tasks.pending_projection, null); assert.equal(actual.name_tasks.blocked_reasons.permission_denied, 2);
  assert.equal(actual.name_tasks.oldest_known_enqueued_at, null); assert.equal(actual.name_tasks.enqueue_time_unknown_count, null);
  assert.equal(actual.as_of.read_at, null);
});

test('actual check CLI carries identity task evidence without changing the existing quality gate', t => {
  const f = fixture(t, [message(1)]);
  sqliteExec(f.db, `INSERT INTO lark_im_name_tasks(source_id,account_key,task_key,kind,chat_id,latest_record_id,outcome,enqueued_at_ms)
    VALUES('lark.im','synthetic_check_account','synthetic_check_task','chat','synthetic_check_chat',1,'pending',${AT});`);
  const before = snapshot(f);
  const result = spawnSync(process.execPath, ['--import', f.guard, join(ROOT, 'bin/exocortex.mjs'),
    'check', '--db', f.db, '--format', 'json'], {
    cwd: f.directory, env: { ...process.env, LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker },
    encoding: 'utf8', timeout: 20_000, maxBuffer: 12 * 1024 * 1024,
  });
  assert.ok([0, 2].includes(result.status), result.stderr || result.stdout);
  assert.equal(result.stderr, ''); assert.equal(existsSync(f.marker), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checks.quality.status, 'passed', 'identity work adds evidence, not a new exit criterion');
  const work = report.checks.quality.evidence.identity_work;
  assert.equal(work.name_tasks.total, 1); assert.equal(work.name_tasks.unresolved, 1);
  assert.equal(work.name_tasks.oldest_known_enqueued_at, new Date(AT).toISOString());
  assert.equal(JSON.stringify(work).includes('synthetic_check'), false);
  assert.deepEqual(snapshot(f), before);
});

test('actual quality retains validated historical observation clocks while true first clocks stay unknown', t => {
  const row = message(1), f = fixture(t, [row]);
  const version = hash(JSON.stringify([row.external_version, hash(row.raw_json)]));
  sqliteExec(f.db, `INSERT INTO lark_im_message_readiness(source_id,record_id,observer_account_key,contract_version,
    source_version_key,source_epoch,state,reasons_json,first_observed_at_ms,first_missing_observed_at_ms,
    first_ready_observed_at_ms,last_observed_at_ms,observed_regression_count,generation)
    VALUES('lark.im',1,${quoteSql(hash('synthetic quality observer'))},1,${quoteSql(version)},1,'ready','[]',
      ${AT + 2},${AT + 2},${AT + 3},${AT + 3},0,2);`);
  const before = snapshot(f), report = quality(f), timing = report.completeness.timing;
  assert.equal(report.completeness.counts.ready, 1);
  assert.equal(timing.first_missing_observed.oldest_at, new Date(AT + 2).toISOString());
  assert.equal(timing.first_missing_observed.known_count, 1); assert.equal(timing.first_missing_observed.unknown_count, 0);
  assert.equal(timing.first_ready_observed.latest_at, new Date(AT + 3).toISOString());
  assert.equal(timing.first_ready_observed.known_count, 1);
  assert.deepEqual(timing.observed_regressions, { regression_count: 0, known_count: 1, unknown_count: 0 });
  assert.equal(timing.first_missing.oldest_at, null); assert.equal(timing.completion.latest_at, null);
  assert.equal(timing.completion.unknown_count, 1);
  assert.deepEqual(snapshot(f), before);
});
