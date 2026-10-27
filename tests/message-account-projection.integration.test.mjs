import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { quoteSql, sqliteExec } from '../dist/storage/sqlite/sqlite-executor.js';
import { retainMessageAccountEvidenceSql } from '../dist/storage/sqlite/message-account-projection.js';
import { mergeLarkNameProjectionSql } from '../dist/storage/sqlite/lark-name-projection.js';
import { ensureInitialized, upsertRecordsSql, sqliteQuery, createRun, readScope, succeedRecordRun }
  from '../dist/storage/sqlite/ingestion-store.js';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { recordFromMessage } from '../src/adapters/lark-im/message-record.mjs';
import { bindAcquiredMessageAccounts, readMessageAccountEvidence } from '../src/adapters/lark-im/message-account-evidence.mjs';
import { chatScopeId, cursorAfter } from '../src/adapters/lark-im/core.mjs';

// All source bytes, identifiers, account hashes and clocks are invented here.
// These tests execute the generated expression in actual SQLite, without the
// caller's ingestion or network code; main integrates that hook separately.
const ACCOUNT = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const ACQUIRED = '2025-04-03T02:01:00.123Z';
const RAW = '{ "message_id":"om_synthetic_account_replay", "chat_id":"oc_synthetic_account_room",'
  + ' "sender":{"id":"ou_synthetic_actor","id_type":"open_id"},'
  + ' "body":{"text":"Invented raw bytes with } and \\\"quotes\\\"."}, "precision":9007199254740993 }';
const hash = value => createHash('sha256').update(value).digest('hex');
const MEMBER = 'message_account_evidence';
const proof = { schema: 'lark_message_acquisition/v1', source_id: 'lark.im', account_key: ACCOUNT,
  external_id: 'om_synthetic_account_replay', container_id: 'oc_synthetic_account_room',
  source_hash: hash(RAW), source_version: '9007199254740993001', acquired_at: ACQUIRED };
const PROOF_TEXT = JSON.stringify(proof, null, 2).replace('"account_key"', '"account_\\u006bey"');
const CORE = '"message_id":"om_synthetic_account_replay","chat_id":"oc_synthetic_account_room",'
  + '"sender_id":"ou_synthetic_actor","precision":9007199254740993,"unseen":{"value":1.234567890123456789},'
  + '"text":"Invented Unicode: 树与星; braces } {; quote \\\"."';
const canonical = `{${CORE},"${MEMBER}":${PROOF_TEXT}}`;
const withoutProof = `{${CORE}}`;
const row = () => ({ source_id: 'lark.im', record_type: 'lark.im.message',
  external_id: proof.external_id, actor_id: 'ou_synthetic_actor', container_id: proof.container_id,
  raw_json: RAW, content_hash: proof.source_hash, external_version: proof.source_version,
  canonical_json: canonical, body: 'Entirely invented body.', title: null, direction: 'received',
  occurred_at: '2025-04-03T02:00:59.000Z', occurred_at_ms: '1743645659000',
  updated_at: '2025-04-03T02:01:00.456Z' });
const sql = value => value === null ? 'NULL' : quoteSql(value);
const append = (json, key, value) => `${json.trimEnd().slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify(value)}}`;
const replaceProof = (record, value) => { record.canonical_json = `{${CORE},"${MEMBER}":${JSON.stringify(value)}}`; };

function fixture(t, mutate = () => {}, merged = null) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-account-retention-synthetic-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite');
  const existing = row(), incoming = { ...row(), canonical_json: withoutProof };
  mutate(existing, incoming);
  const columns = Object.keys(existing);
  sqliteExec(db, ['existing', 'incoming'].map(table => `CREATE TABLE ${table}(${columns.map(column => `${column} TEXT`).join(',')});`).join('\n'));
  for (const [table, record] of [['existing', existing], ['incoming', incoming]]) {
    sqliteExec(db, `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(column => sql(record[column])).join(',')});`);
  }
  const expression = retainMessageAccountEvidenceSql('e', 'i', typeof merged === 'function' ? merged()
    : merged === null ? 'i.canonical_json' : quoteSql(merged));
  const before = hash(readFileSync(db));
  const result = spawnSync('sqlite3', ['-readonly', '-json', db,
    `SELECT ${expression} AS canonical FROM existing e CROSS JOIN incoming i;`], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(hash(readFileSync(db)), before, 'the expression cannot write source/body/clocks or either record');
  return { value: JSON.parse(result.stdout)[0].canonical, existing, incoming };
}

