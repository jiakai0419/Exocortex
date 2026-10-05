import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRemoteSamplePublication, remoteSamplePublicationStage, REMOTE_SAMPLE_CACHE_GATE } from '../src/runtime/worker/remote-sample-cache-gate.mjs';

const token = '11111111-1111-4111-8111-111111111111';
const contract = createRemoteSamplePublication('/invented/private', 'a'.repeat(64), token);

// Only the mock interpreter starts: it substitutes every helper filesystem
// operation and rejects all unmocked imports. No guardian or OS lock is run.
function mock(scenario = {}, action) {
  const output = spawnSync('python3', [fileURLToPath(new URL('./remote_sample_cache_gate_mock.py', import.meta.url))], {
    input: JSON.stringify({ code: REMOTE_SAMPLE_CACHE_GATE, contract, scenario, action: action || 'publish_remote_sample_cache' }), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.error, undefined);
  return JSON.parse(output.stdout);
}

test('stage contract accepts only the parent UUID and same private directory', () => {
  assert.equal(remoteSamplePublicationStage('/invented/private', 'a'.repeat(64), contract), contract.stagePath);
  for (const value of [null, {}, { ...contract, stagePath: contract.cachePath }, { ...contract, extra: true },
    { ...contract, lockPath: '/invented/other.lock' }, { ...contract, attemptId: '../../escape' }]) {
    assert.equal(remoteSamplePublicationStage('/invented/private', 'a'.repeat(64), value), null);
  }
});

test('mock publication commits only after file and directory fsync, retaining guardian lock', () => {
  const output = mock();
  assert.equal(output.error, null);
  assert.equal(output.positive, true);
  assert.equal(output.stage, false);
  assert.equal(output.inherited_lock_open, true);
  assert.ok(output.calls.indexOf('fsync_stage') < output.calls.indexOf('fsync_directory'));
  assert.ok(output.calls.indexOf('fsync_directory') < output.calls.indexOf('rename'));
  assert.equal(output.calls.at(-1), 'rename');
});

for (const fail of ['open_directory', 'open_stage', 'fsync_stage', 'fsync_directory', 'rename']) {
  test(`mock ${fail} failure preserves the visible attempting cache`, () => {
    const output = mock({ fail });
    assert.equal(output.error, 'PermissionError');
    assert.equal(output.positive, false);
    assert.equal(output.stage, true);
    assert.equal(output.calls.filter(call => call === fail).length, 1);
  });
}
for (const unsafe of ['link', 'fifo', 'hardlink', 'public', 'owner', 'oversized', 'directory']) {
  test(`mock ${unsafe} stage or directory is rejected before publication`, () => {
    const output = mock({ unsafe });
    assert.equal(output.error, 'ValueError');
    assert.equal(output.positive, false);
    assert.equal(output.calls.includes('rename'), false);
  });
}
for (const changed of ['lock', 'stage', 'target', 'directory']) {
  test(`mock replaced ${changed} identity fails closed`, () => {
    const output = mock({ changed });
    assert.equal(output.error, 'ValueError');
    assert.equal(output.positive, false);
  });
}
test('mock publication makes no close call after its final commit', () => {
  const output = mock({ fail: 'close_directory' });
  assert.equal(output.error, null);
  assert.equal(output.positive, true);
  assert.equal(output.calls.at(-1), 'rename');
  assert.equal(output.calls.some(call => call.startsWith('close_')), false);
});
test('mock missing expected stage fails and read-only mode has no cache side effects', () => {
  const output = mock({ missing: true });
  assert.equal(output.error, 'FileNotFoundError');
  assert.equal(output.positive, false);
  assert.equal(output.calls.includes('rename'), false);
  assert.equal(mock({ no_contract: true }).error, null);
  assert.deepEqual(mock({ no_contract: true }).calls, []);
});
test('mock final cancellation after fsync prevents positive publication', () => {
  const output = mock({ cancel: true });
  assert.equal(output.error, 'ValueError');
  assert.equal(output.positive, false);
  assert.ok(output.calls.indexOf('allow_commit') > output.calls.indexOf('fsync_directory'));
  assert.equal(output.calls.includes('rename'), false);
});
test('mock preparation replaces old success with a durable unavailable marker before child startup', () => {
  const output = mock({ old_positive: true }, 'prepare_remote_sample_cache');
  assert.equal(output.error, null);
  assert.equal(output.positive, false);
  assert.equal(output.inherited_lock_open, true);
  assert.ok(output.calls.indexOf('fsync_marker') < output.calls.indexOf('rename'));
  assert.ok(output.calls.indexOf('rename') < output.calls.indexOf('fsync_directory'));
});
test('mock directory fsync failure after preparing the marker still cannot expose old success', () => {
  const output = mock({ old_positive: true, fail: 'fsync_directory' }, 'prepare_remote_sample_cache');
  assert.equal(output.error, 'PermissionError');
  assert.equal(output.positive, false);
});
for (const fail of ['close_marker', 'close_directory']) {
  test(`mock ${fail} failure rejects cache preparation without retrying close`, () => {
    const output = mock({ old_positive: true, fail }, 'prepare_remote_sample_cache');
    assert.equal(output.error, 'PermissionError');
    assert.equal(output.positive, false);
    assert.equal(output.calls.filter(call => call === fail).length, 1);
  });
}
test('mock discard removes only the unique stage and keeps attempting cache', () => {
  const output = mock({}, 'discard_remote_sample_stage');
  assert.equal(output.error, null);
  assert.equal(output.positive, false);
  assert.equal(output.stage, false);
  assert.equal(output.calls.filter(call => call === 'unlink').length, 1);
});
test('mock publication rejects malformed inherited descriptors', () => {
  for (const lock_fd of ['', '1', '-200', '200.0', ' 200', '∞']) {
    const output = mock({ lock_fd });
    assert.equal(output.error, 'ValueError');
    assert.equal(output.positive, false);
    assert.deepEqual(output.calls, []);
  }
});
