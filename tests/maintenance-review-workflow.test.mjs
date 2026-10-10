import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeEnrichment } from '../src/maintenance/enrich.mjs';
import { commitEnrichmentUpdates } from '../src/maintenance/enrichment-commit.mjs';
import { executeLarkImReplay, validateReplayOptions } from '../src/maintenance/replay.mjs';
import { beginMaintenanceReview, effectiveRecord, publishReviewArtifact, REVIEW_AGE_MS } from '../src/maintenance/review-artifact.mjs';
import { runMaintenanceCommand } from '../src/cli/maintenance-command.mjs';
import { parseRouteOptions } from '../src/cli/registry.mjs';
import { createCommandContext } from '../src/cli/context.mjs';
import { normalizeApiMessage } from '../src/adapters/lark-im/raw-message.mjs';
import { createSyncRunner, prepareChatWindowRecords } from '../src/adapters/lark-im/sync-runner.mjs';
import { chatScopeId } from '../src/adapters/lark-im/core.mjs';
import { commitBoundedReplayRecords, ensureInitialized, INITIAL_ACCOUNT_KIND, quoteSql, sqliteExec, sqliteQuery, upsertRecordsSql } from '../dist/storage/sqlite/ingestion-store.js';

// All data is authored here. Both workflows inject the complete API boundary;
// no real transport, shared UID lease/cooldown, credentials or source DB is used.
const SELF = { open_id: 'ou_synthetic_review_self', name: 'Synthetic Review Self' };
const CHAT = 'oc_synthetic_review_chat';
const SCOPE = chatScopeId(CHAT);
const hash = value => createHash('sha256').update(value).digest('hex');
const ro = (f, text = 'SELECT * FROM records ORDER BY id;') => sqliteQuery(f.db, text, 'read synthetic review');
const sql = (f, text) => sqliteExec(f.db, text, 'write synthetic review');
const publicReport = report => assert.doesNotMatch(JSON.stringify(report), /Synthetic Reader|Synthetic App|Synthetic card|oc_synthetic|ou_synthetic|om_synthetic|synthetic\.sqlite|RAW_SECRET/);
const card = text => ({ elements: [{ tag: 'markdown', content: text }] });
const nonCardContent = (kind, text) => kind === 'post'
  ? { title: 'Synthetic post title', content: [[{ tag: 'text', text }]] }
  : kind === 'system' ? { template: text } : { text };

