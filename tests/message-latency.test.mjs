import test from 'node:test';
import assert from 'node:assert/strict';
import { measureMessageLatency, classifyLatency, measureMonotonicBudget } from '../src/diagnostics/message-latency.mjs';

// Entirely authored timestamps and opaque bindings, without database/API reads.
const SOURCE = { recordKey: 'synthetic-record', sourceVersion: 'synthetic-version-1' };
const CURRENT = { ...SOURCE, identityGeneration: 1, contractVersion: 'synthetic-completeness-v1' };
const read = value => measureMessageLatency(JSON.stringify(value));
const metric = (minimumMs, maximumMs = minimumMs, reason = 'verified_wall') =>
  ({ status: 'measured', reason, minimumMs, maximumMs });
function fixture() {
  return {
    current: { ...CURRENT },
    source: { binding: { ...SOURCE }, atMs: 0, precisionMs: 1, clockEpoch: 'synthetic-clock-a' },
    collected: { binding: { ...SOURCE }, atMs: 70_000, clockEpoch: 'synthetic-clock-a' },
    identityReady: { binding: { ...CURRENT }, atMs: 80_000, complete: true, clockEpoch: 'synthetic-clock-a' },
    published: { binding: { ...CURRENT }, atMs: 83_000, complete: true, clockEpoch: 'synthetic-clock-a' },
  };
}

test('complete matching evidence measures each stage independently', () => {
  const result = read(fixture());
  assert.deepEqual(result.sourceToCollection, metric(70_000));
  assert.deepEqual(result.collectionToIdentity, metric(10_000));
  assert.deepEqual(result.identityToPublication, metric(3_000));
  assert.deepEqual(result.sourceToPublication, metric(83_000));
  assert.equal(result.delayCause, 'unclassified');
});

test('minute-rounded source time produces bounds and honest threshold categories', () => {
  const input = fixture(); input.source.precisionMs = 60_000;
  const result = read(input);
  assert.deepEqual(result.sourceToCollection, metric(10_001, 70_000, 'source_precision_interval'));
  assert.deepEqual(result.sourceToPublication, metric(23_001, 83_000, 'source_precision_interval'));
  assert.equal(classifyLatency(result.sourceToPublication, 83_000), 'within');
  assert.equal(classifyLatency(result.sourceToPublication, 23_000), 'exceeded');
  assert.equal(classifyLatency(result.sourceToPublication, 60_000), 'straddles');
});

test('precision overlap retains negative lower bound without claiming a pass', () => {
  const input = fixture(); input.source.precisionMs = 60_000; input.collected.atMs = 10_000;
  const result = read(input);
  assert.deepEqual(result.sourceToCollection,
    { status: 'uncertain', reason: 'source_precision_overlap', minimumMs: -49_999, maximumMs: 10_000 });
  assert.equal(classifyLatency(result.sourceToCollection, 90_000), 'unknown');
});

test('missing evidence cannot be reconstructed from other stages or update times', () => {
  for (const field of ['source', 'collected', 'identityReady', 'published']) {
    const input = fixture(); delete input[field];
    const result = read(input);
    assert.equal(result.sourceToPublication.status, 'unknown', field);
    assert.equal(classifyLatency(result.sourceToPublication, 120_000), 'unknown');
  }
  const input = fixture(); input.updated_at = 83_000;
  assert.equal(read(input).evidence, 'invalid');
  assert.equal(read({ current: CURRENT }).sourceToCollection.reason, 'missing_evidence');
});

test('incomplete readiness and unpublished snapshots cannot pass', () => {
  for (const field of ['identityReady', 'published']) {
    const input = fixture(); input[field].complete = false;
    const result = read(input);
    assert.equal(result.sourceToPublication.status, 'unknown');
    assert.equal(classifyLatency(result.sourceToPublication, 120_000), 'unknown');
  }
});

test('source version changes invalidate old readiness even when new collection is known', () => {
  const input = fixture(); input.current.sourceVersion = 'synthetic-version-2';
  input.source.binding.sourceVersion = input.current.sourceVersion;
  input.collected.binding.sourceVersion = input.current.sourceVersion;
  const result = read(input);
  assert.equal(result.sourceToCollection.status, 'measured');
  assert.equal(result.collectionToIdentity.reason, 'stale_evidence');
  assert.equal(result.sourceToPublication.status, 'unknown');
});