test('same-source replay retains the original account proof and exact canonical bytes without renewing its clock', t => {
  const f = fixture(t);
  assert.equal(f.value, canonical);
  assert.ok(f.value.includes(PROOF_TEXT), 'proof whitespace and escaped key spelling are preserved');
  assert.equal(JSON.parse(f.value)[MEMBER].acquired_at, ACQUIRED);
  assert.equal(Object.hasOwn(JSON.parse(f.incoming.canonical_json), MEMBER), false);
});

test('only the missing member is inserted into the actual merged canonical, retaining unknown numeric tokens and all other bytes', t => {
  const merged = ` \n{${CORE}, "new_unknown":9223372036854775808123456789 } \n\t`;
  const f = fixture(t, undefined, merged);
  const brace = merged.lastIndexOf('}');
  const expected = `${merged.slice(0, brace)},"${MEMBER}":${PROOF_TEXT}${merged.slice(brace)}`;
  assert.equal(f.value, expected);
  assert.ok(f.value.includes('9223372036854775808123456789'));
  assert.ok(f.value.includes('1.234567890123456789'));
});

test('proof extraction ignores nested lookalike keys, strings, braces, escapes and non-ASCII byte lengths', t => {
  const lookalike = JSON.stringify({ nested: { [MEMBER]: { account_key: OTHER } },
    lookalike_text: `Invented 中文 ${MEMBER} { "quoted" } \\` }).slice(1, -1);
  const f = fixture(t, (old, incoming) => {
    old.canonical_json = `{${lookalike},"${MEMBER}":${PROOF_TEXT},${CORE}}`;
    incoming.canonical_json = `{${lookalike},${CORE},"added":"invented"}`;
  });
  assert.equal(f.value, `${f.incoming.canonical_json.slice(0, -1)},"${MEMBER}":${PROOF_TEXT}}`);
});

for (const position of ['first', 'middle', 'escaped root key']) {
  test(`equivalent replay preserves old byte order when proof is ${position}`, t => {
    const f = fixture(t, old => {
      old.canonical_json = position === 'first' ? `{"${MEMBER}":${PROOF_TEXT},${CORE}}`
        : position === 'middle' ? `{"${MEMBER}":${PROOF_TEXT}, "middle":true,${CORE}}`
        : `{"message_account_\\u0065vidence":${PROOF_TEXT},${CORE}}`;
    }, position === 'middle' ? `{${CORE},"middle":true}` : withoutProof);
    assert.equal(f.value, f.existing.canonical_json);
  });
}

test('null source version is retained exactly; numeric or differently spelled version never matches', t => {
  const f = fixture(t, (old, incoming) => {
    old.external_version = incoming.external_version = null;
    replaceProof(old, { ...proof, source_version: null });
  });
  assert.equal(f.value, f.existing.canonical_json);
});

for (const marker of ['sender_name_account_key', 'chat_name_account_key', 'sender_name_verification']) {
  test(`compatible ${marker} on either side does not prevent exact inheritance`, t => {
    const f = fixture(t, (old, incoming) => {
      const value = marker === 'sender_name_verification' ? { account_key: ACCOUNT, status: 'failed' } : ACCOUNT;
      old.canonical_json = append(old.canonical_json, marker, value);
      incoming.canonical_json = append(incoming.canonical_json, marker, value);
    });
    assert.equal(f.value, f.existing.canonical_json);
  });
}

