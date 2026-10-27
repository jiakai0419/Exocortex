import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNameResolver } from '../src/adapters/lark-im/name-resolver.mjs';
import { readSenderNameRouteFailures } from '../src/adapters/lark-im/sender-name-observation.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { ensureInitialized, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';

// Fully invented identity/source and execution receipts. Real ingestion SQL and
// pure diagnostic reader must agree, including on no-query source replay.
const AT = Date.parse('2025-04-11T08:00:00Z');
const SELF = { open_id: 'ou_invented_receipt_owner', name: 'Invented Receipt Owner' };
const APP = 'cli_invented_receipt_app', CHAT = 'oc_invented_receipt_room';
const ACCOUNT = recipientAccountKey(SELF.open_id), iso = ms => new Date(ms).toISOString();
const binding = { account_key: ACCOUNT, actor_id: APP, namespace: 'app_id', chat_id: CHAT };
function message() {
  return normalizeApiMessage({ message_id: 'om_invented_receipt_message', chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(AT), update_time: String(AT + 1), sender: { id: APP, id_type: 'app_id', sender_type: 'app' },
    body: { content: JSON.stringify({ text: 'Invented execution receipt preservation body.' }) } });
}
function record(context = {}) {
  return recordFromMessage(message(), 'lark.im.sent_by_me', 'received', context,
    { chat_id: CHAT, chat_type: 'group', chat_name: 'Invented Receipt Room' });
}
function initial(mode = 'timeout') {
  let clock = AT;
  const resolver = createNameResolver({ now: () => clock, run(args) {
    const op = args[0] === 'api' ? 'application_info' : 'chat_bots'; clock = AT + (op === 'application_info' ? 100 : 300);
    throw Error(`lark-cli failed: kind=permission_denied code=210508 operation=${op}`);
  } });
  let row = record(resolver.buildPeopleContext([message()], {}, SELF));
  const canonical = JSON.parse(row.canonical_json), observation = canonical.sender_name_verification;
  for (const route of observation.route_failures.routes) {
    const primary = route.operation === 'application_info';
    const execution = { version: 1, launch_attempted: true, execution: 'started', result_at_ms: AT + (primary ? 100 : 200),
      result_kind: primary ? 'permission_denied' : 'network_timeout', result_code: primary ? 210508 : null, remote_result: primary };
    if (!primary && mode === 'local') Object.assign(execution, { launch_attempted: false, execution: 'not_started',
      result_at_ms: null, result_kind: null, result_code: null, remote_result: false });
    if (!primary && mode === 'unknown') Object.assign(execution, { execution: 'unknown',
      result_at_ms: null, result_kind: null, result_code: null, remote_result: false });
    route.failure = primary ? { ...route.failure, version: 2, execution }
      : { version: 2, operation: route.operation, kind: 'unknown', code: null, stage: 'unknown', execution };
  }
  observation.failure = structuredClone(observation.route_failures.routes[0].failure);
  row.canonical_json = JSON.stringify(canonical);
  return bindAcquiredMessageAccounts([row], SELF, { acquiredAt: iso(AT + 50) })[0];
}
function fixture(t, row) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-invented-receipt-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite'); ensureInitialized(db);
  const write = value => sqliteExec(db, upsertRecordsSql([value]));
  write(row); sqliteExec(db, "UPDATE records SET updated_at='2000-01-01T00:00:00.000Z';");
  return { write, read: () => sqliteQuery(db, 'SELECT * FROM records;')[0] };
}
for (const mode of ['timeout', 'local', 'unknown']) test(`real SQL retains separate ${mode} diagnostic and execution evidence exactly`, t => {
  const row = initial(mode), observation = JSON.parse(row.canonical_json).sender_name_verification;
  assert(readSenderNameRouteFailures(observation, binding, AT + 400));
  const f = fixture(t, row), before = f.read(); f.write(record());
  assert.deepEqual(f.read(), before, 'no-query replay keeps all bytes, source fields and update time');
});
const malformed = {
  missing_field: e => { delete e.remote_result; },
  extra_field: e => { e.private = 'invented-forbidden-diagnostic'; },
  numeric_boolean: e => { e.remote_result = 0; },
  fractional_time: e => { e.result_at_ms = AT + 200.5; },
  result_after_local_observation: e => { e.result_at_ms = AT + 301; },
  no_start_with_result: e => { e.execution = 'not_started'; },
  started_without_launch: e => { e.launch_attempted = false; },
  unknown_without_launch: e => { Object.assign(e, { execution: 'unknown', launch_attempted: false,
    result_at_ms: null, result_kind: null }); },
  code_without_remote: e => { e.result_code = 210508; },
  invented_kind: e => { e.result_kind = 'invented-result-kind'; },
};
for (const [label, mutate] of Object.entries(malformed)) test(`JS and real SQL reject ${label} execution receipt on no-query replay`, t => {
  const row = initial(), c = JSON.parse(row.canonical_json);
  mutate(c.sender_name_verification.route_failures.routes[1].failure.execution); row.canonical_json = JSON.stringify(c);
  assert.equal(readSenderNameRouteFailures(c.sender_name_verification, binding, AT + 400), null);
  const f = fixture(t, row); f.write(record());
  assert.equal(JSON.parse(f.read().canonical_json).sender_name_verification, undefined);
  assert.equal(JSON.parse(f.read().canonical_json).sender_name_account_key, undefined);
});

test('invalid-receipt marker cannot also claim a version 2 execution receipt', t => {
  const row = initial(), c = JSON.parse(row.canonical_json);
  c.sender_name_verification.route_failures.routes[1].failure.stage = 'execution_unknown';
  row.canonical_json = JSON.stringify(c);
  assert.equal(readSenderNameRouteFailures(c.sender_name_verification, binding, AT + 400), null);
  const f = fixture(t, row); f.write(record());
  assert.equal(JSON.parse(f.read().canonical_json).sender_name_verification, undefined);
});
