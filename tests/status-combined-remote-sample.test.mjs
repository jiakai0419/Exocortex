import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { publicStatusReport } from "../src/diagnostics/status-report.mjs";
import { remoteSampleCache } from "../src/diagnostics/remote-sample-cache.mjs";
import { summarizeServiceFreshness } from "../src/diagnostics/lark-im-service-report.mjs";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { statusWidth } from "../src/terminal/status-layout.mjs";
import { plain } from "../dist/terminal/index.js";
import { rawStatusScreenFixture, STATUS_SCREEN_NOW, STATUS_SCREEN_PRIVATE } from "./helpers/status-screen-fixture.mjs";

// Invented in-memory observations only. No service, database, cache or remote I/O.
const PRIVATE = "INVENTED_COMBINED_REMOTE_PRIVATE_PAYLOAD";
const DATABASE_KEY = "a".repeat(64);
const ACCOUNT_KEY = "c".repeat(64);
const iso = (offset) => new Date(STATUS_SCREEN_NOW + offset).toISOString();
const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { isTTY: false });
const headings = ["Health & current work", "Messages & progress", "Problems", "Background history", "Diagnostics"];
const compact = (value) => value.replace(/\s+/g, " ").trim();
const occurrences = (output, label) => output.split("\n").filter((line) => line.startsWith(`  ${label}`)
  && /^\s/.test(line.slice(label.length + 2, label.length + 3) || " ")).length;

function remote(overrides = {}) {
  // Enter through the actual v3 cache validator/service summary. Counters are
  // conserved, truncated chats have a second page, and the complete 24-hour
  // creation window ends at least ten minutes before this synthetic check.
  const expired = overrides.reason === "expired";
  const checkedOffset = overrides.checkedOffset ?? (expired ? -31 * 60_000 : -60_000);
  const endOffset = checkedOffset - 10 * 60_000;
  const findings = { present: 12, missing: 0, pending_sync: 0, suspected_missing: 0, confirmed_missing: 0,
    stale_version: 0, content_mismatch: 0, identity_conflict: 0, local_newer: 0, content_equal: 10,
    content_unverified: 2, unresolved_prior: 0, expired_observations: 0, observation_overflow: 0, ...overrides.findings };
  findings.missing = findings.pending_sync + findings.suspected_missing + findings.confirmed_missing;
  findings.present = 12 - findings.missing;
  findings.content_equal = Math.min(10, findings.present - findings.stale_version - findings.content_mismatch
    - findings.identity_conflict - findings.local_newer);
  findings.content_unverified = 12 - findings.content_equal;
  const binding = overrides.binding || { state: "verified", evidence: "single_sent_actor" };
  const result = expired ? "healthy" : overrides.result || "healthy";
  const cache = remoteSampleCache({ cacheContext: { database_key: DATABASE_KEY, account_key: ACCOUNT_KEY,
    auth_identity_verified: binding.state === "verified" }, report: {
    status: result, ok: result === "healthy", reason: expired ? null : overrides.reason || null,
    checked_at: iso(checkedOffset), window: { start: iso(endOffset - 24 * 3_600_000), end: iso(endOffset) }, binding,
    findings, probe: { hot_chats_requested: 5, hot_chats_found: 3, messages_per_chat: 20, remote_messages_checked: 12,
      eligible_chats: 17, hot_chats: 2, fair_chats: 1, chats_checked: 3, pages: 4,
      truncated_chats: 1, api_calls: 6, unsupported_chats: 0, probe_errors: 0 }, raw: PRIVATE,
  } });
  if (overrides.corrupt) cache.probe.pages = 0;
  const summary = summarizeServiceFreshness(cache, STATUS_SCREEN_NOW, undefined, { database_key: DATABASE_KEY });
  // The final public projection also must reject fields absent from its whitelist.
  return { ...summary, raw: PRIVATE, database_key: PRIVATE };
}

