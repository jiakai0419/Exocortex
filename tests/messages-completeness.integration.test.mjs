import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureInitialized, quoteSql, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { SENT_SCOPE_ID } from '../src/adapters/lark-im/core.mjs';
import { nameTaskKey } from '../src/adapters/lark-im/name-evidence.mjs';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { bindAcquiredMessageAccounts } from '../src/adapters/lark-im/message-account-evidence.mjs';

// Invented from scratch: no saved business records, account, screenshots or
// production database. Exercise the real parser -> SQLite -> projection ->
// terminal path. In particular, never run the worker before the first read.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AT = Date.UTC(2025, 2, 14, 10, 11, 12);
// Keep the already-local lookup fresh even when these historical messages are
// replayed years later; first-read success must not depend on expired work.
const OBSERVED = new Date(Date.now() - 1_000).toISOString();
const CHAT = 'oc_synthetic_completeness_workshop';
const TITLE = 'Invented Completeness Workshop';
const ACCOUNT = recipientAccountKey('ou_synthetic_completeness_owner');
const OTHER_ACCOUNT = recipientAccountKey('ou_synthetic_completeness_other_owner');
const APP = 'cli_synthetic_completeness_lantern';
const HUMAN = 'ou_synthetic_completeness_rowan';
const APP_NAME = 'Invented Lantern';
const HUMAN_NAME = 'Invented Rowan';
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const sql = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : quoteSql(value);

function message(id, { actor = APP, namespace = 'app_id', name = null, offset = 0 } = {}) {
  const external = `om_c${String(id).padStart(4, '0')}_synthetic_completeness`;
  const senderType = namespace === 'app_id' ? 'app' : 'user';
  const body = `Entirely invented message ${id}.`;
  const raw = { message_id: external, chat_id: CHAT, chat_type: 'group', msg_type: 'text',
    create_time: String(AT + offset), update_time: String(AT + offset + 9),
    sender: { id: actor, id_type: namespace, sender_type: senderType, ...(name ? { name } : {}) },
    body: { content: JSON.stringify({ text: body }) } };
  const canonical = { message_id: external, chat_id: CHAT, chat_type: 'group', chat_name: TITLE,
    sender_id: actor, sender_id_type: namespace, sender_type: senderType,
    sender_name: name, sender_name_account_key: ACCOUNT, msg_type: 'text',
    ...(name ? { sender_name_source: 'message_sender' } : {}) };
  return { id, source_id: 'lark.im', first_seen_scope_id: SENT_SCOPE_ID, external_id: external,
    external_version: String(AT + offset + 9), record_type: 'lark.im.message',
    occurred_at: new Date(AT + offset).toISOString(), occurred_at_ms: AT + offset,
    actor_id: actor, container_id: CHAT, direction: 'received', body,
    content_hash: hash(JSON.stringify(raw)), canonical_json: JSON.stringify(canonical), raw_json: JSON.stringify(raw) };
}

function senderTask(row, name) {
  const namespace = JSON.parse(row.canonical_json).sender_id_type;
  const evidence = { schema: 'lark_sender_name_work/v1', source_id: 'lark.im', account_key: ACCOUNT,
    chat_id: row.container_id, actor_id: row.actor_id, namespace, phase: 'resolved',
    observation: { status: 'resolved', reason: 'exact_id_match', name,
      source: namespace === 'app_id' ? 'application_api' : 'chat_member',
      account_key: ACCOUNT, observed_at: OBSERVED, cached: false } };
  return { source_id: 'lark.im', account_key: ACCOUNT,
    task_key: nameTaskKey('sender', row.container_id, row.actor_id, namespace), kind: 'sender',
    chat_id: row.container_id, actor_id: row.actor_id, namespace, outcome: 'resolved',
    latest_record_id: row.id, after_record_id: 0, projection_horizon_record_id: row.id,
    projection_deferred: 1, evidence_json: JSON.stringify(evidence) };
}

function editJson(row, field, change) {
  const value = JSON.parse(row[field]);
  change(value);
  row[field] = JSON.stringify(value);
}

