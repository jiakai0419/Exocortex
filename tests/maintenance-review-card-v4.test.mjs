import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { executeLarkImReplay, validateReplayOptions } from '../src/maintenance/replay.mjs';
import { REVIEW_AGE_MS } from '../src/maintenance/review-artifact.mjs';
import { commitBoundedReplayRecords, ensureInitialized, INITIAL_ACCOUNT_KIND, quoteSql, sqliteExec, sqliteQuery,
  upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';

// Every identifier, card and database is independently authored here. The two
// injected API boundaries cannot reach a transport, credentials or real data.
const SELF = { open_id: 'ou_finite_audit_cartographer', name: 'Invented Cartographer' };
const CHAT = 'oc_finite_audit_paper_garden';
const MESSAGE = 'om_finite_audit_paper_map';
const SCOPE = chatScopeId(CHAT);
const schema = n => `exocortex_private_maintenance_review/v${n}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const query = (f, statement = 'SELECT * FROM records ORDER BY id;') => sqliteQuery(f.db, statement, 'read invented finite-card approval');
const sql = (f, statement) => sqliteExec(f.db, statement, 'write invented finite-card approval');
const text = content => ({ tag: 'plain_text', content });
const ordinary = label => ({ elements: [text(label)] });
const panel = label => ({ elements: [{ tag: 'collapsible_panel', expanded: false,
  header: { title: text('Imaginary shelf') }, elements: [text(label)] }] });
const form = (label, opaque = 'SYNTHETIC_OPAQUE_ONE') => ({ elements: [{ tag: 'form', elements: [
  { tag: 'input', label: text('Imaginary response'), default_value: label, placeholder: text('Only an example'), required: true },
  { tag: 'select_static', label: text('Imaginary route'), options: [
    { value: 'east', text: text('East door') }, { value: 'west', text: text('West door') },
  ], initialOption: 'west', initialIndex: 1 },
  { tag: 'button', actionType: 'form_submit', text: text('Offer map'), actions: [
    { type: 'action_request', payload: { opaque } },
  ] },
  { tag: 'a', text: text('Read description'), href: 'https://invented-user:SYNTHETIC_URL_PASSWORD@example.invalid/map?key=SYNTHETIC_URL_QUERY#SYNTHETIC_URL_FRAGMENT' },
] }] });
const DISCLOSURE_V4 = {
  opaque_columns: ['title', 'body', 'canonical_json', 'raw_json', 'content_hash'],
  meaning: 'opaque_columns_are_digest_bound_not_fully_displayed',
  card_text: 'rendered_api_projection_not_the_stored_body_column_or_business_approval',
  omissions: 'interactive_values_and_url_credentials_are_intentionally_not_displayed',
  non_card_text: 'exact_stored_title_and_body_not_client_state; private_text_is_not_redacted',
};
const DISCLOSURE_V5 = { ...DISCLOSURE_V4,
  omissions: 'callback_payloads_and_url_credentials_are_intentionally_not_displayed',
  static_controls: 'source_declared_static_control_values_and_options_may_be_displayed; placeholders_are_hints_not_values',
  actions: 'action_definitions_are_not_execution_or_business_approval',
};

function message(f, content, updated = false) {
  return normalizeApiMessage({ message_id: MESSAGE, chat_id: CHAT, msg_type: 'interactive',
    create_time: String(f.start + 1000), update_time: String(f.start + (updated ? 20_000 : 1000)),
    sender: { id: 'ou_finite_audit_gardener', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify(content) } });
}
function fixture(t, before = ordinary('Invented old paragraph')) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exocortex-finite-card-approval-')));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'invented-only.sqlite'), start: Date.now() - 86_400_000, calls: [] };
  f.end = f.start + 60_000;
  ensureInitialized(f.db);
  const confirmed = new Date(f.start).toISOString();
  sql(f, `UPDATE sources SET config_json=${quoteSql(JSON.stringify({ initial_sync_start_ms: f.start,
    initial_account_binding: { kind: INITIAL_ACCOUNT_KIND, account_key: hash(`lark.im\0${SELF.open_id}`),
      reserved_at: confirmed, confirmed_at: confirmed } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES (${quoteSql(SCOPE)},'lark.im','Invented shelf scope',
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  sql(f, upsertRecordsSql(prepareChatWindowRecords([message(f, before)], SCOPE, null, f.start, f.end,
    SELF.open_id, { self: SELF }, { chat_id: CHAT, chat_type: 'group' })));
  f.rows = query(f);
  f.options = validateReplayOptions({ db: f.db, scopeIds: [SCOPE], messageIds: [MESSAGE],
    start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString(),
    maxCliAttempts: 12, maxSeconds: 30, reviewOut: join(dir, 'finite-review.json') });
  return f;
}
function replay(f, content, options = f.options, extra = {}) {
  return executeLarkImReplay(options, {
    getSelfProfile() { f.calls.push('self'); return SELF; },
    fetchChatMessages() { f.calls.push('fetch'); return { messages: [message(f, content, true)], pages: 1 }; },
    ...extra,
  });
}
function approved(f, preview) {
  const { reviewOut, ...same } = f.options;
  return { ...same, apply: true, reviewIn: reviewOut, reviewSha256: preview.review.sha256 };
}
const artifact = f => JSON.parse(readFileSync(f.options.reviewOut, 'utf8'));
function rewrite(f, mutate) {
  const value = artifact(f); mutate(value);
  writeFileSync(f.options.reviewOut, `${JSON.stringify(value, null, 2)}\n`);
  return hash(readFileSync(f.options.reviewOut));
}
function unchanged(f, before = f.rows) {
  assert.deepEqual(query(f), before);
  assert.equal(query(f, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 0);
  assert.equal(query(f, 'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n, 0);
}
function preview(f, after) {
  const beforeBytes = readFileSync(f.db), result = replay(f, after);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.review.changes, 1);
  assert.deepEqual(readFileSync(f.db), beforeBytes, 'dry-run makes no database write');
  unchanged(f);
  return result;
}
function assertShape(value, versions) {
  assert.equal(value.expires_at_ms - value.created_at_ms, REVIEW_AGE_MS);
  assert.equal(value.binding.scope_config_policy, 'lark_im_scope_json_remove_hot/v1');
  assert.equal(value.binding.verified_self_sha256, hash(SELF.open_id));
  assert.equal(value.constraints.max_cli_attempts, 12);
  assert.equal(value.constraints.max_seconds, 30);
  const record = value.records[0];
  assert.ok(record.proof.observed.exact);
  assert.ok(record.proof.proposal.exact);
  for (const [index, side] of ['before', 'after'].entries()) {
    const projected = record.display[side].card;
    assert.deepEqual(Object.keys(projected).sort(), ['omitted_actions', 'reason', 'status', 'text', 'version']);
    assert.equal(projected.status, 'rendered'); assert.equal(projected.reason, null);
    assert.equal(projected.version, versions[index]);
    assert.equal(record.display[side].non_card, null);
  }
}

for (const [label, before, after, versions, wire] of [
  ['ordinary v3 to v3', ordinary('Prior paragraph'), ordinary('Later paragraph'), [3, 3], 4],
  ['ordinary v3 to panel v4', ordinary('Prior paragraph'), panel('New panel text'), [3, 4], 5],
  ['ordinary v3 to form v4', ordinary('Prior paragraph'), form('Declared answer'), [3, 4], 5],
  ['finite v4 to finite v4', panel('Earlier panel'), form('Another declared answer'), [4, 4], 5],
  ['finite before v4 to ordinary after v3', form('Earlier declared answer'), ordinary('Later simple text'), [4, 3], 5],
]) {
  test(`${label}: actual replay dry-run/apply retains exact schema, disclosure and observation proofs`, async t => {
    const f = fixture(t, before), review = preview(f, after), value = artifact(f);
    assert.equal(value.schema, schema(wire));
    assert.equal(review.review.schema, schema(wire));
    assert.deepEqual(value.disclosure, wire === 5 ? DISCLOSURE_V5 : DISCLOSURE_V4);
    assertShape(value, versions);
    assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_OPAQUE|SYNTHETIC_URL_|invented-user/);
    await delay(10); // A later actual acquisition clock must not invalidate the same approved source.
    const result = replay(f, after, approved(f, review));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.scopes[0].updated, 1);
    assert.deepEqual(f.calls, ['self', 'fetch', 'self', 'fetch']);
    const row = query(f)[0];
    assert.equal(hash(row.raw_json), value.records[0].opaque.after.raw_json.sha256);
    assert.equal(row.id, f.rows[0].id);
    assert.equal(row.occurred_at_ms, f.rows[0].occurred_at_ms);
    assert.equal(query(f, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 1);
  });
}

test('an unresolved image cannot publish a finite-card review or request an image', t => {
  const f = fixture(t), result = replay(f, { elements: [{ tag: 'img', img_key: 'invented_uncached_image' }] });
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /incomplete_card/);
  assert.equal(existsSync(f.options.reviewOut), false);
  assert.deepEqual(f.calls, ['self', 'fetch']);
  unchanged(f);
});

for (const kind of ['schema', 'renderer', 'partial', 'reason', 'media_slots', 'extra_card_field', 'disclosure',
  'ttl_extended', 'expired', 'future', 'proof', 'scope_policy']) {
  test(`v5 ${kind} artifact mutation is rejected before any API`, t => {
    const f = fixture(t), after = form('Immutable displayed answer'), review = preview(f, after), input = approved(f, review);
    input.reviewSha256 = rewrite(f, value => {
      const card = value.records[0].display.after.card;
      if (kind === 'schema') value.schema = schema(999);
      if (kind === 'renderer') card.version = 999;
      if (kind === 'partial') card.status = 'partial';
      if (kind === 'reason') card.reason = 'invented_non_null';
      if (kind === 'media_slots') card.media_slots = [];
      if (kind === 'extra_card_field') card.future_display = true;
      if (kind === 'disclosure') value.disclosure.actions = 'invented_changed_disclosure';
      if (kind === 'ttl_extended') value.expires_at_ms++;
      if (kind === 'expired' || kind === 'future') {
        value.created_at_ms = Date.now() + (kind === 'future' ? 60_000 : -REVIEW_AGE_MS - 60_000);
        value.expires_at_ms = value.created_at_ms + REVIEW_AGE_MS;
      }
      if (kind === 'proof') value.records[0].proof.proposal.exact = '0'.repeat(64);
      if (kind === 'scope_policy') value.binding.scope_config_policy = 'invented_policy/v99';
    });
    const calls = f.calls.length;
    assert.throws(() => replay(f, after, input), kind === 'expired' || kind === 'future' ? /expired/ : /invalid_file/);
    assert.equal(f.calls.length, calls);
    unchanged(f);
  });
}

test('v5 rejects changing the on-disk bytes without a new hash', t => {
  const f = fixture(t), after = panel('Exact source'), review = preview(f, after), input = approved(f, review);
  rewrite(f, value => { value.records[0].display.after.card.text += ' altered'; });
  const calls = f.calls.length;
  assert.throws(() => replay(f, after, input), /approval_mismatch/);
  assert.equal(f.calls.length, calls); unchanged(f);
});

test('v5 local source drift rejects before API and preserves the intervening source', t => {
  const f = fixture(t), after = panel('Exact source'), review = preview(f, after);
  sql(f, `UPDATE records SET body='Invented intervening local body' WHERE id=${f.rows[0].id};`);
  const changed = query(f), calls = f.calls.length;
  assert.throws(() => replay(f, after, approved(f, review)), /snapshot_changed/);
  assert.equal(f.calls.length, calls); unchanged(f, changed);
});

test('v5 source/account policy drift cannot reuse a previously approved card', t => {
  const f = fixture(t), after = form('Exact input'), review = preview(f, after);
  sql(f, `UPDATE sources SET config_json=json_set(config_json,'$.invented_revision',1) WHERE id='lark.im';`);
  const calls = f.calls.length;
  assert.throws(() => replay(f, after, approved(f, review)), /binding_changed/);
  assert.equal(f.calls.length, calls); unchanged(f);
});

test('v5 callback-only fresh drift is bound despite unchanged visible text and version', t => {
  const f = fixture(t), after = form('Same visible answer', 'SYNTHETIC_OPAQUE_ONE'), review = preview(f, after);
  const result = replay(f, form('Same visible answer', 'SYNTHETIC_OPAQUE_TWO'), approved(f, review));
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /proposal_changed/);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_OPAQUE/);
  unchanged(f);
});

test('v5 preserves the transaction fence after the application binding check', t => {
  const f = fixture(t), after = panel('Approved panel'), review = preview(f, after);
  let reached = false;
  const result = replay(f, after, approved(f, review), { commitBoundedReplayRecords: (db, options) => commitBoundedReplayRecords(db, {
    ...options, reviewBeforeCommit() {
      options.reviewBeforeCommit(); reached = true;
      sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.hot_seen_at','Invented later discovery') WHERE id=${quoteSql(SCOPE)};`);
    },
  }) });
  assert.equal(reached, true); assert.equal(result.ok, false); unchanged(f);
});

test('v5 record CAS preserves an intervening row without a partial replay commit', t => {
  const f = fixture(t), after = form('Approved answer'), review = preview(f, after);
  let changed;
  const result = replay(f, after, approved(f, review), { commitBoundedReplayRecords(db, options) {
    sql(f, `UPDATE records SET canonical_json=json_set(canonical_json,'$.invented_late_change',true) WHERE id=${f.rows[0].id};`);
    changed = query(f);
    return commitBoundedReplayRecords(db, options);
  } });
  assert.ok(changed); assert.equal(result.ok, false); unchanged(f, changed);
});

test('v5 cannot be assigned to an ordinary-only v3 proposal', t => {
  const f = fixture(t), after = ordinary('Ordinary revision'), review = preview(f, after), input = approved(f, review);
  input.reviewSha256 = rewrite(f, value => { value.schema = schema(5); value.disclosure = DISCLOSURE_V5; });
  const calls = f.calls.length;
  assert.throws(() => replay(f, after, input), /invalid_file/);
  assert.equal(f.calls.length, calls); unchanged(f);
});

test('old v4 approval is never silently upgraded when the refetched card needs renderer v4', t => {
  const f = fixture(t), review = preview(f, ordinary('Approved old-version paragraph'));
  assert.equal(artifact(f).schema, schema(4));
  const file = readFileSync(f.options.reviewOut);
  const result = replay(f, panel('New finite semantics were not approved'), approved(f, review));
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /invalid_file|proposal_changed|incomplete_card/);
  assert.deepEqual(readFileSync(f.options.reviewOut), file);
  unchanged(f);
});

for (const legacy of [1, 2, 3, 4]) {
  test(`legacy v${legacy} artifact cannot accept renderer-v4 semantics`, t => {
    const f = fixture(t), after = panel('Finite preview'), review = preview(f, after), input = approved(f, review);
    input.reviewSha256 = rewrite(f, value => {
      value.schema = schema(legacy);
      value.disclosure = { ...DISCLOSURE_V4 };
      if (legacy < 4) for (const record of value.records) delete record.proof;
      if (legacy < 3) {
        delete value.binding.scope_config_policy;
        const config = query(f, `SELECT config_json FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`)[0].config_json;
        for (const scope of value.binding.scopes) scope.config_sha256 = hash(config);
      }
      if (legacy === 1) {
        delete value.disclosure.non_card_text;
        for (const record of value.records) for (const side of ['before', 'after']) delete record.display[side].non_card;
      }
    });
    const calls = f.calls.length;
    assert.throws(() => replay(f, after, input), /invalid_file/);
    assert.equal(f.calls.length, calls); unchanged(f);
  });
}
