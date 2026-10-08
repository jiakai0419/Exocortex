import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { publicRemoteReport, remoteSampleCache, parseRemoteSampleCache, summarizeRemoteSample } from '../src/diagnostics/remote-sample-cache.mjs';
import { publicStatusReport } from '../src/diagnostics/status-report.mjs';
import { collectCheckReport } from '../src/diagnostics/check-report.mjs';
import { runCheckCommand } from '../src/cli/check-command.mjs';
import { renderStatusText } from '../src/terminal/status-view.mjs';
import { statusWidth } from '../src/terminal/status-layout.mjs';
import { plain } from '../dist/terminal/index.js';
import { rawStatusScreenFixture } from './helpers/status-screen-fixture.mjs';
import { at, fixture, live, liveResult, options } from './helpers/check-fixture.mjs';

// Entirely invented in-memory evidence; no files, processes, services or API calls.
const PRIVATE = 'SYNTHETIC_PRIVATE_ERROR_BODY_PATH';
const context = { database_key: 'a'.repeat(64), account_key: 'b'.repeat(64), auth_identity_verified: true };
const diagnostic = { version: 1, stage: 'snapshot', code: 'snapshot_budget_exhausted' };
const invalidDiagnostics = [null, [], { ...diagnostic, version: 2 }, { ...diagnostic, version: true },
  { ...diagnostic, stage: PRIVATE }, { ...diagnostic, code: PRIVATE }, { ...diagnostic, path: PRIVATE },
  { ...diagnostic, stage: 'message_page' }, { version: 1, stage: 'snapshot' }];
const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { isTTY: false });
const compact = (value) => value.replace(/\s+/g, ' ');

function failedReport() {
  return live({ ok: false, status: 'unavailable', reason: 'invalid_evidence', collector_diagnostic: diagnostic,
    probe: { ...live().probe, hot_chats_requested: 5, hot_chats_found: 5, eligible_chats: 9,
      hot_chats: 2, fair_chats: 3, chats_checked: 5, pages: 6, truncated_chats: 1, api_calls: 8,
      remote_messages_checked: 0, probe_errors: 1 }, findings: {} });
}

function cache(report = failedReport()) {
  return remoteSampleCache({ report, cacheContext: context });
}

function status(freshness, detail = false) {
  const raw = rawStatusScreenFixture('healthy');
  raw.overview.freshness = freshness;
  return publicStatusReport({ report: raw, service: raw.probe, installed: { status: 'installed' }, observedAt: at }, { detail });
}

test('failed collector diagnostic survives v3 cache, read-only summary and status detail without changing counters', () => {
  const written = cache();
  const parsed = parseRemoteSampleCache(written);
  assert.ok(parsed);
  assert.deepEqual(parsed.collector_diagnostic, diagnostic);
  assert.equal(parsed.last_success_at, null);
  assert.deepEqual(parsed.probe, written.probe);
  const freshness = summarizeRemoteSample(parsed, at, context);
  assert.equal(freshness.status, 'unknown');
  assert.equal(freshness.reason, 'invalid_evidence');
  assert.deepEqual(freshness.collector_diagnostic, diagnostic);
  const projected = status({ ...freshness, raw: PRIVATE });
  assert.deepEqual(projected.freshness.collector_diagnostic, diagnostic);
  assert.equal(JSON.stringify(projected).includes(PRIVATE), false);
  for (const columns of [48, 96]) {
    const ordinary = plain(renderStatusText(projected, { columns, stream }));
    const detailed = plain(renderStatusText(status(freshness, true), { columns, stream }));
    assert.doesNotMatch(ordinary, /Sample diagnostic|snapshot_budget_exhausted|Sample matched/);
    assert.match(compact(detailed), /Sample diagnostic snapshot · snapshot_budget_exhausted/);
    assert.doesNotMatch(detailed, /Sample matched/);
    for (const line of detailed.split('\n')) assert.ok(statusWidth(line) <= columns);
  }
});

