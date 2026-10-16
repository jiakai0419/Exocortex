import assert from 'node:assert/strict';
import test from 'node:test';
import { executeLarkImSync, normalizeSyncOptions } from '../src/adapters/lark-im/sync-command.mjs';
import { createSyncRunner } from '../src/adapters/lark-im/sync-runner.mjs';

// Entirely synthetic command dependencies: no database, credential, external
// transport, production process, or shared coordination path is accessed.
const SELF = { open_id: 'ou_synthetic_recipient_command_owner', name: 'Synthetic Owner' };
function fixture(scope, result = { ok: true, list_complete: true }, tail) {
  const calls = [];
  const opts = normalizeSyncOptions({ db: '/synthetic/never-opened.sqlite', scope,
    start: '2025-01-02T00:00:00Z', end: '2025-01-02T01:00:00Z' });
  const before = { database_key: 'synthetic-database-key', empty: false, binding_absent: false };
  const deps = {
    ensureInitialized() {}, captureRemoteAccountBinding: () => before,
    getSelfProfile: () => SELF,
    readRemoteAccountBinding: () => ({ state: 'verified', database_key: before.database_key }),
    ensureSourceInitialSyncStart: (_db, _source, start) => start,
    reserveSyncAccountBinding() {}, captureLarkWriteAdmission: () => ({ fence: {}, assertCurrent() {} }),
    recordSuccessfulSyncBinding() { calls.push('binding'); },
    syncRunner: {
      syncSent() { calls.push('sent'); return result; },
      syncDiscovery() { calls.push('discover'); return { ok: true }; },
      syncReceived() { calls.push('received'); return [{ ok: true }]; },
      retryDetails() { calls.push('details'); return [{ ok: true }]; },
      syncRecipients(db, self) {
        assert.equal(db, opts.db); assert.equal(self, SELF);
        calls.push('recipients'); return tail?.() || { attempted: 1, calls: 4, updated: 1 };
      },
    },
  };
  return { calls, opts, deps };
}

for (const scope of ['sent', 'all']) test(`automatic recipient pass follows ${scope} commits and account confirmation`, () => {
  const f = fixture(scope);
  const report = executeLarkImSync(f.opts, f.deps);
  assert.deepEqual(f.calls, [...(scope === 'all' ? ['sent', 'discover', 'received'] : ['sent']), 'binding', 'recipients']);
  assert.equal(report.ok, true);
  assert.equal(Object.hasOwn(report, 'recipients'), false, 'existing summary and status contracts stay unchanged');
});

test('a committed list with pending details still permits independent recipient repair', () => {
  const f = fixture('sent', { ok: false, list_complete: true, incomplete: true, pending_details: 1 });
  const report = executeLarkImSync(f.opts, f.deps);
  assert.deepEqual(f.calls, ['sent', 'binding', 'recipients']);
  assert.equal(report.partial, true);
  assert.equal(report.sent.pending_details, 1);
});

for (const result of [{ ok: false }, { ok: true, skipped: true }]) test(`no recipient pass after ${result.skipped ? 'skipped' : 'failed'} sent ingestion`, () => {
  const f = fixture('sent', result);
  executeLarkImSync(f.opts, f.deps);
  assert.deepEqual(f.calls, ['sent', 'binding']);
});

for (const scope of ['discover', 'received', 'details']) test(`${scope} does not multiply the per-cycle recipient pass`, () => {
  const f = fixture(scope);
  executeLarkImSync(f.opts, f.deps);
  assert.deepEqual(f.calls, [scope, 'binding']);
});

test('optional failure does not change already committed sync summary or disclose its error', () => {
  const f = fixture('sent', undefined, () => { throw new Error('Synthetic private lookup error'); });
  const baseline = fixture('sent'); delete baseline.deps.syncRunner.syncRecipients;
  assert.deepEqual(executeLarkImSync(f.opts, f.deps), executeLarkImSync(baseline.opts, baseline.deps));
});

test('default automatic runner refuses real transport without an inherited API lease before touching the database', () => {
  const report = createSyncRunner().syncRecipients('/synthetic/never-opened.sqlite', SELF);
  assert.equal(report.reason, 'lease_unavailable');
  assert.equal(report.calls, 0);
});
