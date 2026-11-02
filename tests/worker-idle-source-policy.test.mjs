import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storage from '../dist/storage/sqlite/ingestion-store.js';
import { recipientAccountKey } from '../src/adapters/lark-im/p2p-recipient.mjs';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { readOnlySqliteJson } from '../src/storage/sqlite/readonly-query.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';
import { idleAdmission } from '../src/runtime/worker/idle-admission.mjs';
import { compactSummary, cycleHealthyWithoutHistory } from '../dist/runtime/worker/lark-im-worker-core.js';
import { REQUIRED_CYCLE_STEPS } from '../src/runtime/worker/step-vocabulary.mjs';

const START = Date.parse('2026-01-01T00:00:00Z');
const SELF = 'ou_synthetic_idle_source_owner', SCOPE = 'lark.im.sent_by_me';
const q = storage.quoteSql;
function transport(calls) {
  const counters = { calls, attempts: calls, retries: 0, rate_limits: 0, timeouts: 0,
    wait_ms: 0, max_retry_after_ms: 0, cooldown_until_ms: 0, exhausted: 0, retry_after_unknown: 0 };
  return { ...counters, by_operation: calls ? { message_search_bundle: { ...counters } } : {}, cooldowns_by_operation: {} };
}

for (const mutation of ['unchanged', 'source_policy', 'account', 'disabled', 'scope',
  'source_bytes_only', 'source_and_mutable_fence', 'metadata_unavailable', 'metadata_missing']) {
  test(`real committed list with one request withholds stale idle admission: ${mutation}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-idle-source-policy-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const db = join(dir, 'authored.sqlite');
    const now = new Date().toISOString(), future = new Date(Date.now() + 3600000).toISOString();
    storage.ensureInitialized(db);
    storage.sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START}) WHERE id='lark.im';`);
    storage.reserveInitialLarkAccount(db, recipientAccountKey(SELF), now);
    storage.sqliteExec(db, storage.confirmInitialLarkAccountSql(now));
    storage.sqliteExec(db, `INSERT INTO lark_im_detail_tasks
      (scope_id,message_id,raw_root_json,fingerprint,occurred_at_ms,status,attempt_count,retry_at,created_at,updated_at)
      VALUES(${q(SCOPE)},'om_synthetic_idle_old_debt','{}','synthetic-fingerprint',${START - 60000},
        'pending',1,${q(future)},${q(now)},${q(now)});`);
    const admission = captureLarkWriteAdmission(db, { selfOpenId: SELF, requireVerified: true, scopeIds: [SCOPE] });
    const readSource = () => storage.sqliteQuery(db, "SELECT config_json FROM sources WHERE id='lark.im';")[0].config_json;
    const sourceBefore = readSource(), debtBefore = storage.sqliteQuery(db, 'SELECT * FROM lark_im_detail_tasks;');
    let listCalls = 0, detailCalls = 0, releases = 0, metadataReads = 0;
    let committedProgress, committedRuns;
    const runner = createSyncRunner({
      // Only this remote boundary is fake. Storage, list commit and scope locks
      // are real and private to the authored database; no API lease is acquired.
      fetchSentMessageList: () => { listCalls++; return { messages: [], detailRoots: [], pages: 1 }; },
      fetchMessageDetails: () => { detailCalls++; throw new Error('unexpected synthetic detail request'); },
      releaseLock: (...args) => {
        storage.releaseLock(...args); releases++;
        assert.equal(storage.sqliteQuery(db, 'SELECT COUNT(*) n FROM sync_locks;')[0].n, 0);
        committedProgress = storage.sqliteQuery(db, 'SELECT * FROM lark_im_list_progress;');
        committedRuns = storage.sqliteQuery(db, 'SELECT * FROM sync_runs;');
        assert.equal(committedProgress.length, 1, 'real list coverage was committed before source mutation');
        assert.equal(committedRuns.length, 1);
        assert.equal(committedRuns[0].status, 'succeeded');
        assert.equal(committedRuns[0].error_type, null);
        if (mutation === 'source_policy' || mutation === 'source_and_mutable_fence') {
          storage.sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_sync_start_ms',${START + 86400000}) WHERE id='lark.im';`);
          if (mutation === 'source_and_mutable_fence') admission.fence.sourceConfigJson = readSource();
        } else if (mutation === 'account') {
          storage.sqliteExec(db, `UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key',
            ${q(recipientAccountKey('ou_synthetic_idle_other_owner'))}) WHERE id='lark.im';`);
        } else if (mutation === 'disabled') {
          storage.sqliteExec(db, "UPDATE sources SET enabled=0 WHERE id='lark.im';");
        } else if (mutation === 'scope') {
          storage.sqliteExec(db, `UPDATE sync_scopes SET config_json=json_set(config_json,'$.synthetic_scope_revision',1) WHERE id=${q(SCOPE)};`);
        } else if (mutation === 'source_bytes_only') {
          storage.sqliteExec(db, "UPDATE sources SET config_json=' ' || config_json WHERE id='lark.im';");
          assert.deepEqual(JSON.parse(readSource()), JSON.parse(sourceBefore));
        }
      },
      readOnlySqliteJson: (path, sql, label, options) => {
        metadataReads++;
        assert.equal(releases, 1, 'proof query follows successful actual release');
        assert.equal(path, db); assert.equal(options.timeoutMs, 500);
        assert.match(sql, /CAST\(config_json AS BLOB\)/);
        assert.doesNotMatch(sql, /raw_root_json/);
        if (mutation === 'metadata_unavailable') throw new Error('synthetic metadata read unavailable');
        if (mutation === 'metadata_missing') return [];
        return readOnlySqliteJson(path, sql, label, options);
      },
    });
    const run = runner.syncSent(db, { startMs: START, endMs: START + 60000, endExplicit: true,
      stableHorizonSeconds: 0, pageSize: 50, maxPages: 1, lockTtlSeconds: 600,
      retries: 0, retryDelayMs: 0, writeAdmission: admission }, { open_id: SELF, name: 'Synthetic Owner' });
    assert.equal(listCalls, 1); assert.equal(detailCalls, 0); assert.equal(releases, 1);
    assert.equal(metadataReads, ['disabled', 'scope'].includes(mutation) ? 0 : 1);
    assert.equal(run.list_complete, true); assert.equal(run.ok, false); assert.equal(run.incomplete, true);
    assert.equal(run.details_complete, false); assert.equal(run.pending_details, 1);
    assert.deepEqual(run.detail_retry, { ok: false, skipped: true, reason: 'details_not_due', detail_attempts: 0 });
    assert.deepEqual(storage.sqliteQuery(db, 'SELECT * FROM lark_im_list_progress;'), committedProgress);
    assert.deepEqual(storage.sqliteQuery(db, 'SELECT * FROM sync_runs;'), committedRuns);
    assert.deepEqual(storage.sqliteQuery(db, 'SELECT * FROM lark_im_detail_tasks;'), debtBefore);
    const raw = { ok: false, partial: true, incomplete: true, sent: run, received: [], transport: transport(listCalls) };
    assert.equal(raw.transport.calls, 1); assert.equal(raw.transport.attempts, 1);
    assert.equal(raw.transport.by_operation.message_search_bundle.calls, 1);
    const steps = REQUIRED_CYCLE_STEPS.map((name, i) => ({ name, ok: i !== 0,
      exit_code: i === 0 ? 2 : 0, stderr: '', ...(i === 0 ? { partial: true } : {}),
      summary: compactSummary(i === 0 ? raw : { ok: true, transport: transport(0) }) }));
    assert.equal(cycleHealthyWithoutHistory(steps, true), false);
    if (mutation === 'unchanged') {
      assert.deepEqual(run.idle_detail_backoff, { version: 1, kind: 'saved_list_backoff', pending_details: 1, detail_attempts: 0 });
      assert.equal(idleAdmission(steps).mode, 'known_records');
    } else {
      assert.equal(run.idle_detail_backoff, undefined, 'post-list source policy change must withhold old backoff proof');
      assert.equal(idleAdmission(steps).mode, 'none');
    }
  });
}