function fixture(t, count = 2, cards = false) {
  // macOS TMPDIR can contain /var -> /private/var (or another parent symlink).
  // Ordinary fixtures need canonical paths; explicit unsafe-path cases below do not.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exocortex-review-flow-')));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = { dir, db: join(dir, 'synthetic.sqlite'), calls: [], start: Date.now() - 86_400_000 };
  f.end = f.start + 60_000;
  ensureInitialized(f.db);
  const confirmed = new Date(f.start).toISOString();
  const config = { initial_sync_start_ms: f.start, initial_account_binding: { kind: INITIAL_ACCOUNT_KIND,
    account_key: hash(`lark.im\0${SELF.open_id}`), reserved_at: confirmed, confirmed_at: confirmed } };
  sql(f, `UPDATE sources SET config_json=${quoteSql(JSON.stringify(config))} WHERE id='lark.im';
    INSERT INTO sync_scopes (id,source_id,name,config_json) VALUES (${quoteSql(SCOPE)},'lark.im','Synthetic scope',
      ${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group' }))});`);
  f.messages = Array.from({ length: count }, (_, i) => message(f, i, cards));
  const records = prepareChatWindowRecords(f.messages, SCOPE, null, f.start, f.end, SELF.open_id, { self: SELF }, { chat_id: CHAT, chat_type: 'group' });
  sql(f, upsertRecordsSql(records));
  f.rows = ro(f); f.ids = f.rows.map(row => row.id);
  return f;
}
function message(f, index, cards = false, overrides = {}) {
  const kind = typeof cards === 'string' ? cards : cards ? 'interactive' : 'text';
  return normalizeApiMessage({ message_id: `om_synthetic_review_${index}`, chat_id: CHAT,
    create_time: String(f.start + 1000 + index), update_time: String(f.start + 1000 + index),
    msg_type: kind, sender: { id: `ou_synthetic_review_peer_${index}`, id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify(kind === 'interactive' ? card(`Synthetic card before ${index}`)
      : nonCardContent(kind, `Synthetic text ${index}`)) }, ...overrides });
}
function nameOptions(f, extra = {}) {
  return { db: f.db, target: 'records', namesOnly: true, recordIds: f.ids, maxCliAttempts: 12, maxSeconds: 30,
    reviewOut: join(f.dir, 'names-review.json'), ...extra };
}
function names(f, options = nameOptions(f), extra = {}) {
  return executeEnrichment(options, { runLark: args => {
    f.calls.push(args);
    assert.equal(args[0], 'contact'); assert.equal(args[1], '+search-user');
    assert.equal(ro(f, 'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n, 0);
    return { users: args[args.indexOf('--user-ids') + 1].split(',').map(open_id => ({ open_id, name: `Synthetic Reader ${open_id.slice(-1)}` })) };
  }, ...extra });
}
function replayOptions(f, extra = {}) {
  return validateReplayOptions({ db: f.db, scopeIds: [SCOPE], messageIds: f.rows.map(r => r.external_id),
    start: new Date(f.start).toISOString(), end: new Date(f.end).toISOString(), maxCliAttempts: 12, maxSeconds: 30,
    reviewOut: join(f.dir, 'card-review.json'), ...extra });
}
function incoming(f, index = 0, text = `Synthetic card after ${index}`, extra = {}) {
  return message(f, index, true, { update_time: String(f.start + 20_000 + index), body: { content: JSON.stringify(card(text)) }, ...extra });
}
function replay(f, messages = f.rows.map((_, i) => incoming(f, i)), options = replayOptions(f), extra = {}) {
  return executeLarkImReplay(options, { getSelfProfile: () => { f.calls.push('self'); return SELF; },
    fetchChatMessages: () => { f.calls.push('fetch'); return { messages, pages: 1 }; }, ...extra });
}
function approved(options, summary) {
  const { reviewOut, ...same } = options;
  return { ...same, apply: true, reviewIn: reviewOut, reviewSha256: summary.review.sha256 };
}
function readArtifact(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function rewrite(path, mutate) {
  const value = readArtifact(path); mutate(value); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return hash(readFileSync(path));
}
function noWrites(f, before) {
  assert.deepEqual(ro(f), before);
  assert.equal(ro(f, 'SELECT COUNT(*) AS n FROM bounded_replay_runs;')[0].n, 0);
  assert.equal(ro(f, 'SELECT COUNT(*) AS n FROM maintenance_locks;')[0].n, 0);
}
function saveSyntheticExample(mode, file, stdout) {
  const destination = process.env.EXOCORTEX_SYNTHETIC_REVIEW_OUTPUT;
  if (!destination) return;
  assert.equal(statSync(destination).mode & 0o077, 0);
  const artifact = join(destination, `synthetic-${mode}-review.json`);
  copyFileSync(file, artifact); chmodSync(artifact, 0o600);
  writeFileSync(join(destination, `synthetic-${mode}-stdout.json`), `${JSON.stringify({ fixture: 'authored_synthetic_only', stdout }, null, 2)}\n`, { mode: 0o600 });
}

const SCOPE_POLICY = 'lark_im_scope_json_remove_hot/v1';
const HOT_FIELDS = ['hot_rank', 'hot_seen_at', 'last_hot_snapshot_id'];
const scopeConfigText = f => ro(f, `SELECT config_json FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`)[0].config_json;
function initializeHotScope(f) {
  sql(f, `UPDATE sync_scopes SET config_json=${quoteSql(JSON.stringify({ chat_id: CHAT, chat_type: 'group',
    chat_name: 'Synthetic Scope', hot_rank: 9, hot_seen_at: new Date(f.start).toISOString(),
    last_hot_snapshot_id: 'hot_synthetic_before' }))} WHERE id=${quoteSql(SCOPE)};`);
}
function advanceHotDiscovery(f) {
  let boundaryCalls = 0;
  const runner = createSyncRunner({
    fetchChatDiscoveryPage: () => {
      boundaryCalls++;
      return { chats: [{ chat_id: CHAT, chat_type: 'group', chat_name: 'Synthetic Scope' }], has_more: false, page_token: '' };
    },
    makeSnapshotId: () => 'hot_synthetic_after', nowIso: () => new Date(f.end).toISOString(),
  });
  const result = runner.syncDiscovery(f.db, { startMs: f.start, endMs: f.end, pageSize: 50, maxPages: 1,
    chatPageSize: 100, maxChatPages: 100, discoveryPagesPerRun: 1, receivedScopesPerRun: 0,
    discoveryMode: 'hot', reconcileIntervalHours: 24, receivedMode: 'all', chatTypes: 'group,p2p',
    stableHorizonSeconds: 30, stableHorizonMs: 30000, endExplicit: true, lockTtlSeconds: 600, retries: 0, retryDelayMs: 0 });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(boundaryCalls, 1);
  assert.equal(result.snapshot_id, 'hot_synthetic_after');
  assert.equal(ro(f, "SELECT COUNT(*) AS n FROM sync_runs WHERE status='succeeded';")[0].n, 1);
}
function scopeWorkflow(f, mode) {
  const options = mode === 'names' ? nameOptions(f) : replayOptions(f);
  const messages = mode === 'text' ? f.rows.map((_, i) => message(f, i, 'text', {
    update_time: String(f.start + 20_000 + i), body: { content: JSON.stringify({ text: `Synthetic approved text ${i}` }) },
  })) : undefined;
  return { options, run: (opts = options, deps = {}) => mode === 'names' ? names(f, opts, deps) : replay(f, messages, opts, deps) };
}
// Synthetic compatibility fixtures project only the documented wire shape.
// The real native workflow authors all snapshots, decisions and proposal hashes;
// approved apply must still refetch and reproduce every record without a bypass.
function legacyApproval(f, options, preview, schema) {
  const input = approved(options, preview);
  input.reviewSha256 = rewrite(options.reviewOut, artifact => {
    artifact.schema = `exocortex_private_maintenance_review/${schema}`;
    for (const record of artifact.records) delete record.proof;
    if (schema !== 'v3') {
      delete artifact.binding.scope_config_policy;
      for (const scope of artifact.binding.scopes) scope.config_sha256 = hash(scopeConfigText(f));
    }
    if (schema === 'v1') {
      delete artifact.disclosure.non_card_text;
      for (const record of artifact.records) for (const side of ['before', 'after']) delete record.display[side].non_card;
    }
  });
  return input;
}

for (const [mode, kind] of [['names', 'text'], ['names', 'interactive'], ['card', 'interactive'], ['text', 'text']]) {
  test(`v3 ${mode} (${kind}) approval survives only the three fields changed by formal hot discovery`, t => {
    const f = fixture(t, 2, kind); initializeHotScope(f);
    const w = scopeWorkflow(f, mode), preview = w.run(), artifact = readArtifact(w.options.reviewOut);
    assert.equal(artifact.schema, `exocortex_private_maintenance_review/${mode === 'names' ? 'v3' : 'v4'}`);
    assert.equal(artifact.binding.scope_config_policy, SCOPE_POLICY);
    assert.equal(artifact.expires_at_ms - artifact.created_at_ms, REVIEW_AGE_MS);
    for (const r of artifact.records) if (mode !== 'text') assert.equal(r.display.after.non_card, null);
    const rows = ro(f), before = JSON.parse(scopeConfigText(f));
    advanceHotDiscovery(f);
    const after = JSON.parse(scopeConfigText(f));
    assert.deepEqual(Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(before[key])).sort(), HOT_FIELDS);
    assert.deepEqual(ro(f), rows, 'formal discovery changes no selected record');
    const calls = f.calls.length, result = w.run(approved(w.options, preview));
    assert.equal(mode === 'names' ? result.updated : result.scopes[0].updated, 2);
    assert.ok(f.calls.length > calls, 'approval still refetches the authoritative proposal');
    assert.equal(scopeConfigText(f), JSON.stringify(after), 'apply does not overwrite scheduler progress');
    publicReport(result);
  });
}

for (const mutation of ['unknown_added', 'unknown_removed', 'unknown_null_removed', 'unknown_large_integer', 'nested_hot',
  'chat_id', 'chat_type', 'chat_name', 'scope_source', 'scope_enabled', 'source_enabled', 'baseline', 'account']) {
  test(`v3 approval binds ${mutation} before any API`, t => {
    const f = fixture(t, 1, true); initializeHotScope(f);
    if (mutation === 'unknown_removed') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.future_policy','must_remain') WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'unknown_null_removed') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.future_policy',null) WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'unknown_large_integer') sql(f, `UPDATE sync_scopes SET config_json=substr(config_json,1,length(config_json)-1)||',"future_policy":9007199254740992}' WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'nested_hot') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.future_policy',json('{"hot_rank":1}')) WHERE id=${quoteSql(SCOPE)};`);
    const w = scopeWorkflow(f, 'card'), preview = w.run(), before = ro(f), calls = f.calls.length;
    if (mutation === 'unknown_added') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.future_policy','new') WHERE id=${quoteSql(SCOPE)};`);
    if (['unknown_removed', 'unknown_null_removed'].includes(mutation)) sql(f, `UPDATE sync_scopes SET config_json=json_remove(config_json,'$.future_policy') WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'unknown_large_integer') sql(f, `UPDATE sync_scopes SET config_json=replace(config_json,'9007199254740992','9007199254740993') WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'nested_hot') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.future_policy.hot_rank',2) WHERE id=${quoteSql(SCOPE)};`);
    if (['chat_id', 'chat_type', 'chat_name'].includes(mutation)) sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,${quoteSql(`$.${mutation}`)},'synthetic_changed') WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'scope_source') sql(f, `INSERT INTO sources (id,display_name,kind) VALUES ('synthetic.other','Synthetic other','synthetic'); UPDATE sync_scopes SET source_id='synthetic.other' WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'scope_enabled') sql(f, `UPDATE sync_scopes SET enabled=0 WHERE id=${quoteSql(SCOPE)};`);
    if (mutation === 'source_enabled') sql(f, "UPDATE sources SET enabled=0 WHERE id='lark.im';");
    if (mutation === 'baseline') sql(f, "UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',json_extract(config_json,'$.initial_sync_start_ms')-1) WHERE id='lark.im';");
    if (mutation === 'account') sql(f, `UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key',${quoteSql(hash('synthetic_other_account'))}) WHERE id='lark.im';`);
    assert.throws(() => w.run(approved(w.options, preview)), /binding_changed|binding_unavailable|inconsistent chat identity|missing or disabled|not a Lark chat scope/);
    assert.equal(f.calls.length, calls); noWrites(f, before);
  });
}

