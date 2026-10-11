import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCycle, writeLog } from '../src/runtime/worker/worker.mjs';
import { WORKER_DEFAULTS } from '../src/runtime/worker/options.mjs';
import { createActivityWriter } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { runCli } from '../bin/exocortex.mjs';
import { runStatusCommand } from '../src/cli/status-command.mjs';
import { rawStatusScreenFixture } from './helpers/status-screen-fixture.mjs';

const BASE = Date.parse('2034-03-02T12:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'exocortex-history-status-synthetic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'identity.sqlite'), logDir = join(dir, 'worker'); mkdirSync(logDir);
  writeFileSync(db, 'Synthetic identity file only; DB snapshots below are injected.\n');
  let tick = BASE;
  const inspect = pids => new Map(pids.filter(pid => pid === 7701).map(pid => [pid, { state: 'alive', started_at_ms: BASE - 3600000, ppid: 1 }]));
  const opts = { ...WORKER_DEFAULTS, db, logDir }, stdout = { write() {} };
  const activity = createActivityWriter({ db, role: 'worker', pid: 7701, instanceId: 'synthetic-history-producer', now: () => tick,
    inspect, emit: event => writeLog(opts, event, { stdout }) });
  let sequence = 0;
  async function status(snapshot, at = tick, format = 'json') {
    const logs = join(dir, `read-${sequence++}`); mkdirSync(logs); writeFileSync(join(logs, 'worker.jsonl'), snapshot);
    let output = '';
    const out = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }); out.columns = 160;
    const code = await runCli(['status', '--db', db, '--log-dir', logs, '--detail', '--format', format], {
      root: dir, cwd: dir, env: {}, now: () => at, stdout: out, stderr: { write: text => assert.fail(text) },
      loadCommand: async () => ({ runStatusCommand: (options, context) => runStatusCommand(options, context, {
        serviceDeps: { uid: () => 12345 }, readInstalledServiceConfig: () => ({ status: 'installed' }), reportDeps: {
          clock: () => at, runCommand: () => ({ status: 0, stdout: 'state = running\npid = 7701\n', stderr: '' }),
          buildStatus: () => rawStatusScreenFixture('healthy').sync.status, readLiveProbeCache: () => null,
          liveProbeContext: () => null, sqliteJson: () => [], inspectActivityProcesses: inspect,
        },
      }) }),
    });
    assert.equal(code, 0);
    return format === 'json' ? JSON.parse(output) : output;
  }
  return { opts, activity, stdout, status, log: () => readFileSync(join(logDir, 'worker.jsonl'), 'utf8'),
    now: () => tick, advance: () => { tick += 1000; } };
}

test('real worker history step → activity/log → CLI status names current, latest and failed tasks', async t => {
  const f = fixture(t); let active, activeAt, justCompleted; const commands = [];
  const ok = runCycle(f.opts, 1, { activity: f.activity, nowMs: f.now, writeLog: { stdout: f.stdout }, runStep: {
    runProcess: (_cmd, args) => {
      commands.push(args.slice(1)); const history = args[1] === 'maintenance' && args[2] === 'history';
      if (history) { active = f.log(); activeAt = f.now(); }
      f.advance();
      return { status: history ? 2 : 0, stdout: JSON.stringify(history ? { ok: false, profile: 'known_record_history/v1', outcome: 'fetch_unavailable',
        cursor_policy: 'unchanged', request_budget: { cli_attempts: 1, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1000, stop_reason: 'request_timeout' } } : { ok: true }), stderr: '' };
    },
  } });
  assert.equal(ok, false); assert.ok(commands.some(args => args[0] === 'maintenance' && args[1] === 'history'));
  justCompleted = f.log();
  const activeJson = await f.status(active, activeAt), activeText = await f.status(active, activeAt, 'text');
  assert.equal(activeJson.activity.step, 'history'); assert.equal(activeJson.activity.state, 'syncing');
  assert.match(activeText, /Current work\s+Syncing · stored message history review/);
  const events = justCompleted.trim().split('\n').map(JSON.parse);
  const stepIndex = events.findIndex(event => event.type === 'lark_im_worker_step' && event.name === 'history');
  const stepLog = events.slice(0, stepIndex + 1).map(event => JSON.stringify(event)).join('\n') + '\n';
  const latest = await f.status(stepLog, f.now(), 'text');
  assert.match(latest, /Latest task\s+Stored message history review · Failed/);
  f.activity.update('waiting', { cycle: 1, durationMs: 30000 });
  const doneJson = await f.status(f.log()), doneText = await f.status(f.log(), f.now(), 'text');
  assert.equal(doneJson.runtime_stats.state, 'available'); assert.equal(doneJson.runtime_stats.total_runs, 1);
  assert.equal(doneJson.runtime_stats.successful_runs, 0);
  assert.deepEqual(doneJson.stability.failures.by_step, [{ name: 'history', count: 1 }]);
  assert.match(doneText, /Failed task\s+Stored message history review · 1/);
  assert.doesNotMatch(activeText + latest + doneText, /Unclassified task|unclassified task/);
});

test('invalid calendar completion stays unplaced across runtime, worker history and stability; unknown tasks stay safe', async t => {
  const f = fixture(t);
  f.activity.update('step', { cycle: 2, step: 'history', durationMs: 30000 });
  const activity = JSON.parse(f.log().trim().split('\n').at(-1));
  const identity = { version: 1, instance_id: activity.instance_id, database_key: activity.database_key };
  const completion = { ...identity, type: 'lark_im_worker_cycle', cycle: 1, ok: true, at: '2034-02-30T11:59:59Z',
    cycle_policy: 'bounded_history/v1', step_count: 7, failed_steps: [] };
  const snapshot = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
  const bad = await f.status(snapshot([completion, activity]));
  assert.equal(bad.runtime_stats.state, 'unavailable'); assert.equal(bad.runtime_stats.reason, 'completion_invalid');
  assert.equal(bad.worker.last_cycle.timestamp_valid, false); assert.equal(bad.worker.last_cycle.at, null);
  assert.equal(bad.stability.cycles.ok, 0); assert.equal(bad.stability.last_success, null);
  const text = await f.status(snapshot([completion, activity]), f.now(), 'text');
  assert.doesNotMatch(text, /Latest success\s+Succeeded/);
  const good = await f.status(snapshot([{ ...completion, at: new Date(BASE - 1000).toISOString() }, activity]));
  assert.equal(good.runtime_stats.state, 'available'); assert.equal(good.stability.cycles.ok, 1);
  const unknown = { ...identity, type: 'lark_im_worker_step', name: 'SYNTHETIC_PRIVATE_TASK', cycle: 1, ok: false,
    started_at: new Date(BASE - 2000).toISOString(), finished_at: new Date(BASE - 1000).toISOString() };
  const unknownJson = await f.status(snapshot([unknown, activity]));
  const unknownText = await f.status(snapshot([unknown, activity]), f.now(), 'text');
  assert.equal(unknownJson.worker.last_step.name, 'unknown'); assert.match(unknownText, /Unclassified task/);
  assert.doesNotMatch(JSON.stringify(unknownJson) + unknownText, /SYNTHETIC_PRIVATE_TASK/);
});