test('readiness generations and contracts cannot leak into another record', () => {
  for (const [key, changed] of [['recordKey', 'another-synthetic-record'], ['identityGeneration', 2], ['contractVersion', 'synthetic-v2']]) {
    const input = fixture(); input.identityReady.binding[key] = changed;
    assert.equal(read(input).collectionToIdentity.reason, 'stale_evidence', key);
    assert.equal(read(input).sourceToPublication.status, 'unknown', key);
  }
  const input = fixture(); input.current.identityGeneration = 2;
  assert.equal(read(input).sourceToCollection.status, 'measured');
});

test('same-process monotonic samples measure processing with explicit tolerated clock skew', () => {
  const input = fixture();
  Object.assign(input.collected, { processKey: 'synthetic-process', monotonicMs: 500.25 });
  Object.assign(input.identityReady, { processKey: 'synthetic-process', monotonicMs: 10_501.75 });
  Object.assign(input.published, { processKey: 'synthetic-process', monotonicMs: 13_503 });
  const result = read(input);
  assert.deepEqual(result.collectionToIdentity, metric(10_001.5, 10_001.5, 'monotonic'));
  assert.deepEqual(result.identityToPublication, metric(3_001.25, 3_001.25, 'monotonic'));
  assert.deepEqual(result.sourceToPublication, metric(83_002.75, 83_002.75, 'composed_monotonic'));
  assert.equal(classifyLatency(result.sourceToPublication, 83_000), 'exceeded');
});

function authoredClockChain(walls, clocks, processes = ['synthetic-process', 'synthetic-process', 'synthetic-process']) {
  const input = fixture();
  for (const [index, field] of ['collected', 'identityReady', 'published'].entries())
    Object.assign(input[field], { atMs: walls[index], monotonicMs: clocks[index], processKey: processes[index] });
  return input;
}

test('two tolerated stage discrepancies cannot hide accumulated clock drift', () => {
  const input = authoredClockChain([0, 1000, 2000], [0, 2000, 4000]);
  const result = read(input);
  assert.deepEqual(result.collectionToIdentity, metric(2000, 2000, 'monotonic'));
  assert.deepEqual(result.identityToPublication, metric(2000, 2000, 'monotonic'));
  assert.equal(result.sourceToPublication.status, 'clock_anomaly');
  assert.equal(classifyLatency(result.sourceToPublication, 2000), 'unknown');
});

test('tolerated whole-chain skew preserves the larger measured monotonic duration', () => {
  const input = authoredClockChain([0, 1000, 2000], [0, 1500, 2500]);
  const result = read(input);
  assert.deepEqual(result.sourceToPublication, metric(2500, 2500, 'composed_monotonic'));
  assert.equal(classifyLatency(result.sourceToPublication, 2000), 'exceeded');
  assert.equal(classifyLatency(result.sourceToPublication, 2500), 'within');
});

test('mixed-process local chains also preserve a measured monotonic leg', () => {
  const input = authoredClockChain([0, 1000, 2000], [0, 1500, 100],
    ['synthetic-process-a', 'synthetic-process-a', 'synthetic-process-b']);
  assert.deepEqual(read(input).sourceToPublication, metric(2500, 2500, 'composed_monotonic'));
  assert.equal(classifyLatency(read(input).sourceToPublication, 2000), 'exceeded');
});

test('whole-process evidence rejects contradictory mixed-process stage lengths', () => {
  const input = authoredClockChain([0, 1000, 2000], [0, 100, 2500],
    ['synthetic-process-a', 'synthetic-process-b', 'synthetic-process-a']);
  assert.equal(read(input).sourceToPublication.reason, 'chain_interval_disagreement');
  assert.equal(classifyLatency(read(input).sourceToPublication, 3000), 'unknown');
});

test('source precision and collected-to-published monotonic bounds compose together', () => {
  const input = authoredClockChain([70_000, 71_000, 72_000], [0, 1500, 2500]);
  input.source.precisionMs = 60_000;
  assert.deepEqual(read(input).sourceToPublication, metric(12_501, 72_500, 'composed_monotonic'));
  assert.equal(classifyLatency(read(input).sourceToPublication, 72_000), 'straddles');
});