for (const mutation of ['unknown_schema', 'unknown_policy', 'missing_policy', 'extra_policy', 'ttl_extended']) {
  test(`v3 rejects ${mutation} as an invalid contract before any API`, t => {
    const f = fixture(t, 1), w = scopeWorkflow(f, 'names'), preview = w.run(), before = ro(f), calls = f.calls.length;
    const input = approved(w.options, preview);
    input.reviewSha256 = rewrite(w.options.reviewOut, artifact => {
      if (mutation === 'unknown_schema') artifact.schema = 'exocortex_private_maintenance_review/v999';
      if (mutation === 'unknown_policy') artifact.binding.scope_config_policy = 'lark_im_scope_json_remove_hot/v999';
      if (mutation === 'missing_policy') delete artifact.binding.scope_config_policy;
      if (mutation === 'extra_policy') artifact.binding.scope_config_excluded_fields = ['chat_id'];
      if (mutation === 'ttl_extended') artifact.expires_at_ms++;
    });
    assert.throws(() => w.run(input), /invalid_file/); assert.equal(f.calls.length, calls); noWrites(f, before);
  });
}

for (const [mode, schema] of [['names', 'v1'], ['card', 'v1'], ['text', 'v2']]) {
  for (const drift of [false, true]) test(`legacy ${schema} ${mode} approval ${drift ? 'rejects hot drift before API' : 'still refetches and applies its exact proposal'}`, t => {
    const f = fixture(t, 1, mode === 'card'); initializeHotScope(f);
    const w = scopeWorkflow(f, mode), preview = w.run(), input = legacyApproval(f, w.options, preview, schema);
    const before = ro(f), calls = f.calls.length;
    if (drift) {
      advanceHotDiscovery(f);
      assert.throws(() => w.run(input), /binding_changed/); assert.equal(f.calls.length, calls); noWrites(f, before);
    } else {
      const result = w.run(input);
      assert.equal(mode === 'names' ? result.updated : result.scopes[0].updated, 1);
      assert.ok(f.calls.length > calls);
    }
  });
}

for (const mode of ['names', 'card', 'text']) {
  test(`v3 ${mode} apply rejects scheduler drift during its own API round`, t => {
    const f = fixture(t, 2, mode === 'card'); initializeHotScope(f);
    const w = scopeWorkflow(f, mode), preview = w.run(), before = ro(f);
    const drift = () => sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.hot_rank',1) WHERE id=${quoteSql(SCOPE)};`);
    if (mode === 'names') assert.throws(() => w.run(approved(w.options, preview), { runLark: args => {
      f.calls.push(args); drift();
      return { users: args[args.indexOf('--user-ids') + 1].split(',').map(open_id => ({ open_id, name: `Synthetic Reader ${open_id.slice(-1)}` })) };
    } }), /binding_changed/);
    else {
      const result = w.run(approved(w.options, preview), { getSelfProfile: () => { f.calls.push('self'); drift(); return SELF; } });
      assert.equal(result.ok, false); assert.match(JSON.stringify(result), /binding_changed/);
    }
    noWrites(f, before);
  });
}

for (const mode of ['card', 'text']) {
  test(`v3 ${mode} SQLite fence rejects scheduler drift after the final application recheck atomically`, t => {
    const f = fixture(t, 2, mode === 'card'); initializeHotScope(f);
    const w = scopeWorkflow(f, mode), preview = w.run(), before = ro(f);
    let passedApplicationFence = false;
    const result = w.run(approved(w.options, preview), { commitBoundedReplayRecords: (db, options) => commitBoundedReplayRecords(db, {
      ...options, reviewBeforeCommit: () => {
        options.reviewBeforeCommit(); passedApplicationFence = true;
        sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.hot_seen_at','Synthetic later discovery') WHERE id=${quoteSql(SCOPE)};`);
      },
    }) });
    assert.equal(passedApplicationFence, true); assert.equal(result.ok, false);
    noWrites(f, before);
  });
}