test('old v3 evidence remains compatible and an expired diagnosed failure stays expired', () => {
  const old = cache(live());
  assert.equal(Object.hasOwn(old, 'collector_diagnostic'), false);
  assert.equal(parseRemoteSampleCache(old).ok, true);
  assert.equal(summarizeRemoteSample(old, at, context).status, 'sampled');
  const expired = summarizeRemoteSample(cache(), at + 3_600_000, context);
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.status, 'unknown');
  const projected = status(expired);
  assert.equal(projected.freshness.reason, 'expired');
  assert.equal(projected.freshness.result, 'unavailable');
  assert.deepEqual(projected.freshness.collector_diagnostic, diagnostic);
});

test('raw cache rejects malformed diagnostic or contradictory success before normalization', () => {
  const valid = cache();
  for (const value of invalidDiagnostics) {
    assert.equal(parseRemoteSampleCache({ ...valid, collector_diagnostic: value }), null);
  }
  for (const edits of [{ ok: true }, { status: 'healthy' }, { status: 'delayed' }, { reason: 'sample_process_failed' },
    { reason: null }, { guardian_diagnostic: { version: 1, primary: { stage: 'guardian_result', errno: null }, cleanup: null } }]) {
    assert.equal(parseRemoteSampleCache({ ...valid, ...edits }), null);
  }
  for (const value of [diagnostic, ...invalidDiagnostics]) {
    const projected = publicRemoteReport({ ...live(), collector_diagnostic: value });
    assert.equal(projected.ok, false);
    assert.equal(projected.status, 'unavailable');
    assert.equal(projected.reason, 'invalid_evidence');
    assert.equal(JSON.stringify(projected).includes(PRIVATE), false);
    const rendered = status({ ...summarizeRemoteSample(cache(live()), at, context), collector_diagnostic: value });
    assert.equal(rendered.freshness.status, 'unknown');
    assert.equal(rendered.freshness.result, 'unavailable');
    assert.equal(rendered.freshness.reason, 'invalid_evidence');
    assert.equal(JSON.stringify(rendered).includes(PRIVATE), false);
  }
});

test('manual and one-shot checks cannot pass a healthy-looking result with any collector diagnostic', async () => {
  for (const writeLiveCache of [false, true]) for (const placement of ['report', 'result']) {
    for (const value of [diagnostic, ...invalidDiagnostics]) {
      const f = fixture();
      const result = placement === 'report'
        ? liveResult({ ...live(), collector_diagnostic: value })
        : liveResult(live(), { collector_diagnostic: value });
      f.deps.collectRemoteSample = () => result;
      f.deps.runManualRemoteSample = () => result;
      const checked = await collectCheckReport(options({ live: true, writeLiveCache }), f.context, f.deps);
      assert.equal(checked.exit_code, 1);
      assert.equal(checked.checks.live.status, 'unavailable');
      assert.equal(checked.checks.live.evidence.ok, false);
      assert.equal(checked.checks.live.evidence.reason, 'invalid_evidence');
      assert.equal(JSON.stringify(checked).includes(PRIVATE), false);
    }
  }
});

test('human check output displays only fixed stage and code for the failed attempt', async () => {
  for (const value of [diagnostic, { version: 1, stage: 'message_page', code: 'invalid_page_schema' }]) {
    const f = fixture();
    f.deps.collectRemoteSample = () => liveResult({ ...failedReport(), collector_diagnostic: value }, { outcome: 'failed' });
    const exit = await runCheckCommand(options({ live: true, format: 'text' }), f.context, f.deps);
    assert.equal(exit, 1);
    assert.match(compact(f.output()), new RegExp(`Sample diagnostic: ${value.stage} · ${value.code}`));
    assert.match(f.output(), /^Check: ERROR\n/);
    assert.doesNotMatch(f.output(), /^live: PASSED$/m);
  }
  const f = fixture();
  f.deps.collectRemoteSample = () => liveResult({ ...live(), collector_diagnostic: { ...diagnostic, error: PRIVATE } });
  assert.equal(await runCheckCommand(options({ live: true, format: 'text' }), f.context, f.deps), 1);
  assert.doesNotMatch(f.output(), /Sample diagnostic|SYNTHETIC_PRIVATE_ERROR_BODY_PATH|^live: PASSED$/m);
});
