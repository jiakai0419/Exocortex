import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentResourceGuardian, parseResourcePhaseBytes, assertResourceTailPrerequisites, archiveResourceGuardianEvidence } from './helpers/resource-guardian-phases.mjs';
import { WORKER_STEP_GUARDIAN, runGuardedWorkerStep } from '../src/runtime/worker/step-process.mjs';
import { runStep } from '../src/runtime/worker/worker.mjs';

const encode = events => Buffer.from(events.map(e => JSON.stringify(e) + '\n').join(''));
const event = (phase, index, extra = {}) => ({ version: 1, role: 'guardian', phase,
  monotonic_us: index * 1000, cpu_us: index * 100, ...extra });
const prefix = [event('imports_done', 1), event('deadline_created', 2, { deadline: 12.3, grant_ms: 299 }),
  event('anchor_spawn_begin', 3), event('anchor_spawn_returned', 4)];

test('synthetic observations are reversibly inserted into exact original guardian and anchor', () => {
  const r = instrumentResourceGuardian(WORKER_STEP_GUARDIAN, '/tmp/authored-observation-not-opened');
  assert(r.binding.guardian.reversible && r.binding.anchor.reversible);
  assert.equal(r.binding.guardian.original_sha256, '59c5a5ec78f3d8e49be0c7e8c3e30d780480e73d134eba07deda549f5e377517');
  assert.equal(r.binding.anchor.original_sha256, 'c1c4106933ceb7daab898f0e3211c57c5352dca00220c4ee11f475b6af7681ca');
  assert.equal(r.binding.intervention, 'none');
});

test('source changes and ambiguous injection points fail before any OS invocation', () => {
  assert.throws(() => instrumentResourceGuardian(WORKER_STEP_GUARDIAN.replace('    deadline=time.monotonic()+timeout\n', ''), '/tmp/authored-unused'));
  assert.throws(() => instrumentResourceGuardian(WORKER_STEP_GUARDIAN + '\n    deadline=time.monotonic()+timeout\n', '/tmp/authored-unused'));
});

test('a valid partial ledger reports only observed stages and has no invented completion verdict', () => {
  const r = parseResourcePhaseBytes(encode(prefix), 'guardian');
  assert.equal(r.state, 'valid');
  assert.equal(r.events.length, 4);
  assert(!r.events.some(e => e.phase === 'go_written'));
  assert(!('complete' in r));
});

test('deadline position is observed without imposing a fictitious linear position', () => {
  for (const trace of [
    [...prefix, event('deadline_observed', 5, { current_stage: 'capture_read', ready: false, go_sent: false }), event('cleanup_entered', 6, { child_present: true, ready: false, go_sent: false })],
    [...prefix, event('cleanup_entered', 5, { child_present: true, ready: false, go_sent: false }),
      event('cleanup_finished', 6, { killed: false, reaped: false, cleanup_error: true }),
      event('deadline_observed', 7, { current_stage: 'capture_read', ready: false, go_sent: false })],
  ]) assert.equal(parseResourcePhaseBytes(encode(trace), 'guardian').state, 'valid');
});

for (const [name, bytes] of [
  ['truncated', encode(prefix).subarray(0, -1)],
  ['duplicate', encode([...prefix, prefix[3]])],
  ['missing prerequisite', encode(prefix.slice(1))],
  ['backwards clock', encode([...prefix, event('ready_received', 2)])],
  ['wrong role', encode([{ ...prefix[0], role: 'anchor' }])],
  ['unknown fields', encode([{ ...prefix[0], token: 'authored-not-real' }])],
  ['unknown stage', encode([event('imaginary_success', 1)])],
  ['out of order', encode([...prefix, event('go_written', 5)])],
  ['cleanup facts absent', encode([...prefix, event('cleanup_entered', 5), event('cleanup_finished', 6)])],
  ['cleanup error absent', encode([...prefix, event('cleanup_entered', 5, { child_present: true, ready: false, go_sent: false }),
    event('cleanup_finished', 6, { killed: false, reaped: false })])],
  ['kill completion invented', encode([...prefix, event('cleanup_entered', 5, { child_present: true, ready: false, go_sent: false }),
    event('cleanup_finished', 6, { killed: true, reaped: false, cleanup_error: false })])],
  ['too many bytes', Buffer.alloc(16 * 1024 + 1, 32)],
]) test(`phase ledger rejects ${name} without retaining misleading events`, () => {
  assert.deepEqual(parseResourcePhaseBytes(bytes, 'guardian').events, []);
  assert.equal(parseResourcePhaseBytes(bytes, 'guardian').state, 'invalid');
});

