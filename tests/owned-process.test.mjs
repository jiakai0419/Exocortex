import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';

const source = readFileSync(new URL('./helpers/owned-process.mjs', import.meta.url), 'utf8');
const expectedImport = "import { spawn } from 'node:child_process';";
assert.equal(source.startsWith(expectedImport), true);
const body = source.replace(expectedImport, '').replace(/^export (?=(?:async )?function)/gm, '');
assert.doesNotMatch(body, /^\s*import\s/m, 'new dependencies must be mocked explicitly');
const script = new Script(`${body}\n({ startOwnedProcess });`, { filename: 'owned-process.synthetic-vm.js' });

// The helper's actual body executes with fake spawn, signal, clock and timers.
// No helper import, actual child, timer, lock or signal operation is performed.
function fixture({ denied = false, maxBytes, stdio } = {}) {
  let now = 0, nextTimer = 1, spawns = 0;
  let spawnOptions;
  const timers = new Map(), signals = [], groupSignals = [];
  const child = new EventEmitter();
  child.pid = 321;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => {};
  for (const name of ['stdout', 'stderr']) {
    child[name] = new EventEmitter();
    child[name].destroy = () => {};
  }
  child.kill = signal => {
    signals.push(signal);
    if (denied) throw Object.assign(new Error('synthetic refusal'), { code: 'EPERM' });
    return true;
  };
  const api = script.runInNewContext({ Buffer,
    spawn: (_command, _args, options) => { spawns++; spawnOptions = options; return child; },
    performance: { now: () => now },
    process: { kill: (pid, signal) => { groupSignals.push({ pid, signal }); } },
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout: id => { timers.delete(id); },
  }, { timeout: 1000 });
  const owner = api.startOwnedProcess('synthetic-node', [], { deadline: 10000, maxBytes, stdio, env: {} });
  assert.equal(spawns, 1);
  const advance = target => {
    let iterations = 0;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++iterations <= 20, 'unexpected fake timer loop');
      const [id, timer] = next;
      timers.delete(id); now = timer.at; timer.callback();
    }
    now = target;
  };
  return { owner, child, signals, groupSignals, timers, advance, spawnOptions };
}

test('owned TERM consumes the only signal slot and hard deadline settles without a KILL retry', async () => {
  const f = fixture();
  assert.equal(f.owner.signalOnce('SIGTERM'), true);
  f.advance(8000);
  assert.deepEqual(f.signals, ['SIGTERM']);
  f.advance(10000);
  const result = await f.owner.result;
  assert.equal(result.failure, 'owned_case_watchdog');
  assert.equal(result.code, null);
  assert.equal(result.signalAttempted, true);
  assert.deepEqual(f.signals, ['SIGTERM']);
  assert.deepEqual(f.groupSignals, []);
  assert.equal(f.timers.size, 0);
});

test('owned EPERM refusal cannot retry or fall back to a process group', async () => {
  const f = fixture({ denied: true });
  assert.equal(f.owner.signalOnce('SIGTERM'), false);
  assert.equal(f.owner.signalOnce('SIGKILL', { group: true }), false);
  f.owner.stop('later_watchdog');
  f.advance(20000);
  const result = await f.owner.result;
  assert.equal(result.failure, 'owned_signal_failed');
  assert.equal(result.signalError, 'EPERM');
  assert.deepEqual(f.signals, ['SIGTERM']);
  assert.deepEqual(f.groupSignals, []);
  assert.equal(f.timers.size, 0);
});

test('owned output overflow remains failed after a late zero close', async () => {
  const f = fixture({ maxBytes: 8 });
  f.child.stdout.emit('data', Buffer.from('0123456789'));
  f.child.emit('close', 0, null);
  const result = await f.owner.result;
  assert.equal(result.failure, 'owned_output_limit');
  assert.equal(result.code, 0);
  assert.ok(result.stdout.length + result.stderr.length <= 8);
  f.advance(20000);
  assert.deepEqual(f.signals, ['SIGKILL']);
  assert.deepEqual(f.groupSignals, []);
  assert.equal(f.timers.size, 0);
});

test('owned normal close cancels every watchdog without any signal', async () => {
  const f = fixture();
  f.child.stdout.emit('data', Buffer.from('synthetic'));
  f.child.emit('exit', 0, null);
  f.child.emit('close', 0, null);
  const result = await f.owner.result;
  assert.equal(result.failure, null);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString(), 'synthetic');
  assert.equal(result.signalAttempted, false);
  assert.equal(f.timers.size, 0);
  f.advance(20000);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.groupSignals, []);
});

test('owned spawn preserves the explicit inherited descriptor mapping without opening a real fd', async () => {
  const stdio = ['ignore', 'pipe', 'pipe', 87];
  const f = fixture({ stdio });
  assert.equal(f.spawnOptions.stdio, stdio);
  assert.equal(f.spawnOptions.stdio[3], 87);
  f.child.emit('close', 0, null);
  assert.equal((await f.owner.result).failure, null);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.groupSignals, []);
});