function project({ detail = false, details, freshness = remote(), runtimeAvailable = true } = {}) {
  const report = rawStatusScreenFixture("healthy");
  report.overview.freshness = freshness;
  if (details) report.sync.status.details = { ...report.sync.status.details, ...details };
  // Bind only the existing fictional helper events. Runtime calculation and the
  // remote whitelist both go through the actual combined public projection.
  const event = report.worker.log.events[0];
  const worker = { type: "lark_im_worker_activity", version: 1, role: "worker", instance_id: event.instance_id,
    database_key: event.database_key, parent_instance: null, pid: report.probe.pid,
    process_started_at_ms: STATUS_SCREEN_NOW - 3 * 3_600_000,
    phase: "waiting", cycle: 4, step: null, updated_at: iso(-10_000), valid_until: iso(20_000) };
  const binding = { target_match: runtimeAvailable ? "matched" : "unknown", phase: { state: "waiting" }, worker };
  report.activity_evidence = { database_identity_stable: true, integrity: true, database_key: event.database_key,
    processes: new Map([[worker.pid, { state: "alive", started_at_ms: worker.process_started_at_ms }]]) };
  return publicStatusReport({ report, observedAt: STATUS_SCREEN_NOW, binding,
    service: { ...report.probe, target_match: binding.target_match }, installed: { status: "installed" },
  }, { detail });
}

function render(report, columns) {
  const before = JSON.stringify(report);
  const output = plain(renderStatusText(report, { columns, stream }));
  assert.equal(JSON.stringify(report), before, "combined rendering must not change any public JSON value");
  assert.doesNotMatch(`${output}\n${before}`, new RegExp(`${PRIVATE}|${STATUS_SCREEN_PRIVATE}|${DATABASE_KEY}|${ACCOUNT_KEY}`));
  for (const line of output.split("\n")) assert.ok(statusWidth(line) <= columns, `overflow at ${columns}: ${line}`);
  return output;
}

function section(output, heading) {
  const lines = output.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  let end = start + 1;
  while (end < lines.length && !headings.includes(lines[end])) end += 1;
  return compact(lines.slice(start + 1, end).join("\n"));
}