test('cheap absent-proof and present-incoming paths return merged bytes without requiring usable raw documents', t => {
  const f = fixture(t, (old, incoming) => {
    old.canonical_json = withoutProof;
    old.raw_json = incoming.raw_json = '{ malformed deliberately';
  });
  assert.equal(f.value, withoutProof);
});

for (const value of [null, {}, { ...proof, acquired_at: '2025-05-06T07:08:09.000Z' }]) {
  test(`present incoming proof ${value === null ? 'null' : Object.keys(value).length ? 'new valid observation' : 'empty object'} is not replaced from an unusable predecessor`, t => {
    const f = fixture(t, (old, incoming) => {
      replaceProof(incoming, value);
      old.raw_json = '{ malformed predecessor need not be visited';
    });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

const changedColumns = ['source_id', 'record_type', 'external_id', 'actor_id', 'container_id',
  'raw_json', 'content_hash', 'external_version'];
for (const column of changedColumns) {
  test(`a changed ${column} cannot inherit acquisition ownership`, t => {
    const f = fixture(t, (_old, incoming) => {
      incoming[column] = column === 'raw_json' ? `${RAW} ` : column === 'content_hash' ? 'c'.repeat(64) : 'synthetic-changed';
    });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

const invalidProofs = [
  ['missing account', value => { delete value.account_key; }],
  ['null account', value => { value.account_key = null; }],
  ['numeric account', value => { value.account_key = 123; }],
  ['uppercase account', value => { value.account_key = 'A'.repeat(64); }],
  ['short account', value => { value.account_key = 'a'.repeat(63); }],
  ['unknown schema', value => { value.schema = 'invented_schema/v1'; }],
  ['foreign source', value => { value.source_id = 'invented.other'; }],
  ['other message', value => { value.external_id = 'om_synthetic_other'; }],
  ['other chat', value => { value.container_id = 'oc_synthetic_other'; }],
  ['other source hash', value => { value.source_hash = OTHER; }],
  ['other version', value => { value.source_version = 'different-version'; }],
  ['numeric version', value => { value.source_version = 42; }],
  ['missing version', value => { delete value.source_version; }],
  ['unexpected proof field', value => { value.surprise = true; }],
  ['missing acquisition time', value => { delete value.acquired_at; }],
  ['noncanonical time', value => { value.acquired_at = '2025-04-03'; }],
  ['impossible day', value => { value.acquired_at = '2025-02-31T02:01:00.123Z'; }],
  ['pre-epoch time', value => { value.acquired_at = '1969-01-01T00:00:00.000Z'; }],
  ['future time', value => { value.acquired_at = '2999-01-01T00:00:00.000Z'; }],
];
for (const [label, change] of invalidProofs) {
  test(`invalid old proof cannot donate: ${label}`, t => {
    const f = fixture(t, old => { const value = structuredClone(proof); change(value); replaceProof(old, value); });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

for (const side of ['old', 'incoming', 'merged']) {
  for (const [label, marker] of [['sender', 'sender_name_account_key'], ['title', 'chat_name_account_key'],
    ['verification', 'sender_name_verification']]) {
    for (const value of [OTHER, null]) {
      test(`${side} ${label} account ${value === null ? 'null' : 'conflict'} prevents inheritance`, t => {
        const add = document => append(document, marker, marker === 'sender_name_verification' ? { account_key: value } : value);
        const f = fixture(t, (old, incoming) => {
          if (side === 'old') old.canonical_json = add(old.canonical_json);
          if (side === 'incoming') incoming.canonical_json = add(incoming.canonical_json);
        }, side === 'merged' ? add(withoutProof) : null);
        assert.equal(f.value, side === 'merged' ? add(withoutProof) : f.incoming.canonical_json);
      });
    }
  }
}

const duplicates = [
  ['old proof key', old => { old.canonical_json = old.canonical_json.replace(PROOF_TEXT, PROOF_TEXT.replace(
    '"source_id": "lark.im"', '"source_id":"invented.other","source_id": "lark.im"')); }],
  ['old root proof', old => { old.canonical_json = append(old.canonical_json, MEMBER, proof); }],
  ['incoming account', (_old, incoming) => { incoming.canonical_json = append(append(incoming.canonical_json,
    'sender_name_account_key', OTHER), 'sender_name_account_key', ACCOUNT); }],
  ['incoming escaped account', (_old, incoming) => { incoming.canonical_json = append(incoming.canonical_json,
    'sender_name_account_key', OTHER).slice(0, -1) + `,"sender_name_account_\\u006bey":"${ACCOUNT}"}`; }],
  ['old unrelated duplicate', old => { old.canonical_json = append(append(old.canonical_json, 'unknown', 1), 'unknown', 2); }],
  ['incoming nested duplicate', (_old, incoming) => { incoming.canonical_json = incoming.canonical_json.slice(0, -1)
    + ',"nested":{"same":1,"same":2}}'; }],
  ['raw nested duplicate', (old, incoming) => {
    old.raw_json = incoming.raw_json = '{"sender":{"id":"one","id":"two"}}';
    old.content_hash = incoming.content_hash = hash(old.raw_json);
    replaceProof(old, { ...proof, source_hash: old.content_hash });
  }],
];
for (const [label, change] of duplicates) {
  test(`duplicate JSON keys cannot authorize inheritance: ${label}`, t => {
    const f = fixture(t, change);
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

for (const field of ['canonical_json', 'raw_json']) for (const side of ['old', 'incoming']) {
  test(`malformed ${side} ${field} returns the proposed bytes without manufacturing proof`, t => {
    const f = fixture(t, (old, incoming) => { (side === 'old' ? old : incoming)[field] = '{bad-json'; });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

test('a changed unknown numeric token outside int64 is not discarded as semantic equality', t => {
  const merged = withoutProof.replace('9007199254740993', '9007199254740994');
  const f = fixture(t, undefined, merged);
  assert.ok(f.value.includes('9007199254740994'));
  assert.notEqual(f.value, canonical);
  assert.ok(f.value.includes(PROOF_TEXT));
});

for (const placement of ['wrapper', 'native']) for (const value of [OTHER, null]) {
  test(`an explicit ${placement} source account ${value === null ? 'null' : 'conflict'} prevents inheritance`, t => {
    const f = fixture(t, (old, incoming) => {
      const native = JSON.parse(RAW);
      const raw = placement === 'native' ? { raw_api: { ...native, sender_name_account_key: value } }
        : { ...native, sender_name_account_key: value };
      old.raw_json = incoming.raw_json = JSON.stringify(raw);
      old.content_hash = incoming.content_hash = hash(old.raw_json);
      replaceProof(old, { ...proof, source_hash: old.content_hash });
    });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

test('an exact proof source hash is not a substitute for the separate read-side hash validator', t => {
  const f = fixture(t, (old, incoming) => {
    old.content_hash = incoming.content_hash = 'c'.repeat(64);
    replaceProof(old, { ...proof, source_hash: old.content_hash });
  });
  // Deliberate division of responsibility: the SQL helper cannot calculate a
  // digest. It retains only the existing attestation; reading still hashes raw.
  assert.equal(f.value, f.existing.canonical_json);
});

test('the outer helper composes with the actual name merge without dropping adoption or acquisition bytes', t => {
  const f = fixture(t, (old, incoming) => {
    for (const [key, value] of Object.entries({ sender_name: 'Invented Replay Person', sender_name_source: 'contact',
      sender_name_confidence: 'high', sender_name_account_key: ACCOUNT, sender_id_type: 'open_id' })) {
      old.canonical_json = append(old.canonical_json, key, value);
    }
    incoming.canonical_json = append(append(incoming.canonical_json, 'sender_name', null), 'sender_id_type', 'open_id');
  }, () => mergeLarkNameProjectionSql('e.canonical_json', 'i.canonical_json', 'e.actor_id', 'i.actor_id',
    'e.container_id', 'i.container_id', 'e.raw_json', 'i.raw_json'));
  assert.equal(f.value, f.existing.canonical_json);
  assert.equal(JSON.parse(f.value).sender_name, 'Invented Replay Person');
  assert.equal(JSON.parse(f.value)[MEMBER].acquired_at, ACQUIRED);
});

for (const route of ['upsert', 'succeedRecordRun']) {
  test(`actual ${route} preserves acquisition evidence and updated_at on no-query replay`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'exocortex-account-real-store-synthetic-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const db = join(directory, 'synthetic.sqlite'), chat = 'oc_synthetic_store_account_room';
    const scopeId = chatScopeId(chat), self = { open_id: 'ou_synthetic_store_account_self' };
    const at = Date.parse('2025-04-03T02:00:00.000Z');
    ensureInitialized(db);
    sqliteExec(db, `INSERT INTO sync_scopes(id,source_id,name,enabled,config_json)
      VALUES(${quoteSql(scopeId)},'lark.im','Invented scope',1,${quoteSql(JSON.stringify({ chat_id: chat, chat_type: 'group' }))});`);
    const raw = { message_id: 'om_synthetic_store_account', chat_id: chat, chat_type: 'group', message_type: 'text',
      create_time: String(at), update_time: String(at + 1000),
      sender: { id: 'ou_synthetic_store_account_actor', id_type: 'open_id', sender_type: 'user', name: 'Invented Store Person' },
      body: { content: JSON.stringify({ text: 'Invented complete store body.' }) } };
    const original = recordFromMessage(normalizeApiMessage(raw), scopeId, 'received', {}, { chat_id: chat, chat_type: 'group' });
    const acquired = bindAcquiredMessageAccounts([original], self, { acquiredAt: ACQUIRED })[0];
    assert.notEqual(acquired.canonical_json, original.canonical_json, 'the real acquisition producer must attest this fixture');
    const write = record => {
      if (route === 'upsert') { sqliteExec(db, upsertRecordsSql([record]), 'synthetic direct upsert'); return null; }
      const scope = readScope(db, scopeId), run = createRun(db, scope, { runner: 'synthetic account retention' });
      return succeedRecordRun(db, scope, run, [record], 1, cursorAfter(at + 60_000), { fixture: 'invented' });
    };
    const read = () => sqliteQuery(db, 'SELECT * FROM records;', 'read synthetic account store')[0];
    const first = write(acquired);
    if (first) assert.deepEqual(first, { inserted: 1, updated: 0, duplicate: 0 });
    sqliteExec(db, "UPDATE records SET updated_at='2025-04-03T02:01:00.456Z';");
    const before = read();
    for (let repetition = 0; repetition < 2; repetition++) {
      const effects = write(original);
      if (effects) assert.deepEqual(effects, { inserted: 0, updated: 0, duplicate: 1 });
      assert.deepEqual(read(), before, 'canonical/raw/body/source clocks and updated_at all remain byte identical');
    }
    const retained = readMessageAccountEvidence(before, JSON.parse(before.canonical_json), JSON.parse(before.raw_json));
    assert.equal(retained?.acquired_at, ACQUIRED, 'reading validates the same original acquisition time');

    const freshAt = '2025-04-03T03:00:00.000Z';
    const refreshed = bindAcquiredMessageAccounts([original], self, { acquiredAt: freshAt })[0];
    const refreshedEffects = write(refreshed), afterRefresh = read();
    if (refreshedEffects) assert.deepEqual(refreshedEffects, { inserted: 0, updated: 0, duplicate: 1 });
    assert.deepEqual(afterRefresh, before, 'a later acquisition clock alone must not rewrite a complete duplicate');
    assert.equal(JSON.parse(afterRefresh.canonical_json)[MEMBER].acquired_at, ACQUIRED,
      'first retained evidence is preserved without claiming the unknown true first acquisition');

    const named = JSON.parse(refreshed.canonical_json);
    Object.assign(named, { sender_name: 'Invented Correctly Renamed Person', sender_name_source: 'contact',
      sender_name_confidence: 'high', sender_name_account_key: retained.account_key });
    const renamedEffects = write({ ...refreshed, canonical_json: JSON.stringify(named) });
    const afterRename = read();
    if (renamedEffects) assert.deepEqual(renamedEffects, { inserted: 0, updated: 1, duplicate: 0 });
    assert.equal(JSON.parse(afterRename.canonical_json).sender_name, 'Invented Correctly Renamed Person');
    assert.equal(JSON.parse(afterRename.canonical_json)[MEMBER].acquired_at, freshAt,
      'a changed adopted name keeps the real new acquisition proof');
    assert.notEqual(afterRename.updated_at, before.updated_at);
    for (const key of Object.keys(before).filter(key => !['canonical_json', 'updated_at'].includes(key))) {
      assert.equal(afterRename[key], before[key], key);
    }

    const newerRaw = { ...raw, update_time: String(at + 2000),
      body: { content: JSON.stringify({ text: 'A newer entirely invented body.' }) } };
    const newer = recordFromMessage(normalizeApiMessage(newerRaw), scopeId, 'received', {}, { chat_id: chat, chat_type: 'group' });
    const newerBound = bindAcquiredMessageAccounts([newer], self, { acquiredAt: '2025-04-03T04:00:00.000Z' })[0];
    const newerEffects = write(newerBound), afterSource = read();
    if (newerEffects) assert.deepEqual(newerEffects, { inserted: 0, updated: 1, duplicate: 0 });
    assert.equal(afterSource.external_version, String(at + 2000));
    assert.equal(afterSource.body, 'A newer entirely invented body.');
    assert.equal(JSON.parse(afterSource.canonical_json)[MEMBER].acquired_at, '2025-04-03T04:00:00.000Z');
    write(newer);
    assert.deepEqual(read(), afterSource, 'later no-query replay retains the new source version proof');

    const cleared = { ...newer, canonical_json: append(newer.canonical_json, MEMBER, null) };
    write(cleared);
    assert.equal(JSON.parse(read().canonical_json)[MEMBER], null, 'an explicit incoming null is never resurrected');
  });
}

test('a later valid acquisition time alone returns every original canonical byte', t => {
  const f = fixture(t, (_old, incoming) => replaceProof(incoming, { ...proof, acquired_at: '2025-04-03T03:00:00.000Z' }));
  assert.equal(f.value, f.existing.canonical_json);
});

for (const [label, mutate] of [
  ['future', value => { value.acquired_at = '2999-01-01T00:00:00.000Z'; }],
  ['older', value => { value.acquired_at = '2025-04-03T01:00:00.000Z'; }],
  ['invalid time', value => { value.acquired_at = 'invalid'; }],
  ['other account', value => { value.account_key = OTHER; }],
  ['other version', value => { value.source_version = 'different'; }],
  ['missing key', value => { delete value.source_hash; }],
  ['extra key', value => { value.extra = true; }],
]) {
  test(`a new ${label} proof is never silently ignored as a clock-only refresh`, t => {
    const f = fixture(t, (_old, incoming) => {
      const value = { ...proof, acquired_at: '2025-04-03T03:00:00.000Z' }; mutate(value); replaceProof(incoming, value);
    });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

for (const field of ['direction', 'body', 'title', 'occurred_at', 'occurred_at_ms']) {
  test(`a changed record ${field} cannot suppress the new acquisition evidence`, t => {
    const f = fixture(t, (_old, incoming) => {
      replaceProof(incoming, { ...proof, acquired_at: '2025-04-03T03:00:00.000Z' });
      incoming[field] = 'synthetic-change';
    });
    assert.equal(f.value, f.incoming.canonical_json);
  });
}

test('a different unknown numeric token is not hidden by clock-only refresh comparison', t => {
  const f = fixture(t, (_old, incoming) => {
    replaceProof(incoming, { ...proof, acquired_at: '2025-04-03T03:00:00.000Z' });
    incoming.canonical_json = incoming.canonical_json.replace('1.234567890123456789', '1.234567890123456788');
  });
  assert.equal(f.value, f.incoming.canonical_json);
});