function fixture(t, rows, tasks) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-completeness-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  const marker = join(directory, 'unexpected-network');
  const cli = join(directory, 'reject-network-cli');
  const guard = join(directory, 'reject-network.mjs');
  writeFileSync(cli, '#!/bin/sh\nprintf called > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  writeFileSync(guard, `import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
const reject = () => { writeFileSync(process.env.SYNTHETIC_NETWORK_MARKER, 'called'); throw new Error('synthetic network forbidden'); };
globalThis.fetch = reject;
Socket.prototype.connect = reject;
Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
`);
  ensureInitialized(db);
  for (const [table, entries] of [['records', rows], ['lark_im_name_tasks', tasks]]) {
    for (const entry of entries) {
      const columns = Object.keys(entry);
      sqliteExec(db, `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(key => sql(entry[key])).join(',')});`);
    }
  }
  sqliteExec(db, 'PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  return { directory, db, marker, cli, guard };
}

function snapshot(f) {
  const dump = spawnSync('sqlite3', ['-readonly', f.db, '.dump'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(dump.status, 0, dump.stderr);
  const stat = statSync(f.db);
  return { bytes: hash(readFileSync(f.db)), dump: dump.stdout, modified: stat.mtimeMs,
    mode: stat.mode & 0o777, files: readdirSync(f.directory).sort() };
}

function messages(f, format, limit = 100, extra = []) {
  const env = { ...process.env, TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', NO_COLOR: '1',
    LARK_CLI: f.cli, SYNTHETIC_NETWORK_MARKER: f.marker };
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', f.guard, join(ROOT, 'bin/exocortex.mjs'),
    'messages', '--db', f.db, '--format', format, '--limit', String(limit), ...extra], {
    cwd: f.directory, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(f.marker), false, 'reading cannot call Lark, fetch or a network socket');
  return format === 'json' ? JSON.parse(result.stdout) : result.stdout;
}

function header(row) {
  const time = new Date(row.occurred_at).toLocaleString('en-US', { timeZone: 'UTC' });
  const scene = JSON.parse(row.canonical_json).chat_type === 'p2p' ? '私聊' : '群聊';
  return `${row.direction.toUpperCase()} ${time}  ${row.external_id.slice(0, 8)}...  ${scene}`;
}

// Deliberately independent literal field order/spacing; do not use the product
// renderer, normalize names, or turn a non-ready status into a passing equality.
function readyBlock(row, sender, type = JSON.parse(row.canonical_json).sender_type) {
  return `${header(row)}\n  发送人  ${sender}\n  群      ${TITLE}\n  类型    ${type} / 文本\n  消息    ${row.body}`;
}

function ordered(rows) {
  return [...rows].sort((a, b) => b.occurred_at_ms - a.occurred_at_ms
    || (a.external_id < b.external_id ? 1 : a.external_id > b.external_id ? -1 : 0));
}

function assertPreserved(actual, original, { chat = TITLE, recipient = null } = {}) {
  for (const field of ['id', 'source_id', 'record_type', 'external_id', 'actor_id', 'container_id',
    'direction', 'occurred_at', 'occurred_at_ms', 'body', 'raw_json', 'canonical_json']) {
    assert.equal(actual[field], original[field], `${original.external_id}: ${field}`);
  }
  assert.deepEqual(actual.raw, JSON.parse(original.raw_json));
  assert.deepEqual(actual.canonical, JSON.parse(original.canonical_json));
  assert.equal(actual.display.body, original.body);
  assert.equal(actual.display.chat, chat);
  assert.equal(actual.display.recipient, recipient, 'the destination must match the type-specific expected relationship');
}

test('current acquisition ownership can use exact local title and mode evidence on the first CLI read', t => {
  let row=message(90,{actor:HUMAN,namespace:'open_id',name:HUMAN_NAME});
  editJson(row,'canonical_json',value=>{delete value.chat_name;delete value.chat_type;delete value.sender_name_account_key;});
  editJson(row,'raw_json',value=>{delete value.chat_type;});
  row.content_hash=hash(row.raw_json);
  [row]=bindAcquiredMessageAccounts([row],{open_id:'ou_synthetic_completeness_owner'},{acquiredAt:OBSERVED});
  assert(JSON.parse(row.canonical_json).message_account_evidence);
  const task={source_id:'lark.im',account_key:ACCOUNT,task_key:nameTaskKey('chat',CHAT),kind:'chat',
    chat_id:CHAT,actor_id:'',namespace:'',outcome:'resolved',latest_record_id:row.id,
    evidence_json:JSON.stringify({schema:'lark_current_chat_name/v1',source_id:'lark.im',account_key:ACCOUNT,
      chat_id:CHAT,authority:'im.chats.get',chat_type:'group',name:TITLE,observed_at:OBSERVED})};
  const f=fixture(t,[row],[task]),before=snapshot(f);
  const [result]=messages(f,'json');
  assert.equal(result.display.chat,TITLE);assert.equal(result.display.sender,HUMAN_NAME);
  assert.equal(result.readiness.state,'ready');assert.deepEqual(result.readiness.reasons,[]);
  assertPreserved(result,row);assert.match(messages(f,'text'),/Invented Completeness Workshop/);
  assert.deepEqual(snapshot(f),before);
  // The same validated current group response cannot override an explicit
  // private declaration in the source. No name-only fallback may make it ready.
  const conflict={...row};
  editJson(conflict,'canonical_json',value=>{value.chat_type='p2p';});
  const other=fixture(t,[conflict],[task]);
  const [rejected]=messages(other,'json');
  assert.notEqual(rejected.readiness.state,'ready');
  assert(rejected.readiness.reasons.includes('conversation_type_unknown'));
});

test('first real CLI read uses exact local app/human evidence before deferred row projection, retaining adjacent messages and layout', t => {
  const rows = [
    message(1, { actor: 'ou_synthetic_completeness_alder', namespace: 'open_id', name: 'Invented Alder', offset: -30_000 }),
    message(2, { actor: HUMAN, namespace: 'open_id', offset: -10_000 }),
    message(3, { actor: 'ou_synthetic_completeness_birch', namespace: 'open_id', name: 'Invented Birch', offset: -10_000 }),
    message(4),
  ];
  const tasks = [senderTask(rows[1], HUMAN_NAME), senderTask(rows[3], APP_NAME)];
  const f = fixture(t, rows, tasks), before = snapshot(f);
  const expected = ordered(rows);
  const names = new Map([[1, 'Invented Alder'], [2, HUMAN_NAME], [3, 'Invented Birch'], [4, `应用：${APP_NAME}`]]);
  const json = messages(f, 'json');
  assert.deepEqual(json.map(row => row.id), [4, 3, 2, 1], 'time then external ID order includes the tied adjacent message');
  assert.equal(json.length, rows.length, 'selected record count is conserved');
  for (const [index, row] of json.entries()) {
    assertPreserved(row, expected[index]);
    assert.equal(row.display.sender, names.get(row.id), 'actual names are compared unconditionally');
    assert.equal(row.readiness.state, 'ready', JSON.stringify(row.readiness));
    assert.deepEqual(row.readiness.reasons, []);
    assert.equal(row.readiness.next_action, 'none');
    assert.equal(row.readiness.requirements.find(item => item.field === 'sender').state, 'satisfied');
  }
  for (const id of [2, 4]) {
    const row = json.find(value => value.id === id);
    assert.equal(row.canonical.sender_name, null, 'first display cannot depend on a prior writeback');
    const observation = JSON.parse(tasks.find(task => task.actor_id === row.actor_id).evidence_json).observation;
    assert.equal(row.display.sender, `${id === 4 ? '应用：' : ''}${observation.name}`);
    assert.equal(row.readiness.requirements.find(item => item.field === 'sender').evidence, observation.source);
  }
  const text = messages(f, 'text');
  assert.equal(text, `Messages (4)\n\n${expected.map(row => readyBlock(row, names.get(row.id))).join('\n\n')}\n`);
  assert.deepEqual(messages(f, 'json', 1), [json[0]], 'latest selected row is complete on its first read too');
  assert.equal(messages(f, 'text', 1), `Messages (1)\n\n${readyBlock(rows[3], `应用：${APP_NAME}`)}\n`);
  const filtered = messages(f, 'json', 100, ['--search', rows[1].body]);
  assert.deepEqual(filtered, [json[2]], 'search filters the original body and keeps the exact projection');
  assert.deepEqual(messages(f, 'json'), json, 'repeated reads/restarts preserve the first result');
  assert.deepEqual(snapshot(f), before, 'bytes, records, task progress, clocks, hash/version and directory remain unchanged');
});

const invalidEvidence = [
  ['task belongs to another account', (row, task) => {
    task.account_key = OTHER_ACCOUNT;
    editJson(task, 'evidence_json', value => { value.account_key = OTHER_ACCOUNT; value.observation.account_key = OTHER_ACCOUNT; });
  }],
  ['envelope belongs to another account', (row, task) => {
    editJson(task, 'evidence_json', value => { value.account_key = OTHER_ACCOUNT; });
  }],
  ['observation belongs to another account', (row, task) => {
    editJson(task, 'evidence_json', value => { value.observation.account_key = OTHER_ACCOUNT; });
  }],
  ['task belongs to another actor', (row, task) => {
    task.actor_id = 'cli_synthetic_completeness_other_app';
    task.task_key = nameTaskKey('sender', CHAT, task.actor_id, task.namespace);
    editJson(task, 'evidence_json', value => { value.actor_id = task.actor_id; });
  }],
  ['envelope belongs to another actor', (row, task) => {
    editJson(task, 'evidence_json', value => { value.actor_id = 'cli_synthetic_completeness_other_app'; });
  }],
  ['same actor bytes in another task namespace', (row, task) => {
    task.namespace = 'open_id';
    task.task_key = nameTaskKey('sender', CHAT, task.actor_id, task.namespace);
    editJson(task, 'evidence_json', value => { value.namespace = 'open_id'; value.observation.source = 'chat_member'; });
  }],
  ['same actor bytes in another envelope namespace', (row, task) => {
    editJson(task, 'evidence_json', value => { value.namespace = 'open_id'; });
  }],
  ['task belongs to another conversation', (row, task) => {
    task.chat_id = 'oc_synthetic_completeness_elsewhere';
    task.task_key = nameTaskKey('sender', task.chat_id, task.actor_id, task.namespace);
    editJson(task, 'evidence_json', value => { value.chat_id = task.chat_id; });
  }],
  ['a resolved outcome without a resolved observation', (row, task) => {
    editJson(task, 'evidence_json', value => { value.observation.status = 'failed'; });
  }],
  ['an unbound sole bot is not exact app authority', (row, task) => {
    editJson(task, 'evidence_json', value => { value.observation.source = 'chat_bot_unique'; });
  }],
  ['duplicate envelope account key cannot win by appearing last', (row, task) => {
    task.evidence_json = task.evidence_json.replace('"account_key":', `"account_key":"${OTHER_ACCOUNT}","account_key":`);
  }],
  ['duplicate observation name cannot win by appearing last', (row, task) => {
    task.evidence_json = task.evidence_json.replace('"name":', '"name":"Invented Rejected Name","name":');
  }],
  ['escaped duplicate actor key cannot win by appearing last', (row, task) => {
    task.evidence_json = task.evidence_json.replace('"actor_id":', '"actor\\u005fid":"cli_synthetic_wrong_actor","actor_id":');
  }],
  ['canonical explicit clear overrides otherwise exact local evidence', row => {
    editJson(row, 'canonical_json', value => { value.sender_name_state = 'cleared'; });
  }, 'blocked', 'name_explicitly_cleared'],
  ['native explicit clear overrides otherwise exact local evidence', row => {
    editJson(row, 'raw_json', value => { value.sender.name_state = 'cleared'; });
  }, 'blocked', 'name_explicitly_cleared'],
  ['conflicting record account markers cannot adopt local evidence', row => {
    editJson(row, 'canonical_json', value => { value.chat_name_account_key = OTHER_ACCOUNT; });
  }, 'blocked', 'account_conflict'],
  ['record actor disagreement cannot adopt local evidence', row => {
    row.actor_id = 'cli_synthetic_completeness_conflicting_record';
  }, 'blocked', 'sender_identity_conflict'],
  ['record namespace disagreement cannot adopt local evidence', row => {
    editJson(row, 'canonical_json', value => { value.sender_id_type = 'open_id'; });
  }, 'blocked', 'sender_identity_conflict'],
  ['two task rows with the same evidence identity are ambiguous', (row, task, tasks) => {
    tasks.push({ ...clone(task), task_key: nameTaskKey('sender', CHAT, 'cli_synthetic_ambiguous_task_key', 'app_id') });
  }],
];

test('real CLI rejects invalid local authority and retains a non-ready latest row instead of filling limit from older ready rows', async t => {
  for (const [label, change, state = 'enriching', reason = 'sender_name_missing'] of invalidEvidence) {
    await t.test(label, t => {
      const oldest = message(1, { actor: 'ou_synthetic_completeness_older', namespace: 'open_id', name: 'Invented Older Neighbour', offset: -20_000 });
      const adjacent = message(2, { actor: 'ou_synthetic_completeness_adjacent', namespace: 'open_id', name: 'Invented Adjacent Neighbour', offset: -10_000 });
      const target = message(3), task = senderTask(target, APP_NAME), tasks = [task];
      change(target, task, tasks);
      const f = fixture(t, [oldest, adjacent, target], tasks), before = snapshot(f);
      const json = messages(f, 'json', 1);
      assert.equal(json.length, 1);
      assert.equal(json[0].id, target.id, 'latest incomplete record must never be silently replaced by an older ready row');
      assertPreserved(json[0], target);
      assert.notEqual(json[0].display.sender, `应用：${APP_NAME}`, 'rejected authority cannot supply the actual label');
      assert.equal(json[0].readiness.state, state, JSON.stringify(json[0].readiness));
      assert.ok(json[0].readiness.reasons.includes(reason), JSON.stringify(json[0].readiness));
      const text = messages(f, 'text', 1);
      assert.ok(text.startsWith(`Messages (1)\n完整 0 · 待补全 ${state === 'enriching' ? 1 : 0} · 受阻 ${state === 'blocked' ? 1 : 0}\n\n`));
      assert.ok(text.includes(`${header(target)}\n`), 'exception keeps the same identity and event-time header');
      assert.ok(text.includes(`  状态    ${state === 'blocked' ? '准备受阻' : '等待完整信息'}\n`));
      assert.ok(text.includes('  原因    '));
      assert.ok(text.includes('  查看    messages --format json 可检查已保存内容与原因'));
      assert.doesNotMatch(text, /(?:^|\n)  发送人  |Invented Lantern|Invented Rejected Name|Invented Older Neighbour|Invented Adjacent Neighbour/);
      const page = messages(f, 'json', 3);
      assert.deepEqual(page.map(row => row.id), [3, 2, 1], 'count and position remain stable alongside ready neighbours');
      assert.deepEqual(page[0], json[0]);
      for (const [index, original, name] of [[1, adjacent, 'Invented Adjacent Neighbour'], [2, oldest, 'Invented Older Neighbour']]) {
        assertPreserved(page[index], original);
        assert.equal(page[index].readiness.state, 'ready');
        assert.equal(page[index].display.sender, name);
      }
      assert.equal(page.filter(row => row.readiness.state === 'ready').length, 2);
      assert.equal(page.filter(row => row.readiness.state === state).length, 1);
      const fullText = messages(f, 'text', 3);
      assert.ok(fullText.startsWith(`Messages (3)\n完整 2 · 待补全 ${state === 'enriching' ? 1 : 0} · 受阻 ${state === 'blocked' ? 1 : 0}\n\n${header(target)}\n`));
      assert.ok(fullText.endsWith(`${readyBlock(adjacent, 'Invented Adjacent Neighbour')}\n\n${readyBlock(oldest, 'Invented Older Neighbour')}\n`), 'ready neighbours keep exact names, body, time, field order and spacing');
      assert.deepEqual(snapshot(f), before, 'negative reads cannot mutate evidence, records or database files');
    });
  }
});

test('real CLI cannot borrow a conversation account marker to certify an adopted sender name', async t => {
  for (const namespace of ['open_id', 'app_id']) for (const accountSlot of ['absent', 'null']) {
    await t.test(`${namespace} with ${accountSlot} sender account proof`, t => {
      const row = message(1, { actor: namespace === 'app_id' ? APP : HUMAN, namespace });
      editJson(row, 'canonical_json', canonical => {
        canonical.sender_name = namespace === 'app_id' ? APP_NAME : HUMAN_NAME;
        canonical.sender_name_source = namespace === 'app_id' ? 'application_api' : 'contact';
        canonical.sender_name_confidence = 'high';
        canonical.chat_name_account_key = ACCOUNT;
        if (accountSlot === 'null') canonical.sender_name_account_key = null;
        else delete canonical.sender_name_account_key;
      });
      const f = fixture(t, [row], []), before = snapshot(f);
      const [actual] = messages(f, 'json', 1), text = messages(f, 'text', 1);
      assertPreserved(actual, row);
      assert.equal(Object.hasOwn(actual.raw.sender, 'name'), false, 'the native source cannot independently prove the adopted name');
      assert.deepEqual(snapshot(f), before);
      assert.equal(actual.readiness.state, 'enriching', JSON.stringify({ readiness: actual.readiness, text }));
      assert.ok(actual.readiness.reasons.includes('sender_name_unverified'), JSON.stringify(actual.readiness));
      assert.equal(actual.readiness.requirements.find(item => item.field === 'sender').state, 'missing');
      assert.ok(text.includes(`${header(row)}\n  状态    等待完整信息\n`));
      assert.ok(text.includes('发送人名称待核验'));
      assert.doesNotMatch(text, /(?:^|\n)  发送人  |Invented Lantern|Invented Rowan/);
    });
  }
});

test('real CLI uses explicit human identity instead of an app-looking ID prefix when canonical sender type is absent', async t => {
  for (const namespace of ['open_id', 'user_id', 'union_id']) {
    await t.test(namespace, t => {
      const name = 'Invented Typed Human';
      const row = message(1, { actor: 'cli_synthetic_human_not_an_application', namespace, name });
      editJson(row, 'canonical_json', canonical => { delete canonical.sender_type; });
      const f = fixture(t, [row], []), before = snapshot(f);
      const [actual] = messages(f, 'json', 1), text = messages(f, 'text', 1);
      assertPreserved(actual, row);
      assert.equal(actual.raw.sender.id_type, namespace);
      assert.equal(actual.raw.sender.sender_type, 'user');
      assert.equal(Object.hasOwn(actual.canonical, 'sender_type'), false);
      assert.deepEqual(snapshot(f), before);
      assert.equal(actual.readiness.state, 'ready', JSON.stringify(actual.readiness));
      assert.equal(actual.display.sender_type, 'user', JSON.stringify({ display: actual.display, text }));
      assert.equal(actual.display.sender, name, 'a typed human must not acquire an application label from ID spelling');
      assert.equal(text, `Messages (1)\n\n${readyBlock(row, name, 'user')}\n`);
      assert.doesNotMatch(text, /应用：|app \/ 文本/);
    });
  }
});

test('real CLI refuses explicit system actor kinds that contradict a typed human or application', async t => {
  for (const namespace of ['open_id', 'app_id']) for (const location of ['canonical', 'native']) {
    await t.test(`${namespace} with ${location} system kind`, t => {
      const row = message(1, { actor: namespace === 'app_id' ? APP : HUMAN, namespace, name: 'Invented Typed Sender' });
      if (location === 'canonical') editJson(row, 'canonical_json', canonical => { canonical.sender_type = 'system'; });
      else editJson(row, 'raw_json', raw => { raw.sender.sender_type = 'system'; });
      const f = fixture(t, [row], []), before = snapshot(f);
      const [actual] = messages(f, 'json'), text = messages(f, 'text');
      assertPreserved(actual, row);
      assert.deepEqual(snapshot(f), before);
      assert.equal(actual.readiness.state, 'blocked', JSON.stringify({ readiness: actual.readiness, text }));
      assert.ok(actual.readiness.reasons.includes('sender_identity_conflict'));
      assert.ok(text.includes('发送人身份冲突'));
      assert.doesNotMatch(text, /(?:^|\n)  发送人  |Invented Typed Sender/);
    });
  }
});

test('real CLI refuses conflicting sender aliases even when wrapper and native primary identity agree', async t => {
  for (const aliasType of ['user_id', 'union_id']) for (const nested of [false, true]) {
    await t.test(`${aliasType} ${nested ? 'nested' : 'direct'} alias`, t => {
      const row = message(1, { actor: HUMAN, namespace: 'open_id', name: HUMAN_NAME });
      const native = JSON.parse(row.raw_json);
      native.sender[aliasType] = 'synthetic_native_sender_alias';
      const outer = { id: HUMAN, id_type: 'open_id', sender_type: 'user',
        ...(nested ? { sender_id: { [aliasType]: 'synthetic_wrapper_sender_alias' } }
          : { [aliasType]: 'synthetic_wrapper_sender_alias' }) };
      row.raw_json = JSON.stringify({ raw_api: native, sender: outer });
      const f = fixture(t, [row], []), before = snapshot(f);
      const [actual] = messages(f, 'json'), text = messages(f, 'text');
      assertPreserved(actual, row);
      assert.deepEqual(snapshot(f), before);
      assert.equal(actual.readiness.state, 'blocked', JSON.stringify({ readiness: actual.readiness, text }));
      assert.ok(actual.readiness.reasons.includes('sender_identity_conflict'));
      assert.ok(text.includes('发送人身份冲突'));
      assert.doesNotMatch(text, /(?:^|\n)  发送人  |Invented Rowan/);
    });
  }
});

function privateMessage() {
  const row = message(1, { actor: 'ou_synthetic_completeness_owner', namespace: 'open_id', name: 'Invented Own Sender' });
  row.direction = 'sent';
  editJson(row, 'canonical_json', canonical => { canonical.chat_type = 'p2p'; });
  editJson(row, 'raw_json', raw => { raw.chat_type = 'p2p'; });
  return row;
}

function assertRecipientConflict(t, row) {
  const f = fixture(t, [row], []), before = snapshot(f);
  const [actual] = messages(f, 'json'), text = messages(f, 'text');
  assertPreserved(actual, row, { chat: null, recipient: '未知' });
  assert.deepEqual(snapshot(f), before);
  assert.equal(actual.readiness.state, 'blocked', JSON.stringify({ readiness: actual.readiness, text }));
  assert.ok(actual.readiness.reasons.includes('recipient_identity_conflict'));
  assert.ok(text.includes(`${header(row)}\n  状态    准备受阻\n`));
  assert.ok(text.includes('接收人身份冲突'));
  assert.doesNotMatch(text, /(?:^|\n)  接收人  |Invented Contradictory Partner|Invented Outer Peer|Invented Native Peer/);
}

test('real CLI never turns an application or system partner into a person from its open ID', async t => {
  for (const field of ['sender_type', 'type']) for (const kind of ['app', 'system']) {
    await t.test(`${field}=${kind}`, t => {
      const row = privateMessage();
      const partner = { id: 'ou_synthetic_completeness_peer', id_type: 'open_id',
        [field]: kind, name: 'Invented Contradictory Partner' };
      editJson(row, 'canonical_json', canonical => { canonical.chat_partner = partner; });
      editJson(row, 'raw_json', raw => { raw.chat_partner = partner; });
      assertRecipientConflict(t, row);
    });
  }
  await t.test('an explicit app alias is not a person alias', t => {
    const row = privateMessage();
    editJson(row, 'raw_json', raw => { raw.chat_partner = { open_id: 'ou_synthetic_completeness_peer',
      app_id: 'cli_synthetic_completeness_partner_app', name: 'Invented Contradictory Partner' }; });
    assertRecipientConflict(t, row);
  });
});

test('real CLI refuses conflicting typed partner aliases across canonical, wrapper and native declarations', async t => {
  for (const aliasType of ['user_id', 'union_id']) for (const location of ['canonical', 'wrapper', 'nested_wrapper']) {
    await t.test(`${aliasType} in ${location}`, t => {
      const row = privateMessage(), peer = 'ou_synthetic_completeness_peer';
      const native = JSON.parse(row.raw_json);
      native.chat_partner = { open_id: peer, [aliasType]: 'synthetic_native_partner_alias', name: 'Invented Native Peer' };
      const outer = { open_id: peer, name: 'Invented Outer Peer',
        ...(location === 'nested_wrapper' ? { sender_id: { [aliasType]: 'synthetic_outer_partner_alias' } }
          : { [aliasType]: 'synthetic_outer_partner_alias' }) };
      if (location === 'canonical') {
        editJson(row, 'canonical_json', canonical => { canonical.chat_partner = outer; });
        row.raw_json = JSON.stringify(native);
      } else row.raw_json = JSON.stringify({ raw_api: native, chat_partner: outer });
      assertRecipientConflict(t, row);
    });
  }
});

test('real CLI keeps compatible partner alias additions and the narrow legacy user-ID projection', async t => {
  const cases = [
    ['compatible alias addition', { open_id: 'ou_synthetic_completeness_peer', name: 'Invented Native Peer' },
      { open_id: 'ou_synthetic_completeness_peer', user_id: 'synthetic_added_partner_alias', name: 'Invented Native Peer' }],
    ['compatible nested aliases', { open_id: 'ou_synthetic_completeness_peer', user_id: 'synthetic_shared_partner_alias', name: 'Invented Native Peer' },
      { open_id: 'ou_synthetic_completeness_peer', sender_id: { user_id: 'synthetic_shared_partner_alias' }, name: 'Invented Native Peer' }],
    ['legacy non-open-looking user ID', { open_id: 'synthetic_legacy_partner_user', name: 'Invented Old Projection' },
      { user_id: 'synthetic_legacy_partner_user', name: 'Invented Native Peer' }],
  ];
  for (const [label, canonicalPartner, nativePartner] of cases) await t.test(label, t => {
    const row = privateMessage();
    editJson(row, 'canonical_json', canonical => { canonical.chat_partner = canonicalPartner; });
    editJson(row, 'raw_json', raw => { raw.chat_partner = nativePartner; });
    const f = fixture(t, [row], []), before = snapshot(f);
    const [actual] = messages(f, 'json'), text = messages(f, 'text');
    assertPreserved(actual, row, { chat: null, recipient: 'Invented Native Peer' });
    assert.deepEqual(snapshot(f), before);
    assert.equal(actual.readiness.state, 'ready', JSON.stringify(actual.readiness));
    assert.equal(text, `Messages (1)\n\n${header(row)}\n  发送人  Invented Own Sender\n  接收人  Invented Native Peer\n  类型    user / 文本\n  消息    ${row.body}\n`);
  });
});

test('real CLI preserves a real application name that itself begins with the word application', t => {
  const name = '应用 Invented Courier';
  const row = message(1, { name });
  const f = fixture(t, [row], []), before = snapshot(f);
  const [actual] = messages(f, 'json'), text = messages(f, 'text');
  assertPreserved(actual, row);
  assert.deepEqual(snapshot(f), before);
  assert.equal(actual.readiness.state, 'ready', JSON.stringify(actual.readiness));
  assert.equal(actual.display.sender, `应用：${name}`, JSON.stringify({ display: actual.display, text }));
  assert.equal(text, `Messages (1)\n\n${readyBlock(row, `应用：${name}`)}\n`);
});