test('monotonic samples from different processes cannot be subtracted', () => {
  const input = fixture();
  Object.assign(input.collected, { processKey: 'synthetic-process-a', monotonicMs: 90_000 });
  Object.assign(input.identityReady, { processKey: 'synthetic-process-b', monotonicMs: 1 });
  assert.deepEqual(read(input).collectionToIdentity, metric(10_000));
  delete input.identityReady.clockEpoch;
  assert.equal(read(input).collectionToIdentity.status, 'unverified');
  assert.equal(read(input).sourceToPublication.status, 'unknown');
});

test('unverified cross-process wall time is never classified within a threshold', () => {
  const input = fixture(); delete input.source.clockEpoch;
  const result = read(input);
  assert.equal(result.sourceToCollection.status, 'unverified');
  assert.equal(result.sourceToPublication.status, 'unverified');
  assert.equal(result.sourceToPublication.minimumMs, null);
  assert.equal(result.sourceToPublication.maximumMs, null);
  assert.equal(classifyLatency(result.sourceToPublication, 120_000), 'unknown');
});

test('negative wall time cannot be masked by later successful-looking publication', () => {
  const input = fixture(); input.source.atMs = 75_000;
  const result = read(input);
  assert.equal(result.sourceToCollection.status, 'clock_anomaly');
  assert.equal(result.sourceToPublication.status, 'unknown');
  input.identityReady.atMs = 60_000;
  assert.equal(read(input).collectionToIdentity.status, 'clock_anomaly');
  assert.equal(read(input).identityToPublication.status, 'unknown');
});

test('negative monotonic time and large wall jumps stay anomalous', () => {
  const input = fixture();
  Object.assign(input.collected, { processKey: 'synthetic-process', monotonicMs: 5_000 });
  Object.assign(input.identityReady, { processKey: 'synthetic-process', monotonicMs: 4_999 });
  assert.equal(read(input).collectionToIdentity.reason, 'negative_monotonic_interval');
  input.identityReady.monotonicMs = 5_001;
  assert.equal(read(input).collectionToIdentity.reason, 'wall_monotonic_disagreement');
  assert.equal(read(input).sourceToPublication.status, 'unknown');
  input.identityReady.monotonicMs = 15_000;
  input.collected.clockDiscontinuity = true;
  assert.equal(read(input).collectionToIdentity.reason, 'clock_discontinuity');
});

test('malformed, duplicate, oversized and unowned inputs fail closed without echoing text', () => {
  for (const input of [null, {}, '[]', '{', '{"current":{},"current":{}}', ' '.repeat(8193)]) {
    const result = measureMessageLatency(input);
    assert.equal(result.evidence, 'invalid');
    assert.equal(result.sourceToPublication.reason, 'invalid_input');
  }
  for (const mutate of [
    x => { x.current.recordKey = 'x'.repeat(129); },
    x => { x.source.precisionMs = 0; },
    x => { x.source.atMs = Number.MAX_SAFE_INTEGER; },
    x => { x.identityReady.monotonicMs = 1; },
    x => { x.identityReady.complete = 'true'; },
    x => { x.published.private_body = 'Authored secret is not echoed'; },
    x => { x.clockToleranceMs = null; },
  ]) {
    const input = fixture(); mutate(input);
    const result = read(input);
    assert.equal(result.evidence, 'invalid');
    assert.equal(classifyLatency(result.sourceToPublication, 120_000), 'unknown');
    assert.ok(!JSON.stringify(result).includes('Authored secret'));
  }
  const output = JSON.stringify(read(fixture()));
  for (const value of Object.values(CURRENT)) if (typeof value === 'string') assert.ok(!output.includes(value));
  assert.ok(!output.includes('synthetic-clock'));
});

test('budget uses actual monotonic elapsed time and reports exhaustion at equality', () => {
  assert.deepEqual(measureMonotonicBudget(100, 350.5, 1000), { status: 'within', elapsedMs: 250.5, remainingMs: 749.5 });
  assert.deepEqual(measureMonotonicBudget(100, 1100, 1000), { status: 'exhausted', elapsedMs: 1000, remainingMs: 0 });
  assert.deepEqual(measureMonotonicBudget(100, 1500, 1000), { status: 'exhausted', elapsedMs: 1400, remainingMs: 0 });
  for (const args of [[2, 1, 10], [0, Infinity, 10], [0, NaN, 10], [0, 1, -1], ['0', 1, 10]]) {
    assert.deepEqual(measureMonotonicBudget(...args), { status: 'invalid', elapsedMs: null, remainingMs: null });
  }
});