for (const drift of [false, true]) test(`v3 names commit helper ${drift ? 'atomically rejects hot drift after its application check' : 'accepts the complete current scope fence'}`, t => {
  const f = fixture(t, 2); initializeHotScope(f);
  const before = ro(f), options = nameOptions(f);
  const scopes = ro(f, `SELECT id,source_id,enabled,config_json FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`);
  const decisions = before.map(row => ({ before: row, outcome: 'update', after: { ...effectiveRecord(row),
    canonical_json: JSON.stringify({ ...JSON.parse(row.canonical_json), sender_name: 'Synthetic Reader Race' }),
  } }));
  const context = { db: f.db, mode: 'names', rows: before, scopes };
  const preview = beginMaintenanceReview(options, context).finish(decisions);
  const reviewed = beginMaintenanceReview(approved(options, { review: preview.summary }), context).finish(decisions);
  const updates = decisions.map(({ before: row, after }) => `UPDATE records SET canonical_json=${quoteSql(after.canonical_json)} WHERE id=${row.id};
    INSERT INTO __enrichment_effects (updated) VALUES (changes());`);
  let checked = false;
  const commit = () => commitEnrichmentUpdates(f.db, updates, { dryRun: false, reason: 'synthetic-review-test', label: 'synthetic reviewed names',
    reviewFence: reviewed.fence, reviewBeforeCommit: () => {
      reviewed.assertBinding(); checked = true;
      if (drift) sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.last_hot_snapshot_id','hot_synthetic_race') WHERE id=${quoteSql(SCOPE)};`);
    },
  });
  if (drift) { assert.throws(commit, /CHECK constraint failed/); noWrites(f, before); }
  else assert.deepEqual(commit(), { updated: 2, skippedConflicts: 0 });
  assert.equal(checked, true);
});

test('names review reuses one lookup, displays exact authority and presence, and approved apply refetches then commits atomically', t => {
  const f = fixture(t);
  sql(f, `UPDATE records SET canonical_json=json_remove(canonical_json,'$.sender_name') WHERE id=${f.ids[0]};
    UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name',null) WHERE id=${f.ids[1]};`);
  const before = ro(f), bytes = readFileSync(f.db), opts = nameOptions(f);
  const preview = names(f, opts); publicReport(preview);
  assert.equal(preview.review.changes, 2); assert.equal(preview.updated, 0); assert.equal(f.calls.length, 1);
  assert.deepEqual(readFileSync(f.db), bytes);
  const reviewed = readArtifact(opts.reviewOut);
  assert.equal(statSync(opts.reviewOut).mode & 0o777, 0o600);
  assert.equal(preview.review.sha256, hash(readFileSync(opts.reviewOut)));
  assert.deepEqual(reviewed.records.map(r => r.display.before.sender.sender_name), [{ present: false, value: null }, { present: true, value: null }]);
  for (const record of reviewed.records) {
    assert.match(record.display.after.sender.sender_name.value, /^Synthetic Reader/);
    assert.equal(record.display.after.sender.sender_name_source.value, 'contact');
    assert.equal(record.display.after.sender.sender_name_confidence.value, 'high');
    assert.equal(record.display.before.fields.external_version, record.display.after.fields.external_version);
    assert.deepEqual(record.changed_fields, ['canonical_json']);
    assert.deepEqual(record.opaque.changed_fields, ['canonical_json']);
    assert.equal(record.display.after.card, null);
  }
  assert.equal(reviewed.binding.verified_self_sha256, null, 'names does not add a self request');
  saveSyntheticExample('names', opts.reviewOut, preview);
  const result = names(f, approved(opts, preview)); publicReport(result);
  assert.equal(f.calls.length, 2); assert.equal(result.updated, 2); assert.equal(result.skipped_conflicts, 0);
  for (const [i, row] of ro(f).entries()) {
    assert.equal(JSON.parse(row.canonical_json).sender_name, reviewed.records[i].display.after.sender.sender_name.value);
    for (const key of Object.keys(row).filter(k => !['canonical_json', 'updated_at'].includes(k))) assert.equal(row[key], before[i][key]);
  }
  assert.throws(() => names(f, approved(opts, preview)), /snapshot_changed/, 'approval cannot silently repeat after its baseline changed');
});

test('card review uses final SQL merge, refetches without extra API, binds opaque changes, and applies the reviewed after', t => {
  const f = fixture(t, 2, true);
  sql(f, `UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name','Synthetic retained sender',
    '$.sender_name_source','contact','$.sender_name_confidence','high','$.chat_name','Synthetic retained chat','$.chat_name_source','message');`);
  const before = ro(f), bytes = readFileSync(f.db), opts = replayOptions(f);
  const preview = replay(f, undefined, opts); publicReport(preview);
  assert.equal(preview.ok, true); assert.equal(preview.review.changes, 2); assert.equal(f.calls.length, 2);
  assert.deepEqual(readFileSync(f.db), bytes);
  const artifact = readArtifact(opts.reviewOut);
  assert.equal(artifact.schema, 'exocortex_private_maintenance_review/v4');
  assert.equal(artifact.binding.verified_self_sha256, hash(SELF.open_id));
  for (const record of artifact.records) {
    assert.match(record.display.before.card.text, /Synthetic card before/);
    assert.match(record.display.after.card.text, /Synthetic card after/);
    assert.equal(record.display.after.sender.sender_name.value, 'Synthetic retained sender');
    assert.equal(record.display.after.canonical.chat_name.value, 'Synthetic retained chat');
    assert.notEqual(record.display.before.fields.external_version, record.display.after.fields.external_version);
    for (const field of ['body', 'raw_json', 'canonical_json', 'content_hash']) assert.ok(record.opaque.changed_fields.includes(field));
  }
  assert.equal(artifact.disclosure.card_text, 'rendered_api_projection_not_the_stored_body_column_or_business_approval');
  saveSyntheticExample('card', opts.reviewOut, preview);
  const result = replay(f, undefined, approved(opts, preview)); publicReport(result);
  assert.equal(result.ok, true); assert.equal(result.scopes[0].updated, 2); assert.equal(f.calls.length, 4);
  for (const [i, row] of ro(f).entries()) {
    assert.equal(hash(row.raw_json), artifact.records[i].opaque.after.raw_json.sha256);
    assert.equal(hash(row.canonical_json), artifact.records[i].opaque.after.canonical_json.sha256);
    assert.equal(row.id, before[i].id);
  }
});