test('missing and empty records cannot imply entry or cleanup', () => {
  assert.deepEqual(parseResourcePhaseBytes(Buffer.alloc(0), 'guardian'), { state: 'missing', events: [] });
});

test('shell observations have no fabricated clock and preserve the actual command return code', () => {
  const events = [{ version: 1, role: 'worker', phase: 'entry' },
    { version: 1, role: 'worker', phase: 'output_returned', return_code: 1 }];
  const r = parseResourcePhaseBytes(encode(events), 'worker');
  assert.equal(r.state, 'valid');
  assert.equal(r.events[1].return_code, 1);
  assert(!('monotonic_us' in r.events[0]));
  assert.equal(parseResourcePhaseBytes(encode([{ ...events[0], monotonic_us: 0 }]), 'worker').state, 'invalid');
  assert.equal(parseResourcePhaseBytes(encode(events.slice(1)), 'worker').state, 'invalid');
});

test('the actual tail prerequisite assertion cannot accept a missing marker or forged JSON', () => {
  const stdout = JSON.stringify({ ok: true, profile: 'known_record_resources/v1' });
  assert.doesNotThrow(() => assertResourceTailPrerequisites(true, stdout));
  assert.throws(() => assertResourceTailPrerequisites(false, stdout), /synthetic child entered/);
  for (const bad of ['', '{broken', '{"ok":true}', '{"ok":true,"profile":"known_record_resources/v1","extra":true}'])
    assert.throws(() => assertResourceTailPrerequisites(true, bad));
});

test('success-looking JSON with a cleanup error remains unsuccessful through the actual wrapper and step', () => {
  const envelope = { version: 1, code: 0,
    stdout: Buffer.from('{"ok":true,"profile":"known_record_resources/v1"}').toString('base64'), stderr: '',
    diagnostic: { version: 1, primary: null, cleanup: { stage: 'child_reap', errno: 5 } } };
  let calls = 0;
  const step = runStep('resources', [], { timeoutMs: 300, remainingTimeMs: () => 2300,
    runProcess: (command, args, options) => runGuardedWorkerStep(command, args, options, {
      spawnSync: () => { calls++; return { status: 0, signal: null, stdout: JSON.stringify(envelope), stderr: '' }; },
    }) });
  assert.equal(calls, 1);
  assert.equal(step.ok, false);
  assert.equal(step.exit_code, undefined);
  assert.deepEqual(step.guardian_diagnostic.cleanup, envelope.diagnostic.cleanup);
});

test('artifact failure after the wrapper returns preserves its actual deadline result', () => {
  const envelope = { version: 1, code: null, stdout: '', stderr: '',
    diagnostic: { version: 1, primary: { stage: 'deadline', errno: null }, cleanup: null } };
  const result = runGuardedWorkerStep('/bin/sh', ['authored-unused'], { timeout: 299 }, {
    spawnSync: () => ({ status: 0, signal: null, stdout: JSON.stringify(envelope), stderr: '' }),
  });
  const before = JSON.stringify(result);
  let writes = 0;
  const archive = archiveResourceGuardianEvidence({ 'guardian-stdout.txt': 'authored' }, () => { writes++; throw Error('authored disk error'); });
  assert.equal(writes, 1);
  assert.deepEqual(archive, { state: 'write_failed' });
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.guardian_diagnostic.primary.stage, 'deadline');
  assert.equal(result.status, null);
});
