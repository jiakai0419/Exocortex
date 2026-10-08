import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActivityWriter, inspectActivityProcesses } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { runGuardedWorkerStep } from '../src/runtime/worker/step-process.mjs';

const ACTIVITY_URL = new URL('../src/diagnostics/lark-im-activity-evidence.mjs', import.meta.url).href;
const STATUS_URL = new URL('../src/diagnostics/status-report.mjs', import.meta.url).href;

// Process identities, PPIDs and JSONL reads are real. Phase timestamps and
// observation clocks are synthetic: runner load cannot make a first-second
// launch race decide the result. No service, database query or API is invoked.
for (const guarded of [false, true]) test(`real ${guarded ? 'guardian ancestry' : 'direct child'} with unchanged initial phase`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'exo-synthetic-activity-process-'));
  try {
    const db = join(directory, 'invented.identity');
    writeFileSync(db, 'invented file identity; not a SQLite database', { mode: 0o600 });
    const observed = inspectActivityProcesses([process.pid]).get(process.pid);
    assert.equal(observed?.state, 'alive', 'the test requires read-only ps access to its own process');
    // Keep the worker phase valid at both later child observations.
    const remaining = observed.started_at_ms + 1100 - Date.now();
    if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining);
    let workerEvent;
    createActivityWriter({ db, role: 'worker', instanceId: 'synthetic-worker',
      now: () => observed.started_at_ms + 1000, emit: event => { workerEvent = event; },
    }).update('step', { cycle: 1, step: 'sent', durationMs: 60000 });
    const childPath = join(directory, 'invented-child.mjs');
    writeFileSync(childPath, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createActivityWriter, inspectActivityProcesses } from ${JSON.stringify(ACTIVITY_URL)};
import { collectStatusEvidence } from ${JSON.stringify(STATUS_URL)};
const directory = ${JSON.stringify(directory)}, db = ${JSON.stringify(db)};
const worker = ${JSON.stringify(workerEvent)};
const own = inspectActivityProcesses([process.pid]).get(process.pid);
assert.equal(own?.state, 'alive');
let child;
createActivityWriter({ db, role: 'sync', instanceId: 'synthetic-child', parentInstance: worker.instance_id,
  now: () => own.started_at_ms + 100, emit: event => { child = event; },
}).update('sync', { step: 'sent', durationMs: 20000 });
const originalPhase = JSON.stringify(child);
const filename = directory + '/worker.jsonl';
const write = event => writeFileSync(filename, [worker, event].map(JSON.stringify).join('\\n') + '\\n', { mode: 0o600 });
write(child);
function inspectAt(now) {
  const queries = [];
  const evidence = collectStatusEvidence({ db, logDir: directory }, { root: directory, cwd: directory, env: {}, now: () => now }, {
    readInstalledServiceConfig: () => ({ status: 'installed' }), reportDeps: {
      runCommand: () => ({ status: 0, stdout: 'state = running\\npid = ' + worker.pid + '\\n', stderr: '' }),
      buildStatus: () => ({ health: 'unknown', locks: [], current_activity: { evidence: 'database_only', reason: 'unverified_sync_history' },
        details: { evidence: 'available', pending_count: 0 }, list_progress: { evidence: 'available', invalid_cursor_scopes: 0 },
        scopes: { message_enabled: 1, message_without_success: 0 }, runs: { by_status: { running: 1, succeeded: 1 } }, discovery: { cursor: { has_more: false } } }),
      readLiveProbeCache: () => null, liveProbeContext: () => null, sqliteJson: () => [],
      inspectActivityProcesses: pids => { queries.push(pids); return inspectActivityProcesses(pids); },
    },
  });
  assert.ok(queries.length <= 4);
  assert.ok(queries.every(pids => pids.length <= 32));
  assert.ok(new Set(queries.flat()).size <= 32);
  assert.equal(evidence.binding.target_match, 'matched');
  assert.equal(evidence.workerSummary.in_progress, true);
  return { state: evidence.report.overview.activity.state, reason: evidence.report.overview.activity.reason,
    health: evidence.report.overview.health.status, queries: queries.length,
    nodes: evidence.report.activity_evidence.ancestry.get(process.pid)?.pids.length };
}
const first = inspectAt(own.started_at_ms + 500);
assert.equal(first.state, 'unknown');
const recovered = inspectAt(own.started_at_ms + 1500);
assert.equal(recovered.state, 'syncing'); assert.equal(recovered.reason, 'worker_phase_observed'); assert.equal(recovered.health, 'ok');
assert.equal(JSON.stringify(child), originalPhase, 'recovery needs no heartbeat or rewritten phase');
assert.equal(recovered.nodes, ${guarded ? 4 : 2});
assert.equal(recovered.queries, ${guarded ? 4 : 1});
write({ ...child, parent_instance: null });
const undeclared = inspectAt(own.started_at_ms + 1500); assert.equal(undeclared.state, 'unknown');
write({ ...child, parent_instance: 'foreign-worker' });
const foreign = inspectAt(own.started_at_ms + 1500); assert.equal(foreign.state, 'unknown');
process.stdout.write(JSON.stringify({ first, recovered, undeclared, foreign }));
`, { mode: 0o600 });
    const options = { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
        TMPDIR: directory, LARK_CLI: join(directory, 'real-api-disabled') } };
    const result = (guarded ? runGuardedWorkerStep : spawnSync)(process.execPath, [childPath], options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    assert.equal(result.guardian_diagnostic, undefined);
    const value = JSON.parse(result.stdout);
    assert.equal(value.recovered.state, 'syncing');
    assert.equal(value.undeclared.state, 'unknown');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