for (const kind of ['text', 'post', 'system', 'general_calendar', 'video_chat']) {
  test(`${kind} exact replay publishes complete stored text in v4 and approved apply preserves the reviewed result`, t => {
    const f = fixture(t, 1, kind), before = ro(f), dbBytes = readFileSync(f.db), opts = replayOptions(f);
    const messages = [message(f, 0, kind, { update_time: String(f.start + 20_000),
      body: { content: JSON.stringify(nonCardContent(kind, 'Synthetic non-card after\n完整正文🙂')) } })];
    const preview = replay(f, messages, opts); publicReport(preview);
    assert.equal(preview.ok, true); assert.equal(preview.review.changes, 1); assert.equal(f.calls.length, 2);
    assert.deepEqual(readFileSync(f.db), dbBytes); noWrites(f, before);
    const artifact = readArtifact(opts.reviewOut), record = artifact.records[0];
    assert.equal(artifact.schema, 'exocortex_private_maintenance_review/v4');
    assert.equal(preview.review.schema, artifact.schema);
    assert.match(artifact.disclosure.non_card_text, /exact_stored_title_and_body/);
    assert.deepEqual(record.display.before.non_card, { title: before[0].title, body: before[0].body });
    assert.equal(record.display.before.card, null); assert.equal(record.display.after.card, null);
    assert.match(record.display.after.non_card.body, /Synthetic non-card after/);
    assert.match(record.display.after.non_card.body, /完整正文🙂/);
    assert.ok(record.changed_fields.includes('body'));
    const result = replay(f, messages, approved(opts, preview)); publicReport(result);
    assert.equal(result.ok, true); assert.equal(f.calls.length, 4);
    const after = ro(f)[0];
    assert.deepEqual(record.display.after.non_card, { title: after.title, body: after.body });
    assert.equal(hash(after.body), record.opaque.after.body.sha256);
  });
}

test('non-card same-version conflicts show the complete retained body, and new remote drift blocks apply', t => {
  const f = fixture(t, 1), before = ro(f), opts = replayOptions(f);
  const changed = message(f, 0, false, { update_time: String(f.start + 20_000), body: { content: JSON.stringify({ text: 'Synthetic approved text' }) } });
  const preview = replay(f, [changed], opts); assert.equal(preview.ok, true);
  const drifted = message(f, 0, false, { update_time: String(f.start + 20_000), body: { content: JSON.stringify({ text: 'Synthetic unapproved text' }) } });
  const result = replay(f, [drifted], approved(opts, preview));
  assert.equal(result.ok, false); assert.match(JSON.stringify(result), /proposal_changed/); noWrites(f, before);
  const conflictOpts = replayOptions(f, { reviewOut: join(f.dir, 'conflict.json') });
  const conflict = replay(f, [message(f, 0, false, { body: { content: JSON.stringify({ text: 'Synthetic equal-version conflict' }) } })], conflictOpts);
  assert.equal(conflict.ok, true); assert.equal(conflict.review.changes, 0);
  const record = readArtifact(conflictOpts.reviewOut).records[0];
  assert.equal(record.outcome, 'conflict'); assert.deepEqual(record.display.after, record.display.before);
});

test('mixed replay retains strict interactive rendering and cannot disguise a card as plain text', t => {
  const f = fixture(t, 2), opts = replayOptions(f), before = ro(f);
  const messages = [message(f, 0, false, { update_time: String(f.start + 20_000) }), incoming(f, 1)];
  const preview = replay(f, messages, opts); assert.equal(preview.ok, true);
  const artifact = readArtifact(opts.reviewOut);
  assert.equal(artifact.schema, 'exocortex_private_maintenance_review/v4');
  assert.equal(artifact.records[1].display.after.non_card, null);
  assert.match(artifact.records[1].display.after.card.text, /Synthetic card after/);
  const malformed = replay(f, [messages[0], incoming(f, 1, '', { body: { content: JSON.stringify({ unsupported: true }) } })],
    replayOptions(f, { reviewOut: join(f.dir, 'partial.json') }));
  assert.equal(malformed.ok, false); assert.match(JSON.stringify(malformed), /incomplete_card/);
  assert.equal(existsSync(join(f.dir, 'partial.json')), false); noWrites(f, before);
  const raw = JSON.parse(before[0].raw_json); (raw.raw_api || raw).msg_type = 'interactive';
  sql(f, `UPDATE records SET raw_json=${quoteSql(JSON.stringify(raw))} WHERE id=${f.ids[0]};`);
  const disguised = replay(f, messages, replayOptions(f, { reviewOut: join(f.dir, 'disguised.json') }));
  assert.equal(disguised.ok, false); assert.match(JSON.stringify(disguised), /invalid_file/);
  assert.equal(existsSync(join(f.dir, 'disguised.json')), false);
});

for (const mutation of ['hide_body', 'unknown_field', 'schema_downgrade', 'change_display']) {
  test(`v3 approval rejects ${mutation} before writing`, t => {
    const f = fixture(t, 1), opts = replayOptions(f), before = ro(f);
    const messages = [message(f, 0, false, { update_time: String(f.start + 20_000) })];
    const preview = replay(f, messages, opts); assert.equal(preview.ok, true);
    const input = approved(opts, preview);
    input.reviewSha256 = rewrite(opts.reviewOut, artifact => {
      if (mutation === 'hide_body') delete artifact.records[0].display.after.non_card;
      if (mutation === 'unknown_field') artifact.records[0].display.after.non_card.hidden = 'Synthetic hidden';
      if (mutation === 'schema_downgrade') artifact.schema = 'exocortex_private_maintenance_review/v1';
      if (mutation === 'change_display') artifact.records[0].display.after.non_card.body = 'Synthetic edited display';
    });
    const calls = f.calls.length;
    if (mutation === 'change_display') {
      const result = replay(f, messages, input); assert.equal(result.ok, false); assert.match(JSON.stringify(result), /proposal_changed/);
    } else { assert.throws(() => replay(f, messages, input), /invalid_file/); assert.equal(f.calls.length, calls); }
    noWrites(f, before);
  });
}

