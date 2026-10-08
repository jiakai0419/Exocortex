import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initializeDatabase } from '../dist/storage/sqlite/initialize.js';
import { quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';

// Real public parser and maintenance wiring, with a deliberately failing fake
// executable and fixture-private API coordination. No account or network access.
const harness = fileURLToPath(new URL('./helpers/enrichment-cli.mjs', import.meta.url));
const start = Date.parse('2021-04-06T05:00:00.000Z');
const chat = 'oc_authored_review_cli';
const scope = chatScopeId(chat);
const hash = 'a'.repeat(64);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'exocortex-review-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'authored.sqlite');
  const calls = join(root, 'fake-cli-attempts');
  const cli = join(root, 'fake-lark.mjs');
  const artifact = join(root, 'private-review.json');
  initializeDatabase(db);
  const rows = [
    { id: 1, actor: 'ou_authored_review_peer', direction: 'received' },
    { id: 2, actor: 'ou_authored_review_owner', direction: 'sent' },
  ];
  sqliteExec(db, `UPDATE sources SET config_json=${quoteSql(JSON.stringify({ initial_sync_start_ms: start }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${quoteSql(scope)},'lark.im','Authored CLI review',${quoteSql(JSON.stringify({ chat_id: chat, chat_type: 'group' }))});
    ${rows.map(row => {
      const external = `om_authored_review_${row.id}`;
      const canonical = { sender_id: row.actor, sender_id_type: 'open_id', sender_type: 'user', sender_name: null,
        msg_type: 'text', chat_id: chat, chat_type: 'group' };
      const raw = { message_id: external, chat_id: chat, msg_type: 'text', create_time: String(start + 1000),
        update_time: String(start + 1000), sender: { id: row.actor, id_type: 'open_id', sender_type: 'user' },
        body: { content: '{"text":"Authored CLI review fixture"}' } };
      return `INSERT INTO records(id,source_id,first_seen_scope_id,external_id,external_version,record_type,occurred_at_ms,actor_id,container_id,direction,body,content_hash,canonical_json,raw_json)
        VALUES(${row.id},'lark.im',${quoteSql(scope)},${quoteSql(external)},${quoteSql(String(start + 1000))},'lark.im.message',${start + 1000},${quoteSql(row.actor)},${quoteSql(chat)},${quoteSql(row.direction)},'Authored fixture','authored-hash',${quoteSql(JSON.stringify(canonical))},${quoteSql(JSON.stringify(raw))});`;
    }).join('\n')}`, 'seed authored review CLI fixture');
  writeFileSync(cli, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(calls)}, 'attempt\\n');\nprocess.stderr.write('authored fake CLI denied\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  return { root, db, calls, cli, artifact };
}

function base(f, action) {
  return ['--db', f.db, '--format', 'json', ...(action === 'enrich'
    ? ['--target', 'records', '--names-only', '--record-id', '1']
    : ['--scope-id', scope, '--message-id', 'om_authored_review_1', '--start', new Date(start).toISOString(), '--end', new Date(start + 2000).toISOString()]),
  '--max-cli-attempts', '3', '--max-seconds', '9'];
}
function without(args, option, takesValue = true) {
  const result = [...args], index = result.indexOf(option);
  assert.notEqual(index, -1);
  result.splice(index, takesValue ? 2 : 1);
  return result;
}
function invoke(f, action, args) {
  return spawnSync(process.execPath, [harness, f.root, 'maintenance', action, ...args], {
    env: { ...process.env, LARK_CLI: f.cli }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
  });
}

for (const action of ['enrich', 'replay']) {
  test(`real ${action} parser rejects invalid review combinations before any API, artifact or DB mutation`, async t => {
    const cases = {
      output_with_apply: args => [...args, '--review-out', 'ARTIFACT', '--apply'],
      input_without_apply: args => [...args, '--review-in', 'ARTIFACT', '--review-sha256', hash],
      input_without_hash: args => [...args, '--review-in', 'ARTIFACT', '--apply'],
      hash_without_input: args => [...args, '--review-sha256', hash, '--apply'],
      input_and_output: args => [...args, '--review-in', 'ARTIFACT', '--review-out', 'ARTIFACT', '--review-sha256', hash, '--apply'],
      malformed_hash: args => [...args, '--review-in', 'ARTIFACT', '--review-sha256', 'not-a-sha256', '--apply'],
      empty_hash: args => [...args, '--review-sha256', '', '--apply'],
      empty_hash_with_output: args => [...args, '--review-out', 'ARTIFACT', '--review-sha256', ''],
      empty_input_with_output: args => [...args, '--review-out', 'ARTIFACT', '--review-in', ''],
      empty_hash_without_budgets: args => [...without(without(args, '--max-cli-attempts'), '--max-seconds'), '--review-sha256', '', '--apply'],
      empty_output: args => [...args, '--review-out', ''],
      empty_input: args => [...args, '--review-in', '', '--review-sha256', hash, '--apply'],
      missing_attempt_budget: args => [...without(args, '--max-cli-attempts'), '--review-out', 'ARTIFACT'],
      missing_time_budget: args => [...without(args, '--max-seconds'), '--review-out', 'ARTIFACT'],
      missing_exact_targets: args => [...without(args, action === 'enrich' ? '--record-id' : '--message-id'), '--review-out', 'ARTIFACT'],
      ...(action === 'enrich' ? {
        unsafe_stdout: args => [...args, '--review-out', 'ARTIFACT', '--unsafe-details'],
        non_names_mode: args => [...without(args, '--names-only', false), '--review-out', 'ARTIFACT'],
      } : {
        multiple_scopes: args => [...args, '--scope-id', 'lark.im.received.chat.authored-second', '--review-out', 'ARTIFACT'],
      }),
    };
    for (const [label, make] of Object.entries(cases)) await t.test(label, t => {
      const f = fixture(t), before = readFileSync(f.db);
      const args = make(base(f, action)).map(value => value === 'ARTIFACT' ? f.artifact : value);
      const result = invoke(f, action, args);
      assert.equal(result.error, undefined, label);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /review|--names-only|--record-id|--message-id|exact message replay requires one scope/i);
      assert.doesNotMatch(result.stdout + result.stderr, /ou_authored|oc_authored|om_authored|Authored fixture|authored fake CLI/);
      assert.equal(existsSync(f.calls), false, 'invalid flags must not start even the fake executable');
      assert.equal(existsSync(f.artifact), false, 'invalid flags must not publish a review');
      assert.deepEqual(readFileSync(f.db), before, 'invalid flags must leave the initialized database byte-identical');
    });
  });
  test(`valid ${action} review parameters can reach the isolated fake CLI without a business commit`, t => {
    const f = fixture(t), before = readFileSync(f.db);
    const result = invoke(f, action, [...base(f, action), '--review-out', f.artifact]);
    assert.equal(result.error, undefined, result.stdout + result.stderr);
    assert.ok(existsSync(f.calls), result.stdout + result.stderr);
    assert.ok(readFileSync(f.calls, 'utf8').includes('attempt'));
    assert.ok(existsSync(join(f.root, 'api-state')), 'coordination belongs to the test fixture');
    assert.deepEqual(readFileSync(f.db), before, 'failed synthetic remote work makes no business commit');
    assert.doesNotMatch(result.stdout + result.stderr, /ou_authored|oc_authored|om_authored|Authored fixture|authored fake CLI/);
  });
}