function pairedStats(output, detailed = false) {
  const labels = output.split("\n").map((line) => /^ {2}(Runs|Last completed|Run scope)(?:\s|$)/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(labels, detailed ? ["Runs", "Last completed", "Run scope"] : ["Runs", "Last completed"]);
  assert.doesNotMatch(output, /^ {2}(?:Total runs|Successful runs|Last duration)(?:\s|$)/m);
  const current = section(output, "Health & current work");
  assert.match(current, /Runs 4 total · 4 successful/);
  assert.match(current, /Last completed .*\(35s ago\) · 12s duration/);
  if (!detailed) assert.doesNotMatch(output, /current worker \/ retained log/);
}

test("combined default retains paired statistics and one matched remote sample while hiding zero detail debt", () => {
  const report = project();
  for (const columns of [40, 96]) {
    const output = render(report, columns);
    pairedStats(output);
    assert.equal(occurrences(output, "Remote sample"), 1);
    assert.match(section(output, "Messages & progress"), /Remote sample Sample matched · 12 messages \/ 3 discovered chats · checked/);
    assert.doesNotMatch(output, /Message details|0 pending|0 due for retry|^Problems$/m);
    assert.doesNotMatch(output, /all remote messages|fully up.to.date|real.time coverage/i);
  }
});

test("combined default moves detail debt to Problems once without moving or duplicating the remote sample", () => {
  const report = project({ details: { pending_count: 4, due_count: 2, scopes_pending: 3 } });
  for (const columns of [40, 96]) {
    const output = render(report, columns);
    pairedStats(output);
    assert.doesNotMatch(section(output, "Messages & progress"), /Message details/);
    assert.match(section(output, "Problems"), /^Message details 4 pending · 2 due for retry · 3 sources$/);
    assert.equal(occurrences(output, "Message details"), 1);
    assert.equal(occurrences(output, "Remote sample"), 1);
    assert.match(section(output, "Messages & progress"), /Sample matched/);
    assert.ok(output.indexOf("Remote sample") < output.indexOf("\nProblems\n"));
  }
});

test("unavailable detail and worker evidence stay explicit beside a confirmed remote difference", () => {
  const findings = { ...remote().findings, present: 11, missing: 1, confirmed_missing: 1 };
  const report = project({ details: { evidence: "unavailable" }, runtimeAvailable: false,
    freshness: remote({ result: "needs_attention", reason: "confirmed_missing", findings }) });
  for (const columns of [40, 96]) {
    const output = render(report, columns);
    const current = section(output, "Health & current work");
    assert.match(current, /Runs Unavailable · current worker unverified Last completed Unavailable/);
    assert.match(section(output, "Problems"), /^Message details Evidence unavailable$/);
    assert.match(section(output, "Messages & progress"), /Remote sample 1 confirmed missing · 12 messages \/ 3 discovered chats/);
    assert.equal(occurrences(output, "Message details"), 1);
    assert.equal(occurrences(output, "Remote sample"), 1);
    assert.doesNotMatch(output, /0 pending|Runs\s+0 total|Sample matched/);
  }
  const rejected = project({ details: { pending_count: 4, due_count: 2, scopes_pending: 3 }, freshness: remote({ corrupt: true }) });
  assert.equal(rejected.freshness.status, "unknown");
  assert.equal(rejected.freshness.reason, "invalid_evidence");
  assert.equal(rejected.freshness.auth_identity, "unknown");
  for (const columns of [40, 96]) {
    const output = render(rejected, columns);
    pairedStats(output);
    assert.match(section(output, "Messages & progress"), /Remote sample Not verified/);
    assert.match(section(output, "Problems"), /^Message details 4 pending · 2 due for retry · 3 sources$/);
    assert.doesNotMatch(output, /Sample matched|discovered chats/);
  }
});

test("remote states remain distinct after runtime pairing and ordinary-detail removal", () => {
  const variants = [
    [{ reason: "expired" }, /Expired/],
    [{ result: "delayed", reason: "sync_pending", findings: { pending_sync: 3 } }, /3 awaiting sync/],
    [{ result: "delayed", reason: "suspected_missing", findings: { suspected_missing: 2 } }, /2 suspected missing/],
    [{ result: "needs_attention", reason: "confirmed_missing", findings: { confirmed_missing: 1 } }, /1 confirmed missing/],
    [{ result: "needs_attention", reason: "source_difference", findings: { stale_version: 2, content_mismatch: 1 } }, /2 older versions · 1 content differences/],
    [{ result: "inconclusive", reason: "unresolved_observations", findings: { unresolved_prior: 4 } }, /4 prior findings unresolved/],
    [{ result: "unavailable", reason: "account_unverified", binding: { state: "unverified" } }, /Not verified/],
  ];
  for (const [overrides, expected] of variants) {
    const report = project({ freshness: remote({ ...overrides, findings: { ...remote().findings, ...overrides.findings } }) });
    assert.equal(report.freshness.reason, overrides.reason);
    for (const columns of [40, 96]) {
      const output = render(report, columns);
      pairedStats(output);
      assert.match(section(output, "Messages & progress"), expected);
      assert.equal(occurrences(output, "Remote sample"), 1);
      assert.doesNotMatch(output, /Message details|^Problems$/m);
      assert.doesNotMatch(section(output, "Messages & progress"), /Sample matched/);
    }
  }
});

test("combined detail keeps normal detail counts, runtime scope and bounded remote explanations", () => {
  const report = project({ detail: true });
  for (const columns of [40, 96]) {
    const output = render(report, columns);
    pairedStats(output, true);
    assert.match(section(output, "Health & current work"), /Run scope Completed rounds · current worker \/ retained log/);
    const progress = section(output, "Messages & progress");
    assert.match(progress, /Message details 0 pending · 0 due for retry · 0 sources/);
    assert.match(progress, /Sample coverage 2 hot \+ 1 rotating · 17 eligible chats · 1 truncated/);
    assert.match(progress, /Sample content 10 static bodies matched · 2 unverified/);
    assert.match(progress, /Sample identity Matched at check · stored sent identity/);
    assert.match(progress, /Sample limits Discovered chat creation window; thread-only replies and client dynamic cards unverified/);
    assert.match(progress, /Sample window .* Sample coverage/);
    assert.match(progress, /Sample result Matched · expires/);
    assert.doesNotMatch(progress, /Sample result unknown/);
    assert.equal(occurrences(output, "Message details"), 1);
    assert.equal(occurrences(output, "Remote sample"), 1);
    assert.doesNotMatch(output, /^Problems$/m);
  }
});

test("legacy freshness JSON stays exact; rotating samples only extend the reviewed freshness whitelist", () => {
  const legacy = { status: "sampled", auth_identity: "unknown", scope: "recent_hot_messages", reason: null,
    window: { start: iso(-3_600_000), end: iso(-600_000) }, sample_count: 5, checked_at: iso(-2_000), expires_at: iso(298_000) };
  for (const detail of [false, true]) {
    const before = project({ detail, freshness: legacy });
    const after = project({ detail });
    assert.deepEqual(before.freshness, { ...legacy, reason: "unknown" });
    const { freshness: _old, ...oldOther } = before;
    const { freshness: _new, ...newOther } = after;
    assert.deepEqual(newOther, oldOther, "runtime, detail, service and all other JSON fields retain exact values");
    assert.deepEqual(Object.keys(after.freshness).sort(), [...Object.keys(legacy), "result", "chat_count", "binding", "findings", "sample"].sort());
    assert.equal(after.freshness.scope, "discovered_chats_rotating");
    assert.equal(after.freshness.auth_identity, "verified_at_check");
    assert.deepEqual(after.freshness.binding, { state: "verified", evidence: "single_sent_actor", tenant_verified: false });
    assert.deepEqual(after.freshness.findings, remote().findings);
    assert.deepEqual(after.freshness.sample, { eligible_chats: 17, hot_chats: 2, fair_chats: 1, chats_checked: 3,
      pages: 4, truncated_chats: 1, api_calls: 6, unsupported_chats: 0, probe_errors: 0 });
    assert.equal(after.freshness.raw, undefined);
    assert.equal(after.freshness.database_key, undefined);
    const output = render(before, 40);
    pairedStats(output, detail);
    assert.match(section(output, "Messages & progress"), /Remote sample Sample matched · 5 messages · checked/);
    assert.doesNotMatch(output, /discovered chats|Sample coverage|Sample content|Sample identity/);
    if (detail) assert.match(section(output, "Messages & progress"), /Recent active-chat sample only; current remote account identity is unverified/);
  }
});

test("valid mixed findings remain complete in default and detail without changing public JSON", () => {
  const findings = { confirmed_missing: 1, suspected_missing: 1, pending_sync: 1,
    stale_version: 2, content_mismatch: 1, identity_conflict: 1, unresolved_prior: 2 };
  for (const detail of [false, true]) {
    const report = project({ detail, freshness: remote({ result: "needs_attention", reason: "confirmed_missing", findings }) });
    assert.equal(report.freshness.status, "behind");
    for (const [key, value] of Object.entries(findings)) assert.equal(report.freshness.findings[key], value);
    for (const columns of [40, 96]) {
      const output = render(report, columns), progress = section(output, "Messages & progress");
      for (const text of ["1 confirmed missing", "1 suspected missing", "1 awaiting sync", "2 older versions",
        "1 content differences", "1 message identity conflicts", "2 prior findings unresolved"]) assert.ok(progress.includes(text), text);
      assert.equal(occurrences(output, "Remote sample"), 1);
      assert.doesNotMatch(progress, /Sample matched/);
    }
  }
});

test("message identity conflicts remain distinct from the verified account association", () => {
  for (const detail of [false, true]) {
    const report = project({ detail, freshness: remote({ result: "needs_attention", reason: "source_difference", findings: { identity_conflict: 1 } }) });
    assert.equal(report.freshness.status, "behind");
    assert.equal(report.freshness.binding.state, "verified");
    for (const columns of [40, 96]) {
      const progress = section(render(report, columns), "Messages & progress");
      assert.match(progress, /Remote sample 1 message identity conflicts/);
      assert.doesNotMatch(progress, /Remote sample Not verified|Sample matched/);
      if (detail) assert.match(progress, /Sample identity Matched at check/);
    }
  }
});

test("rejected sample evidence cannot promote retained differences or body matches", () => {
  const findings = { confirmed_missing: 1, stale_version: 1, identity_conflict: 1 };
  const scenarios = [
    [{ result: "needs_attention", reason: "confirmed_missing", checkedOffset: 60_000, findings }, "invalid_timestamp", /cached sample has invalid times/],
    [{ reason: "expired", findings }, "expired", /Expired/],
    [{ result: "needs_attention", reason: "confirmed_missing", binding: { state: "unverified" }, findings }, "confirmed_missing", /account association is unverified/],
    [{ result: "needs_attention", reason: "source_difference", binding: { state: "conflict" }, findings }, "source_difference", /account association conflicts/],
    [{ corrupt: true }, "invalid_evidence", /cached sample evidence is invalid/],
  ];
  for (const [input, reason, expected] of scenarios) for (const detail of [false, true]) {
    const report = project({ detail, freshness: remote(input) });
    assert.equal(report.freshness.status, "unknown");
    assert.equal(report.freshness.reason, reason);
    if (!input.corrupt) assert.equal(report.freshness.findings.confirmed_missing, 1, "retain machine evidence unchanged");
    for (const columns of [40, 96]) {
      const progress = section(render(report, columns), "Messages & progress");
      assert.match(progress, expected);
      assert.doesNotMatch(progress, /1 confirmed missing|1 older versions|1 message identity conflicts|static bodies matched|Sample matched|Matched at check/);
    }
  }
});

test("inconclusive and cooldown reasons stay explicit while healthy samples stay compact", () => {
  for (const detail of [false, true]) for (const columns of [40, 96]) {
    const inconclusive = project({ detail, freshness: remote({ result: "inconclusive", reason: "unresolved_observations",
      findings: { unresolved_prior: 2, local_newer: 1, expired_observations: 3, observation_overflow: 4 } }) });
    assert.equal(inconclusive.freshness.status, "unknown");
    const progress = section(render(inconclusive, columns), "Messages & progress");
    for (const text of ["Not verified", "2 prior findings unresolved", "1 newer local versions", "3 expired observations", "4 observations beyond retained capacity"]) assert.ok(progress.includes(text), text);
    const cooldown = project({ detail, freshness: remote({ result: "unavailable", reason: "rate_cooldown", binding: { state: "unverified" } }) });
    assert.match(section(render(cooldown, columns), "Messages & progress"), /Not verified · waiting for rate-limit cooldown/);
    const failed = project({ detail, freshness: remote({ result: "unavailable", reason: "sample_failed" }) });
    const failedProgress = section(render(failed, columns), "Messages & progress");
    assert.match(failedProgress, /Not verified · sample attempt failed/);
    assert.doesNotMatch(failedProgress, /static bodies matched|Sample matched/);
    if (detail) assert.match(failedProgress, /Sample identity Matched at check/, "account binding alone cannot validate the comparison");
    const healthy = section(render(project({ detail }), columns), "Messages & progress");
    assert.match(healthy, /Sample matched/);
    assert.doesNotMatch(healthy, /0 confirmed|0 older|0 message identity|Sample result unknown/);
    if (detail) assert.match(healthy, /Sample result Matched/);
  }
});
