import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCli } from '../bin/exocortex.mjs';
import { runCheckCommand } from '../src/cli/check-command.mjs';
import { ensureInitialized, sqliteExec } from '../dist/storage/sqlite/ingestion-store.js';
import { buildStatus } from '../src/diagnostics/sync-status-report.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), AT = Date.parse('2030-01-02T12:00:00Z');
const hash = db => createHash('sha256').update(readFileSync(db)).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-check-dependencies-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'synthetic.sqlite');
  ensureInitialized(db);
  sqliteExec(db, `INSERT INTO sync_runs(source_id,scope_id,status) VALUES('lark.im','lark.im.sent_by_me','succeeded');
    UPDATE sync_scopes SET last_success_run_id=last_insert_rowid(),cursor_json='{"kind":"time_message_cursor/v1","created_at_ms":1893492000000}' WHERE id='lark.im.sent_by_me';
    UPDATE sync_scopes SET cursor_json='{"has_more":false}' WHERE id='lark.im.unmuted_chat_discovery';
    PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;`);
  assert.equal(buildStatus(db).health, 'ok');
  return { dir, db };
}

test('real check CLI identifies missing Python, exits error, and never calls Lark or writes cache/DB', t => {
  const { dir, db } = fixture(t), bin = join(dir, 'bin'), marker = join(dir, 'forbidden-remote');
  mkdirSync(bin);
  const sqlite = spawnSync('which', ['sqlite3'], { encoding: 'utf8' });
  assert.equal(sqlite.status, 0, sqlite.stderr); symlinkSync(sqlite.stdout.trim(), join(bin, 'sqlite3'));
  writeFileSync(join(bin, 'lark-cli'), '#!/bin/sh\nprintf forbidden > "$SYNTHETIC_NETWORK_MARKER"\nexit 97\n', { mode: 0o700 });
  const before = hash(db);
  for (const cache of [false, true]) for (const format of ['text', 'json']) {
    const result = spawnSync(process.execPath, [join(ROOT, 'bin/exocortex.mjs'), 'check', '--db', db, '--live',
      ...(cache ? ['--write-live-cache', '--log-dir', join(dir, 'logs')] : []), '--format', format], {
      cwd: dir, env: { PATH: bin, TMPDIR: dir, NO_COLOR: '1', SYNTHETIC_NETWORK_MARKER: marker }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stderr, '');
    if (format === 'json') {
      const report = JSON.parse(result.stdout);
      assert.equal(report.checks.database.status, 'passed'); assert.equal(report.checks.sync.status, 'passed');
      assert.equal(report.checks.quality.status, 'passed'); assert.equal(report.checks.live.status, 'unavailable');
      assert.deepEqual(report.checks.live.missing_dependencies, ['python3']);
      assert.ok(report.issues.some(issue => issue.code === 'live_dependency_unavailable'));
      assert.equal(report.cache.status, cache ? 'skipped' : 'not_requested');
    } else { assert.match(result.stdout, /Check: ERROR/); assert.match(result.stdout, /python3 unavailable/); }
    assert.equal(existsSync(marker), false); assert.equal(existsSync(join(dir, 'logs')), false);
    assert.equal(hash(db), before);
  }
});

for (const badDatabase of [true, false]) test(`actual CLI wait ${badDatabase ? 'rejects final foreign-key failure' : 'accepts healthy final DB'} after a new worker cycle`, async t => {
  const { dir, db } = fixture(t);
  if (badDatabase) {
    const result = spawnSync('sqlite3', [db, "PRAGMA foreign_keys=OFF; INSERT INTO sync_scopes(id,source_id,name,enabled) VALUES('synthetic.orphan','synthetic.absent','orphan',0);"], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const before = hash(db);
  for (const format of ['text', 'json']) {
    let output = '', remoteCalls = 0;
    const code = await runCli(['check', '--db', db, '--wait', ...(badDatabase ? ['--live'] : []), '--format', format], {
      root: ROOT, cwd: dir, startedAtMs: AT, now: () => AT + 200, stdout: { write: text => { output += text; } },
      stderr: { write: text => assert.fail(text) },
      loadCommand: async () => ({ runCheckCommand: (options, context) => runCheckCommand(options, context, {
        checkDependencies: () => ({ sqlite: true, python: true, live: true, wait: true }),
        collectStatusEvidence: () => ({ report: { sync: { status: buildStatus(db) } }, service: { status: 'running', target_match: 'matched' },
          workerSummary: { last_cycle: { ok: true, complete: true, started_at: new Date(AT).toISOString(), at: new Date(AT + 100).toISOString() },
            unfinished_cycle: false, in_progress: false } }),
        collectRemoteSample: () => { remoteCalls++; assert.fail('DB-not-ready must prevent remote sampling'); },
      }) }),
    });
    assert.equal(code, badDatabase ? 2 : 0); assert.equal(remoteCalls, 0);
    if (format === 'json') {
      const report = JSON.parse(output);
      assert.equal(report.checks.database.evidence.foreign_key_issues, badDatabase ? 1 : 0);
      assert.equal(report.checks.wait.status, badDatabase ? 'incomplete' : 'passed');
      assert.equal(report.checks.sync.status, 'passed'); assert.equal(report.checks.quality.status, 'passed');
      if (badDatabase) { assert.equal(report.checks.wait.evidence.reason, 'final_local_not_ready'); assert.equal(report.checks.live.status, 'skipped'); }
    } else assert.match(output, badDatabase ? /wait: INCOMPLETE[\s\S]*Final local checks are not ready/ : /wait: PASSED/);
    assert.equal(hash(db), before);
  }
});