test('equal and older replay proposals expose stored final after and cannot become empty approved writes', t => {
  const f = fixture(t, 2, true), opts = replayOptions(f);
  const messages = [incoming(f, 0, 'Synthetic incoming equal but different', { update_time: f.messages[0].update_time }),
    incoming(f, 1, 'Synthetic incoming older', { update_time: String(f.start) })];
  const before = ro(f), preview = replay(f, messages, opts);
  assert.equal(preview.ok, true); assert.equal(preview.review.changes, 0);
  for (const record of readArtifact(opts.reviewOut).records) {
    assert.equal(record.outcome, 'conflict'); assert.deepEqual(record.changed_fields, []);
    assert.deepEqual(record.display.before, record.display.after);
  }
  const apply = replay(f, messages, approved(opts, preview));
  assert.equal(apply.ok, false); assert.match(JSON.stringify(apply), /no_changes/); noWrites(f, before);
});

for (const mutate of ['bytes', 'duplicate_key', 'unknown_key', 'future', 'expired', 'targets', 'budget', 'binding', 'baseline', 'scope', 'same_version_body']) {
  test(`approval rejects ${mutate} before any API or business write`, t => {
    const f = fixture(t), opts = nameOptions(f), preview = names(f, opts), input = approved(opts, preview);
    if (mutate === 'bytes') writeFileSync(opts.reviewOut, readFileSync(opts.reviewOut, 'utf8').trimEnd());
    if (mutate === 'duplicate_key') writeFileSync(opts.reviewOut, readFileSync(opts.reviewOut, 'utf8').replace('"mode": "names"', '"mode": "replay", "mode": "names"'));
    if (mutate === 'unknown_key') input.reviewSha256 = rewrite(opts.reviewOut, value => { value.sql = 'DELETE FROM records'; });
    if (mutate === 'future' || mutate === 'expired') input.reviewSha256 = rewrite(opts.reviewOut, value => {
      value.created_at_ms = Date.now() + (mutate === 'future' ? 60_000 : -REVIEW_AGE_MS - 60_000); value.expires_at_ms = value.created_at_ms + REVIEW_AGE_MS;
    });
    if (mutate === 'targets') input.recordIds = [f.ids[0]];
    if (mutate === 'budget') input.maxSeconds++;
    if (mutate === 'binding') {
      input.db = join(f.dir, 'copied.sqlite'); sql(f, `.backup ${quoteSql(input.db)}\n`);
      sqliteExec(input.db, 'PRAGMA journal_mode=DELETE;', 'prepare standalone authored backup');
      assert.equal(sqliteQuery(input.db, 'SELECT COUNT(*) AS n FROM records;', 'check authored backup')[0].n, 2);
    }
    if (mutate === 'baseline') sql(f, "UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',1);");
    if (mutate === 'scope') sql(f, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.chat_name','changed') WHERE id=${quoteSql(SCOPE)};`);
    if (mutate === 'same_version_body') sql(f, `UPDATE records SET body='Synthetic same-version drift' WHERE id=${f.ids[1]};`);
    const before = ro(f), calls = f.calls.length;
    assert.throws(() => names(f, input), /maintenance review rejected/);
    assert.equal(f.calls.length, calls); noWrites(f, before);
  });
}

for (const kind of ['names', 'replay']) {
  test(`${kind} fresh content drift rejects the entire approved proposal`, t => {
    const f = fixture(t, 2, kind === 'replay'), before = ro(f);
    const opts = kind === 'names' ? nameOptions(f) : replayOptions(f);
    const preview = kind === 'names' ? names(f, opts) : replay(f, undefined, opts);
    if (kind === 'names') assert.throws(() => names(f, approved(opts, preview), { runLark: args => ({ users: args[args.indexOf('--user-ids') + 1].split(',')
      .map(open_id => ({ open_id, name: 'Synthetic changed name' })) }) }), /proposal_changed/);
    else {
      const result = replay(f, [incoming(f), incoming(f, 1, 'Synthetic changed after preview')], approved(opts, preview));
      assert.equal(result.ok, false); assert.match(JSON.stringify(result), /proposal_changed/);
    }
    noWrites(f, before);
  });
}

for (const content of [ { arbitrary: 'RAW_SECRET_UNSUPPORTED' }, card('<at id="ou_synthetic_missing">ignored</at>'), card('x'.repeat(17_000)) ]) {
  test(`incomplete card projection never publishes a review (${JSON.stringify(content).length} source chars)`, t => {
    const f = fixture(t, 1, true), opts = replayOptions(f), before = ro(f);
    const result = replay(f, [incoming(f, 0, '', { body: { content: JSON.stringify(content) } })], opts);
    assert.equal(result.ok, false); assert.match(JSON.stringify(result), /incomplete_card/);
    assert.equal(existsSync(opts.reviewOut), false); noWrites(f, before); publicReport(result);
  });
}

test('card before partial also refuses review and valid omitted interactions do not leak callback values', t => {
  const f = fixture(t, 1, true), opts = replayOptions(f);
  const original = ro(f)[0];
  const raw = JSON.parse(original.raw_json), native = raw.raw_api || raw;
  native.body.content = JSON.stringify({ arbitrary: 'RAW_SECRET_BEFORE' });
  sql(f, `UPDATE records SET raw_json=${quoteSql(JSON.stringify(raw))} WHERE id=${f.ids[0]};`);
  assert.equal(replay(f, undefined, opts).ok, false); assert.equal(existsSync(opts.reviewOut), false);
  sql(f, `UPDATE records SET raw_json=${quoteSql(original.raw_json)} WHERE id=${f.ids[0]};`);
  const content = { elements: [{ tag: 'markdown', content: 'Synthetic card visible' }, { tag: 'action', actions: [
    { tag: 'button', text: { tag: 'plain_text', content: 'Synthetic action' }, value: { secret: 'RAW_SECRET_CALLBACK' } }] }] };
  const result = replay(f, [incoming(f, 0, '', { body: { content: JSON.stringify(content) } })], opts);
  assert.equal(result.ok, true); assert.doesNotMatch(readFileSync(opts.reviewOut, 'utf8'), /RAW_SECRET_CALLBACK/);
  assert.ok(readArtifact(opts.reviewOut).records[0].display.after.card.omitted_actions > 0);
});

for (const mode of ['public_parent', 'symlink_parent', 'existing', 'symlink', 'public_input', 'hardlink_input', 'oversize']) {
  test(`private artifact paths reject ${mode}`, t => {
    const f = fixture(t), opts = nameOptions(f);
    if (mode === 'public_parent') chmodSync(f.dir, 0o755);
    if (mode === 'symlink_parent') { const alias = join(f.dir, 'alias'); symlinkSync(f.dir, alias); opts.reviewOut = join(alias, 'new.json'); }
    if (mode === 'existing') writeFileSync(opts.reviewOut, 'sentinel', { mode: 0o600 });
    if (mode === 'symlink') symlinkSync(f.db, opts.reviewOut);
    if (['public_parent', 'symlink_parent', 'existing', 'symlink'].includes(mode)) {
      assert.throws(() => names(f, opts), /unsafe_path/); assert.equal(f.calls.length, 0); return;
    }
    const preview = names(f, opts), input = approved(opts, preview), calls = f.calls.length;
    if (mode === 'public_input') chmodSync(opts.reviewOut, 0o644);
    if (mode === 'hardlink_input') linkSync(opts.reviewOut, join(f.dir, 'linked.json'));
    if (mode === 'oversize') writeFileSync(opts.reviewOut, ' '.repeat(1024 * 1024 + 1));
    assert.throws(() => names(f, input), /invalid_file/); assert.equal(f.calls.length, calls);
  });
}

test('name size, raw snapshot size and 100-target hard bounds fail closed', t => {
  const f = fixture(t, 1), opts = nameOptions(f);
  assert.throws(() => names(f, opts, { runLark: args => ({ users: [{ open_id: args[args.indexOf('--user-ids') + 1], name: '名'.repeat(350) }] }) }), /too_large/);
  assert.equal(existsSync(opts.reviewOut), false);
  sql(f, `UPDATE records SET raw_json=${quoteSql(JSON.stringify({ padding: 'x'.repeat(256 * 1024) }))};`);
  const calls = f.calls.length; assert.throws(() => names(f, opts), /too_large/); assert.equal(f.calls.length, calls);
  assert.throws(() => names(f, { ...opts, recordIds: Array.from({ length: 101 }, (_, i) => i + 1) }), /100/);
});

test('JSON null canonical of an excluded row is represented as missing without a crash', t => {
  const f = fixture(t, 1), opts = nameOptions(f);
  sql(f, `UPDATE records SET canonical_json='null', actor_id=NULL, raw_json='{}';`);
  const preview = names(f, opts); assert.equal(preview.partial, true);
  const row = readArtifact(opts.reviewOut).records[0];
  assert.equal(row.outcome, 'excluded'); assert.deepEqual(row.display.before.sender.sender_name, { present: false, value: null });
});

test('CLI requires explicit budgets, rejects incompatible modes and never echoes private review fields', t => {
  const f = fixture(t, 1), out = { text: '', write(value) { this.text += value; } }, err = { text: '', write(value) { this.text += value; } };
  const args = ['--db', f.db, '--target', 'records', '--names-only', '--record-id', String(f.ids[0]), '--review-out', join(f.dir, 'cli.json'), '--format', 'json'];
  function invoke(argv) {
    out.text = ''; err.text = '';
    const parsed = parseRouteOptions('maintenance.enrich', argv);
    return runMaintenanceCommand(parsed.options, { ...createCommandContext({ stdout: out, stderr: err }), provided: parsed.provided,
      deps: { runLark: () => ({ users: [{ open_id: 'ou_synthetic_review_peer_0', name: 'Synthetic Reader CLI' }] }) } });
  }
  assert.equal(invoke(args), 1); assert.match(out.text + err.text, /explicit/);
  assert.equal(invoke([...args, '--max-cli-attempts', '12', '--max-seconds', '30']), 0); publicReport(JSON.parse(out.text));
  for (const options of [ { namesOnly: false }, { unsafeDetails: true }, { apply: true }, { reviewSha256: 'a'.repeat(64) },
    { reviewSha256: '' },
    { reviewOut: undefined, reviewIn: join(f.dir, 'cli.json') }, { recordIds: [] } ]) {
    assert.throws(() => names(f, nameOptions(f, options)), /maintenance review rejected/);
  }
  assert.throws(() => replayOptions(f, { messageIds: [] }), /maintenance review rejected/);
  assert.throws(() => replayOptions(f, { scopeIds: [SCOPE, 'lark.im.received.chat.oc_other'] }), /one scope/);
});

test('same fresh name with a changed authority is not covered by the previous approval', t => {
  const f = fixture(t, 1), opts = nameOptions(f), before = ro(f), preview = names(f, opts);
  assert.throws(() => names(f, approved(opts, preview), { runLark: args => args[0] === 'contact' ? { users: [] }
    : { items: [{ member_id: 'ou_synthetic_review_peer_0', member_id_type: 'open_id', name: 'Synthetic Reader 0' }] } }), /proposal_changed/);
  noWrites(f, before);
});

test('a previously unresolved target becoming resolvable cannot expand the approved decision set', t => {
  const f = fixture(t), opts = nameOptions(f), before = ro(f);
  const preview = names(f, opts, { runLark: args => args[0] === 'contact'
    ? { users: [{ open_id: 'ou_synthetic_review_peer_0', name: 'Synthetic Reader 0' }] } : { items: [] } });
  assert.equal(preview.partial, true); assert.equal(preview.review.changes, 1);
  assert.equal(readArtifact(opts.reviewOut).records[1].outcome, 'unresolved');
  assert.throws(() => names(f, approved(opts, preview)), /proposal_changed/); noWrites(f, before);
});

test('review digest excludes run metadata and fences the complete selected baseline including updated_at', t => {
  const f = fixture(t, 1), opts = nameOptions(f), row = ro(f)[0];
  const scope = ro(f, `SELECT id,source_id,enabled,config_json FROM sync_scopes WHERE id=${quoteSql(SCOPE)};`);
  const after = { ...effectiveRecord(row), canonical_json: JSON.stringify({ ...JSON.parse(row.canonical_json), sender_name: 'Synthetic Reader Stable' }) };
  const preview = beginMaintenanceReview(opts, { db: f.db, mode: 'names', rows: [row], scopes: scope }).finish([{ before: row, after, outcome: 'update' }]);
  sql(f, `UPDATE sync_scopes SET cursor_json='{"synthetic_unrelated_progress":true}' WHERE id=${quoteSql(SCOPE)};`);
  const input = approved(opts, { review: preview.summary });
  const result = beginMaintenanceReview(input, { db: f.db, mode: 'names', rows: [row], scopes: scope }).finish([
    { before: row, after: { ...after, updated_at: 'ignored-new-runtime-metadata', received_at: 'ignored' }, outcome: 'update' }]);
  assert.ok(result.fence); assert.equal(result.summary.sha256, preview.summary.sha256);
  sql(f, `UPDATE records SET updated_at='Synthetic same-version metadata drift';`);
  assert.throws(() => beginMaintenanceReview(input, { db: f.db, mode: 'names', rows: ro(f), scopes: scope }), /snapshot_changed/);
});

test('total snapshot bytes and final artifact bytes have independent hard limits', t => {
  const f = fixture(t, 22), opts = nameOptions(f);
  sql(f, `UPDATE records SET raw_json=json_set(raw_json,'$.synthetic_padding',${quoteSql('x'.repeat(100_000))});`);
  assert.throws(() => names(f, opts), /too_large/); assert.equal(existsSync(opts.reviewOut), false);
  const g = fixture(t, 100), large = 's'.repeat(900);
  sql(g, `UPDATE records SET canonical_json=json_set(canonical_json,'$.sender_name',${quoteSql(large)},
    '$.sender_name_source',${quoteSql(large)},'$.sender_name_confidence',${quoteSql(large)},'$.sender_name_resolution_reason',${quoteSql(large)});`);
  assert.throws(() => names(g), /too_large/); assert.equal(existsSync(nameOptions(g).reviewOut), false);
  assert.equal(g.calls.length, 0, 'known names need no API even when output size is rejected');
});

test('failed final publication sync removes only the newly created artifact', t => {
  const f = fixture(t, 1), path = join(f.dir, 'failed-publication.json');
  let syncs = 0;
  assert.throws(() => publishReviewArtifact(path, { synthetic: true }, { sync: fd => {
    if (++syncs === 2) throw new Error('Synthetic directory fsync failure');
    fsyncSync(fd);
  } }), /publish_failed/);
  assert.equal(existsSync(path), false);
  assert.equal(readdirSync(f.dir).filter(name => name.startsWith('.maintenance-review-')).length, 0);
  assert.throws(() => publishReviewArtifact(path, { synthetic: true }, { sync: fd => {
    if (++syncs === 4) {
      rmSync(path); writeFileSync(path, 'Synthetic concurrent replacement', { mode: 0o600 });
      throw new Error('Synthetic failure after replacement');
    }
    fsyncSync(fd);
  } }), /publish_failed/);
  assert.equal(readFileSync(path, 'utf8'), 'Synthetic concurrent replacement');
});

test('binding is rechecked after planning at the actual approved commit boundary', t => {
  const f = fixture(t, 1), opts = nameOptions(f), preview = names(f, opts), before = ro(f);
  let checks = 0;
  assert.throws(() => names(f, approved(opts, preview), { assertReady: () => {
    if (++checks === 2) sql(f, `UPDATE sources SET config_json=json_set(config_json,'$.synthetic_binding_drift',true);`);
  } }), /binding_changed/);
  noWrites(f, before);
  // The database-file fence is checked again after planning, while the ordinary
  // SQL transaction retains its own full row/source/account fences. It does not
  // claim to prevent adversarial same-UID replacement between a stat and open.
  const g = fixture(t, 1), gopts = nameOptions(g), gpreview = names(g, gopts), oldRows = ro(g);
  let calls = 0;
  assert.throws(() => names(g, approved(gopts, gpreview), { assertReady: () => {
    if (++calls !== 2) return;
    const replacement = join(g.dir, 'replacement.sqlite');
    sql(g, `.backup ${quoteSql(replacement)}\n`);
    for (const suffix of ['-wal', '-shm']) rmSync(`${g.db}${suffix}`, { force: true });
    renameSync(replacement, g.db);
  } }), /binding_changed/);
  noWrites(g, oldRows);
});

for (const mode of ['names', 'replay']) {
  test(`${mode} actual workflow rolls back when the second row changes after the fresh review`, t => {
    const f = fixture(t, 2, mode === 'replay'), opts = mode === 'names' ? nameOptions(f) : replayOptions(f);
    const preview = mode === 'names' ? names(f, opts) : replay(f, undefined, opts);
    let drifted;
    const drift = () => {
      sql(f, `UPDATE records SET canonical_json=json_set(canonical_json,'$.synthetic_late_change',true) WHERE id=${f.ids[1]};`);
      drifted = ro(f);
    };
    if (mode === 'names') {
      let checkpoints = 0;
      assert.throws(() => names(f, approved(opts, preview), { assertReady: () => { if (++checkpoints === 2) drift(); } }), /CHECK constraint failed/);
    } else {
      const result = replay(f, undefined, approved(opts, preview), { commitBoundedReplayRecords: (db, options) => {
        drift(); return commitBoundedReplayRecords(db, options);
      } });
      assert.equal(result.ok, false);
    }
    assert.ok(drifted); noWrites(f, drifted);
  });
}

test('raw-only incoming drift is refused even when visible card text and version are identical', t => {
  const f = fixture(t, 1, true), opts = replayOptions(f), before = ro(f), preview = replay(f, undefined, opts);
  const changed = incoming(f, 0, 'Synthetic card after 0', { synthetic_callback: { secret: 'RAW_SECRET_ONLY_DRIFT' } });
  const result = replay(f, [changed], approved(opts, preview));
  assert.equal(result.ok, false); assert.match(JSON.stringify(result), /proposal_changed/);
  publicReport(result); noWrites(f, before);
});
