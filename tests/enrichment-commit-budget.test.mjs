import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureInitialized, INITIAL_ACCOUNT_KIND, quoteSql as q, sqliteExec, sqliteQuery }
  from '../dist/storage/sqlite/ingestion-store.js';
import { captureLarkWriteAdmission } from '../src/diagnostics/lark-write-admission.mjs';
import { commitEnrichmentUpdates, getEnrichmentCommitOutcome } from '../src/maintenance/enrichment-commit.mjs';
import { createHistoryCommandBudget, HistoryCommandBudgetError } from '../src/maintenance/history-command-budget.mjs';

// Entirely authored SQLite fixtures. The seam observes or faults only this
// test's synchronous SQLite calls; no API, service, user database or lease root
// is involved. Each replacement restores the original builtin in finally.
const SELF = 'ou_synthetic_enrichment_budget_owner';
const ACCOUNT = createHash('sha256').update(`lark.im\0${SELF}`).digest('hex');
const read = (db, sql) => sqliteQuery(db, sql, 'inspect synthetic enrichment budget');
const update = (id = 1, before = 'before', after = 'after') => `
  UPDATE synthetic_enrichment_values SET value=${q(after)} WHERE id=${id} AND value=${q(before)};
  INSERT INTO __enrichment_effects(updated) VALUES(changes());`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-enrichment-budget-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'authored.sqlite');
  ensureInitialized(db);
  const source = { initial_account_binding: { kind: INITIAL_ACCOUNT_KIND, account_key: ACCOUNT,
    reserved_at: '2025-01-01T00:00:00.000Z', confirmed_at: '2025-01-01T00:00:00.000Z' } };
  sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify(source))} WHERE id='lark.im';
    CREATE TABLE synthetic_enrichment_values(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO synthetic_enrichment_values VALUES(1,'before'),(2,'untouched neighbor');`);
  const values = () => read(db, 'SELECT * FROM synthetic_enrichment_values ORDER BY id;');
  const locks = () => read(db, 'SELECT owner FROM maintenance_locks ORDER BY name;');
  return { db, values, locks, before: values(), source };
}

function clock() {
  const state = { tick: 0 };
  return { state, budget: createHistoryCommandBudget({ maxSeconds: 5 }, { monotonicClock: () => state.tick }) };
}

function options(executionBudget, extra = {}) {
  return { dryRun: false, reason: 'synthetic_enrichment_budget', label: 'synthetic enrichment budget commit',
    ...(executionBudget ? { executionBudget } : {}), ...extra };
}

function phase(settings) {
  const sql = String(settings.input || '');
  if (sql.includes('INSERT OR IGNORE INTO maintenance_locks')) return 'acquire';
  if (sql.includes('CREATE TEMP TABLE __enrichment_effects')) return 'commit';
  if (sql.includes('DELETE FROM maintenance_locks') && sql.includes('AND owner =')) return 'release';
  return 'other';
}

function withSpawn(observer, work) {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, settings) => observer(original, command, args, settings);
  syncBuiltinESMExports();
  try { return work(); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
}

function caught(work) {
  let didThrow = false, error;
  try { work(); } catch (value) { didThrow = true; error = value; }
  assert.equal(didThrow, true, 'the failure must remain observable');
  return error;
}

function outcome(value, commitState, cleanupState) {
  const result = getEnrichmentCommitOutcome(value);
  assert.ok(result, 'the module must authenticate its own bounded outcome');
  assert.equal(result.commit_state, commitState);
  assert.equal(result.cleanup_state, cleanupState);
  if (commitState !== 'confirmed') {
    assert.equal(Object.hasOwn(result, 'updated'), false);
    assert.equal(Object.hasOwn(result, 'skippedConflicts'), false);
  }
  return result;
}

test('no-budget enrichment keeps exact counts, process options and unauthenticated legacy shape', t => {
  const f = fixture(t), seen = [];
  const result = withSpawn((run, command, args, settings) => {
    seen.push({ phase: phase(settings), settings }); return run(command, args, settings);
  }, () => commitEnrichmentUpdates(f.db, [update(), update(9)], options()));
  assert.deepEqual(result, { updated: 1, skippedConflicts: 1 });
  assert.equal(getEnrichmentCommitOutcome(result), null);
  assert.deepEqual(seen.map(call => call.phase), ['acquire', 'commit', 'release']);
  for (const { settings } of seen) {
    assert.equal(Object.hasOwn(settings, 'timeout'), false);
    assert.equal(Object.hasOwn(settings, 'killSignal'), false);
    assert.match(settings.input, /^\.bail on\n\.timeout 5000\n/);
  }
  assert.deepEqual(f.values(), [{ id: 1, value: 'after' }, f.before[1]]);
  assert.deepEqual(f.locks(), []);
});

for (const thrown of [new Error('synthetic legacy primary'), 'synthetic legacy primitive', undefined]) {
  test(`no-budget preserves the exact thrown value: ${typeof thrown}`, t => {
    const f = fixture(t);
    const error = caught(() => commitEnrichmentUpdates(f.db, [update()], options(undefined, {
      admissionBeforeCommit() { throw thrown; },
    })));
    assert.equal(error, thrown);
    assert.equal(getEnrichmentCommitOutcome(error), null);
    assert.deepEqual(f.values(), f.before); assert.deepEqual(f.locks(), []);
  });
}

test('one 5000ms budget supplies fresh acquisition, transaction and reserved cleanup deadlines', t => {
  const f = fixture(t), c = clock(), seen = [];
  const result = withSpawn((run, command, args, settings) => {
    seen.push({ phase: phase(settings), timeout: settings.timeout, killSignal: settings.killSignal, input: settings.input });
    const answer = run(command, args, settings); c.state.tick += 100; return answer;
  }, () => commitEnrichmentUpdates(f.db, [update()], options(c.budget)));
  assert.deepEqual(result, { updated: 1, skippedConflicts: 0 });
  assert.deepEqual(seen.map(x => [x.phase, x.timeout]), [['acquire', 4000], ['commit', 3900], ['release', 4700]]);
  for (const call of seen) {
    assert.equal(call.killSignal, 'SIGKILL');
    assert.equal(call.input.split('\n')[1], `.timeout ${call.timeout}`);
  }
  assert.deepEqual(outcome(result, 'confirmed', 'succeeded'), {
    commit_state: 'confirmed', cleanup_state: 'succeeded', updated: 1, skippedConflicts: 0,
  });
  assert.equal(c.budget.summary().max_ms, 5000); assert.equal(c.budget.summary().elapsed_ms, 300);
  assert.deepEqual(f.locks(), []);
});

test('expired work refuses acquisition before spawning and never opens a new deadline', t => {
  const f = fixture(t), c = clock(); c.state.tick = 4000;
  let spawns = 0;
  const error = withSpawn(() => { spawns++; assert.fail('no SQLite spawn after cutoff'); },
    () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget))));
  assert.ok(error instanceof HistoryCommandBudgetError); assert.equal(error.reason, 'time_budget');
  outcome(error, 'not_started', 'not_required'); assert.equal(spawns, 0);
  assert.deepEqual(f.values(), f.before); assert.deepEqual(f.locks(), []);
});

test('work expiry after acquisition prevents the transaction and uses only original cleanup reserve', t => {
  const f = fixture(t), c = clock(), seen = [];
  const error = withSpawn((run, command, args, settings) => {
    seen.push({ phase: phase(settings), timeout: settings.timeout }); return run(command, args, settings);
  }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget, {
    admissionBeforeCommit() { c.state.tick = 4100; },
  }))));
  assert.ok(error instanceof HistoryCommandBudgetError);
  outcome(error, 'not_started', 'succeeded');
  assert.deepEqual(seen.map(x => x.phase), ['acquire', 'release']);
  assert.equal(seen[1].timeout, 800);
  assert.deepEqual(f.values(), f.before); assert.deepEqual(f.locks(), []);
});

for (const missingReceipt of [false, true]) test(`unknown acquisition cleans its possibly committed owner: missing receipt ${missingReceipt}`, t => {
  const f = fixture(t), c = clock(), seen = [];
  const error = withSpawn((run, command, args, settings) => {
    seen.push(phase(settings)); const answer = run(command, args, settings);
    if (phase(settings) === 'acquire') {
      assert.equal(answer.status, 0);
      return missingReceipt ? { ...answer, stdout: '[]' }
        : { ...answer, status: null, error: Object.assign(new Error('synthetic lost acquisition result'), { code: 'ETIMEDOUT' }) };
    }
    return answer;
  }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget))));
  outcome(error, 'not_started', 'succeeded');
  assert.deepEqual(seen, ['acquire', 'release']);
  assert.deepEqual(f.values(), f.before); assert.deepEqual(f.locks(), []);
});

test('owner-qualified cleanup preserves a replacement owner after uncertain acquisition', t => {
  const f = fixture(t), c = clock();
  const error = withSpawn((run, command, args, settings) => {
    const answer = run(command, args, settings);
    if (phase(settings) === 'acquire') {
      assert.equal(answer.status, 0);
      sqliteExec(f.db, "UPDATE maintenance_locks SET owner='synthetic_replacement_owner';");
      return { ...answer, status: null, signal: 'SIGKILL' };
    }
    return answer;
  }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget))));
  outcome(error, 'not_started', 'succeeded');
  assert.deepEqual(f.values(), f.before);
  assert.deepEqual(f.locks(), [{ owner: 'synthetic_replacement_owner' }]);
});

test('known foreign lock contention never releases another owner or starts a transaction', t => {
  const f = fixture(t), c = clock(), seen = [];
  sqliteExec(f.db, `INSERT INTO maintenance_locks(name,owner,acquired_at,expires_at,reason)
    VALUES('global','synthetic_foreign_owner','2025-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','synthetic');`);
  const error = withSpawn((run, command, args, settings) => {
    seen.push(phase(settings)); return run(command, args, settings);
  }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget))));
  outcome(error, 'not_started', 'not_required'); assert.deepEqual(seen, ['acquire']);
  assert.deepEqual(f.values(), f.before); assert.deepEqual(f.locks(), [{ owner: 'synthetic_foreign_owner' }]);
});

test('parseable output after an unknown commit result cannot report confirmed or claim rollback', t => {
  const f = fixture(t), c = clock();
  const error = withSpawn((run, command, args, settings) => {
    const answer = run(command, args, settings);
    if (phase(settings) === 'commit') {
      assert.equal(answer.status, 0); assert.equal(JSON.parse(answer.stdout)[0].updated, 1);
      return { ...answer, status: null, signal: 'SIGKILL' };
    }
    return answer;
  }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget))));
  outcome(error, 'unknown', 'succeeded');
  assert.deepEqual(f.values(), [{ id: 1, value: 'after' }, f.before[1]], 'actual COMMIT survives a lost process result');
  assert.deepEqual(f.locks(), []);
});

for (const receipt of ['', '[]', '[{}]', '[{"updated":"1"}]', '[{"updated":-1}]', '[{"updated":2}]', '[{"updated":1},{"updated":0}]', 'synthetic-invalid-json']) {
  test(`untrusted commit receipt remains unknown: ${receipt || 'empty stdout'}`, t => {
    const f = fixture(t), c = clock();
    const error = withSpawn((run, command, args, settings) => {
      const answer = run(command, args, settings);
      return phase(settings) === 'commit' ? { ...answer, stdout: receipt } : answer;
    }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget))));
    outcome(error, 'unknown', 'succeeded');
    assert.equal(f.values()[0].value, 'after', 'invalid receipt is not evidence of rollback');
    assert.deepEqual(f.locks(), []);
  });
}

for (const primaryFails of [false, true]) test(`release failure preserves primary or confirmed effects: primary ${primaryFails}`, t => {
  const f = fixture(t), c = clock(), primary = new Error('synthetic admission lease lost');
  sqliteExec(f.db, `CREATE TRIGGER synthetic_release_denied BEFORE DELETE ON maintenance_locks
    BEGIN SELECT RAISE(ABORT,'synthetic release failure'); END;`);
  const action = () => commitEnrichmentUpdates(f.db, [update(), update(9)], options(c.budget, {
    admissionBeforeCommit() { if (primaryFails) throw primary; },
  }));
  const value = primaryFails ? caught(action) : action();
  if (primaryFails) assert.equal(value, primary, 'cleanup must not replace the original failure');
  else assert.deepEqual(value, { updated: 1, skippedConflicts: 1 });
  const receipt = outcome(value, primaryFails ? 'not_started' : 'confirmed', 'unknown');
  if (!primaryFails) { assert.equal(receipt.updated, 1); assert.equal(receipt.skippedConflicts, 1); }
  assert.match(receipt.cleanup_error.message, /synthetic release failure/);
  assert.equal(f.values()[0].value, primaryFails ? 'before' : 'after');
  assert.equal(f.locks().length, 1);
});

test('confirmed commit survives exhausted cleanup reservation without any late release spawn', t => {
  const f = fixture(t), c = clock(), seen = [];
  const result = withSpawn((run, command, args, settings) => {
    seen.push(phase(settings)); const answer = run(command, args, settings);
    if (phase(settings) === 'commit') c.state.tick = 5000;
    return answer;
  }, () => commitEnrichmentUpdates(f.db, [update()], options(c.budget)));
  assert.deepEqual(result, { updated: 1, skippedConflicts: 0 });
  const receipt = outcome(result, 'confirmed', 'failed');
  assert.ok(receipt.cleanup_error instanceof HistoryCommandBudgetError);
  assert.deepEqual(seen, ['acquire', 'commit']);
  assert.equal(f.values()[0].value, 'after'); assert.equal(f.locks().length, 1);
  assert.equal(c.budget.summary().max_ms, 5000);
});

test('successful release with a lost child result stays unknown without undoing confirmed counts', t => {
  const f = fixture(t), c = clock();
  const result = withSpawn((run, command, args, settings) => {
    const answer = run(command, args, settings);
    return phase(settings) === 'release' ? { ...answer, status: null, signal: 'SIGKILL' } : answer;
  }, () => commitEnrichmentUpdates(f.db, [update()], options(c.budget)));
  assert.deepEqual(result, { updated: 1, skippedConflicts: 0 });
  assert.ok(outcome(result, 'confirmed', 'unknown').cleanup_error instanceof Error);
  assert.deepEqual(f.locks(), []);
});

test('outcome authentication cannot be forged or rewritten through a returned copy', t => {
  for (const value of [null, undefined, 7, { commit_state: 'confirmed', updated: 1 },
    Object.assign(new Error('synthetic forged receipt'), { commit_state: 'confirmed', updated: 1 })]) {
    assert.equal(getEnrichmentCommitOutcome(value), null);
  }
  const f = fixture(t), c = clock();
  const result = commitEnrichmentUpdates(f.db, [update()], options(c.budget));
  const first = outcome(result, 'confirmed', 'succeeded'); first.updated = 999; first.commit_state = 'unknown';
  assert.equal(outcome(result, 'confirmed', 'succeeded').updated, 1);
  assert.equal(getEnrichmentCommitOutcome({ ...result }), null);
});

for (const mutation of ['account', 'source', 'maintenance owner', 'maintenance expiry', 'sync lock']) {
  test(`final transaction refuses ${mutation} changed after the last admission check`, t => {
    const f = fixture(t), c = clock();
    const admission = captureLarkWriteAdmission(f.db, { selfOpenId: SELF, requireVerified: true });
    const changes = {
      account: "UPDATE sources SET config_json=json_set(config_json,'$.initial_account_binding.account_key','" + 'b'.repeat(64) + "') WHERE id='lark.im';",
      source: "UPDATE sources SET config_json=json_set(config_json,'$.synthetic_revision',2) WHERE id='lark.im';",
      'maintenance owner': "UPDATE maintenance_locks SET owner='synthetic_fence_replacement';",
      'maintenance expiry': "UPDATE maintenance_locks SET expires_at='2000-01-01T00:00:00.000Z';",
      'sync lock': "INSERT INTO sync_locks(scope_id,locked_by,locked_at,expires_at) VALUES('lark.im.sent_by_me','synthetic_other_writer','2025-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');",
    };
    let checked = false, mutated = false;
    const error = withSpawn((run, command, args, settings) => {
      if (phase(settings) === 'commit') {
        assert.equal(checked, true); assert.equal(mutated, false); mutated = true;
        sqliteExec(f.db, changes[mutation], 'synthetic contender after JS check');
      }
      return run(command, args, settings);
    }, () => caught(() => commitEnrichmentUpdates(f.db, [update()], options(c.budget, {
      writeAdmission: admission.fence,
      admissionBeforeCommit() { admission.assertCurrent(); checked = true; },
    }))));
    assert.equal(mutated, true); outcome(error, 'unknown', 'succeeded');
    assert.deepEqual(f.values(), f.before, 'the real SQLite guard aborts all authored business updates');
    if (mutation === 'maintenance owner') assert.deepEqual(f.locks(), [{ owner: 'synthetic_fence_replacement' }]);
    else assert.deepEqual(f.locks(), []);
  });
}

test('an update-level error rolls back earlier effects while retaining the unconfirmed result', t => {
  const f = fixture(t), c = clock();
  const error = caught(() => commitEnrichmentUpdates(f.db, [update(), 'INSERT INTO synthetic_missing_table VALUES(1);'], options(c.budget)));
  outcome(error, 'unknown', 'succeeded');
  assert.deepEqual(f.values(), f.before); assert.deepEqual(f.locks(), []);
});
