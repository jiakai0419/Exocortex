import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderStatusText } from "../src/terminal/status-view.mjs";
import { runStatusCommand } from "../src/cli/status-command.mjs";
import { createCommandContext } from "../src/cli/context.mjs";
import { plain } from "../dist/terminal/index.js";
import { STATUS_SCREEN_NOW, STATUS_SCREEN_PRIVATE, STATUS_SCREEN_SCENARIOS,
  rawStatusScreenFixture, statusScreenFixture } from "./helpers/status-screen-fixture.mjs";

const REQUIRED_SECTIONS = ["Health & current work", "Messages & progress"];
const DETAIL_SECTIONS = ["Background history", "Diagnostics"];
const SECTIONS = [...REQUIRED_SECTIONS, "Problems", ...DETAIL_SECTIONS];
const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { isTTY: false, columns: 80 });
const text = (name = "healthy", options = {}) => plain(renderStatusText(statusScreenFixture(name, options), { columns: 96, stream, ...options }));
const compact = (value) => value.replace(/\s+/g, " ").trim();
const hasSection = (output, heading) => output.split("\n").includes(heading);

function assertDefaultNoiseAbsent(output) {
  assert.doesNotMatch(output, /local sync checks only|selected database verified|oldest list checkpoint|Command targets|Coverage limits|Optional sample|History scope|npm run exo --/i);
  for (const heading of DETAIL_SECTIONS) assert.equal(hasSection(output, heading), false, `${heading} belongs in detail`);
  assert.doesNotMatch(output, /Completed rounds|Latest success|Failed tasks|No required action identified/);
  assert.doesNotMatch(output, /List scan target|Received lists|Sent list|reached target|List target basis/i);
}

function section(output, heading) {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if ([...SECTIONS, "PRIVATE LOGS", "Private logs"].includes(lines[index].trim())) { end = index; break; }
  }
  return compact(lines.slice(start + 1, end).join("\n"));
}

function assertWidth(output, columns) {
  for (const line of plain(output).split("\n")) {
    assert.ok([...line].length <= columns, `${columns}-column screen overflow (${[...line].length}): ${line}`);
  }
}

function renderInEnvironment({ scenario = "healthy", columns = 80, tty = false, color = "auto", detail = false, zone = "UTC" } = {}) {
  const view = new URL("../src/terminal/status-view.mjs", import.meta.url).href;
  const fixture = new URL("./helpers/status-screen-fixture.mjs", import.meta.url).href;
  const env = { ...process.env, TZ: zone, TERM: "xterm-256color" };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;
  if (color === "force") env.FORCE_COLOR = "1";
  if (color === "none") env.NO_COLOR = "1";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { renderStatusText } from ${JSON.stringify(view)};
    import { statusScreenFixture } from ${JSON.stringify(fixture)};
    import { Writable } from 'node:stream';
    import { WriteStream } from 'node:tty';
    const stream = ${tty} ? new WriteStream(1) : new Writable({ write(_chunk, _encoding, done) { done(); } });
    stream.columns = ${columns};
    process.stdout.write(renderStatusText(statusScreenFixture(${JSON.stringify(scenario)}, { detail: ${detail} }), { columns: ${columns}, stream }));
  `], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("synthetic default screen has one coherent hierarchy and human task names", () => {
  const output = text("syncing");
  assert.match(output, /^Exocortex status\n/);
  const positions = REQUIRED_SECTIONS.map((heading) => output.indexOf(`\n${heading}\n`));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.doesNotMatch(output, /Recent cycles \(up to|Statistics range:|Last event:|Last step:|Unfinished history:|\bUNKNOWN\b|lark_im_worker_|discover-reconcile/);
  assert.match(section(output, "Health & current work"), /Current work.*(?:Syncing|Synchronizing).*conversation/i);
  assert.match(section(text("syncing", { detail: true }), "Background history"), /(?:round|completion).*record|record.*(?:round|completion)/i);
  assert.match(section(output, "Messages & progress"), /293.*54.*232.*7/s);
  assert.match(section(output, "Messages & progress"), /unclassified|unknown direction/i);
  assertDefaultNoiseAbsent(output);
  assert.equal(hasSection(output, "Problems"), false);
});

for (const name of STATUS_SCREEN_SCENARIOS) {
  for (const columns of [96, 80, 56, 40]) {
    for (const detail of [false, true]) {
      test(`whole ${name}${detail ? " detail" : ""} screen fits ${columns} columns without dropping sections or private values`, () => {
        const report = statusScreenFixture(name, { detail });
        const before = structuredClone(report);
        const output = plain(renderStatusText(report, { columns, stream }));
        assertWidth(output, columns);
        for (const heading of [...REQUIRED_SECTIONS, ...(detail ? DETAIL_SECTIONS : [])]) assert.ok(output.split("\n").includes(heading), heading);
        if (!detail) assertDefaultNoiseAbsent(output);
        assert.doesNotMatch(output, new RegExp(STATUS_SCREEN_PRIVATE));
        assert.doesNotMatch(output, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
        assert.deepEqual(report, before, "rendering must not mutate the report");
        assert.match(output, /\n$/);
      });
    }
  }
}

test("Problems is conditional and does not duplicate work, progress or sample status", () => {
  for (const scenario of STATUS_SCREEN_SCENARIOS.filter((name) => !["failed", "unavailable", "unbound_failure"].includes(name))) {
    assert.equal(hasSection(text(scenario), "Problems"), false, `${scenario} has no independent problem row`);
  }
  for (const scenario of ["failed", "unavailable", "unbound_failure"]) {
    assert.equal(hasSection(text(scenario), "Problems"), true, `${scenario} must expose its independent problems`);
  }
});

test("catch-up retains independent discovery, full-content cursors, detail debt and every restriction", () => {
  const output = text("catching_up", { columns: 40 });
  const coverage = section(output, "Messages & progress");
  assert.match(coverage, /(?:discover|conversation list).*?(?:remaining|more|progress|incomplete|not complete)/i);
  assert.match(coverage, /9.*(?:cursor|successful|initial|content)/i);
  assert.match(coverage, /6 pending.*2 due.*3 sources/i);
  assert.match(coverage, /Restricted chats.*5.*excluded/i);
  assert.match(section(output, "Health & current work"), /catching up/i);
  assert.equal((output.match(/Restricted chats/g) || []).length, 1);
  assert.doesNotMatch(output, /Coverage limits|Content backlog/);
  const detail = text("catching_up", { detail: true });
  assert.match(detail, /71101/);
  assert.match(detail, /71102/);
  assert.doesNotMatch(output, /discover-catchup|received-fair|bot_user_out_of_chat|restricted_mode/);
});

test("healthy local progress and waiting never claim complete remote freshness", () => {
  const output = text();
  const current = section(output, "Health & current work");
  assert.match(current, /Current work.*Waiting/i);
  assert.match(current, /Background.*Running/i);
  assert.match(section(output, "Messages & progress"), /Remote sample.*(?:not verified|unverified|no cached)/i);
  assert.equal(hasSection(output, "Problems"), false);
  assertDefaultNoiseAbsent(output);
  assert.doesNotMatch(output, /all remote messages|fully up.to.date|real.time coverage|current work.*received-fair/i);
});

test("normal default health and database binding occupy one concise row each", () => {
  const current = section(text(), "Health & current work");
  assert.match(current, /^Local health OK Background Running Current work Waiting/);
  assert.doesNotMatch(current, /passed|local sync checks only|selected database verified/);
  const report = statusScreenFixture();
  report.service.target_match = "unknown";
  const uncertain = section(plain(renderStatusText(report, { columns: 80, stream })), "Health & current work");
  assert.match(uncertain, /Background Running.*(?:database.*(?:unverified|not verified|could not)|cannot.*database)/i);
  assert.doesNotMatch(uncertain, /database verified/);
});

test("normal list checkpoints stay in diagnostics without becoming a coverage claim", () => {
  const output = text("healthy");
  const progress = section(output, "Messages & progress");
  assert.match(progress, /Received chats 14 enabled/);
  assert.doesNotMatch(progress, /Message lists|checkpoint|reached target|synced through|fully synced/i);
  const diagnostics = section(renderInEnvironment({ scenario: "healthy", columns: 96, detail: true }), "Diagnostics");
  assert.match(diagnostics, /Message lists 15 recorded sources.*oldest list checkpoint Today \d{2}:\d{2}:\d{2}/i);
  assert.doesNotMatch(diagnostics, /List scan target|Received lists|Sent list|List target basis/);
});

test("unavailable and invalid list evidence remains visible in the default screen", () => {
  for (const evidence of ["unavailable", "legacy_unavailable"]) {
    const report = statusScreenFixture();
    report.sync.list_progress = { evidence };
    const output = plain(renderStatusText(report, { columns: 40, stream }));
    const progress = section(output, "Messages & progress");
    assert.match(progress, /Message lists.*(?:Evidence unavailable|Unavailable in this database version)/i);
    assert.doesNotMatch(progress, /Message lists 0|all messages|fully synced|oldest list checkpoint/i);
    assertDefaultNoiseAbsent(output);
    assertWidth(output, 40);
  }
  const report = statusScreenFixture();
  report.sync.list_progress.invalid_cursor_scopes = 3;
  const output = plain(renderStatusText(report, { columns: 40, stream }));
  assert.match(section(output, "Messages & progress"), /Message lists 3 invalid list checkpoints/i);
  assertDefaultNoiseAbsent(output);
  assertWidth(output, 40);
});

test("pending content remains visible and its affected sources are not renamed conversations", () => {
  const report = statusScreenFixture();
  Object.assign(report.sync.details, { pending_count: 3, due_count: 1, scopes_pending: 2,
    oldest_pending_ms: STATUS_SCREEN_NOW - 2 * 3_600_000 });
  const output = plain(renderStatusText(report, { columns: 96, stream }));
  const progress = section(output, "Messages & progress");
  assert.match(progress, /Message details 3 pending.*1 due.*2 sources/);
  assert.doesNotMatch(progress, /2 (?:chats|conversations)|all messages|fully synced|complete content/i);
  assert.doesNotMatch(output, /Content backlog/);
});

test("empty database retains missing initial evidence instead of implying complete coverage", () => {
  const output = text("empty");
  const coverage = section(output, "Messages & progress");
  assert.match(coverage, /Stored messages.*0 total/i);
  assert.match(coverage, /Received chats 0 enabled/);
  assert.doesNotMatch(coverage, /0\/0 reached|Reached target/);
  assert.match(coverage, /(?:discovery|conversation list).*(?:not started|not complete|not recorded|no completion|not yet established)/i);
  assert.match(coverage, /1.*without.*success/i);
  assert.doesNotMatch(section(output, "Health & current work"), /Local health\s+OK\b/);
  assert.match(section(text("empty", { detail: true }), "Background history"), /no.*(?:event|observation|round)|(?:event|observation|round).*not available/i);
});

test("stopped service and unavailable inspection remain different conclusions", () => {
  const stopped = section(text("stopped"), "Health & current work");
  const unavailable = section(text("unavailable"), "Health & current work");
  assert.match(stopped, /Background.*(?:Stopped|not loaded)/i);
  assert.match(stopped, /Current work.*(?:Stopped|no current.*sync)/i);
  assert.match(unavailable, /Background.*(?:unavailable|not verified|cannot|unconfirmed|could not)/i);
  assert.doesNotMatch(unavailable, /Background\s+Stopped/i);
  assert.match(section(text("unavailable"), "Problems"), /Database failures.*(?:unavailable|could not|cannot)/i);
  assert.doesNotMatch(section(text("unavailable"), "Problems"), /Database failures\s+0\b/);
  assert.match(section(text("unavailable"), "Problems"), /(?:reservation|lease).*(?:unavailable|could not|cannot)/i);
});

test("a legacy database has unavailable detail and list evidence rather than zero debt", () => {
  const coverage = section(text("legacy"), "Messages & progress");
  assert.match(coverage, /Message (?:details|content).*(?:legacy|unavailable in this database version)/i);
  assert.match(coverage, /Message lists.*(?:legacy|unavailable)/i);
  assert.doesNotMatch(coverage, /Message (?:details|content)\s+0 pending/i);
});

test("failures preserve all categories, numeric counts and abnormal reservations", () => {
  const output = text("failed", { columns: 40 });
  const problems = section(output, "Problems");
  assert.match(section(output, "Health & current work"), /(?:PROBLEM|attention|failed)/i);
  assert.match(section(text("failed", { detail: true }), "Background history"), /3.*succeed.*1.*fail.*4.*total/i);
  assert.match(problems, /15.*(?:failed|failure)/i);
  for (const pattern of [/permission|access denied/i, /timeout|timed out/i, /rate limit/i, /service unavailable/i, /unclassified|unknown failure/i]) assert.match(problems, pattern);
  assert.match(problems, /reservation|lease|lock/i);
  assert.match(problems, /(?:background log|worker log).*(?:fail|failure)/i);
  assert.match(problems, /database.*(?:unverified|not verified)/i);
  assert.match(output, /expired/i);
  assert.match(output, /future/i);
});

test("two-hour worker observations and database 24-hour failures have separate window labels", () => {
  const output = renderInEnvironment({ scenario: "failed", columns: 96, detail: true });
  const history = section(output, "Background history");
  assert.match(history, /Worker log|Log window|Worker window/i);
  assert.match(history, /10:00.*11:59/);
  const problems = section(output, "Problems");
  assert.match(problems, /Failure window/i);
  assert.match(problems, /2032-02-03 12:00.*(?:Today |2032-02-04 )?12:00/);
  assert.match(history, /partial|earlier.*unavailable|does not cover/i);
  assert.match(problems, /retained|retention/i);
  assert.doesNotMatch(history, /Database failures|Failure window/);
});

test("zero database failures move to detail while missing or malformed counts remain visible", () => {
  const healthy = text();
  assert.doesNotMatch(healthy, /Database failures|Database window/);
  assert.equal(hasSection(healthy, "Problems"), false);
  assert.match(section(text("healthy", { detail: true }), "Diagnostics"), /Database failures 0 retained failed runs/);
  for (const failedRuns of [null, undefined, -1, "0"]) {
    const report = statusScreenFixture();
    report.failure_runs.failed_runs = failedRuns;
    const problems = section(plain(renderStatusText(report, { columns: 80, stream })), "Problems");
    assert.match(problems, /Database failures.*(?:unavailable|not known|unverified)/i);
    assert.doesNotMatch(problems, /Database failures 0\b/);
  }
});

test("unbound failed history stays attributed to the background log beside healthy selected-database evidence", () => {
  const report = statusScreenFixture("healthy");
  report.worker.last_cycle = { cycle: 20, ok: false, at: new Date(STATUS_SCREEN_NOW - 30_000).toISOString(), age_ms: 30_000,
    result_valid: true, timestamp_valid: true };
  Object.assign(report.stability.cycles, { total: 5, ok: 4, failed: 1 });
  const output = plain(renderStatusText(report, { columns: 96, stream }));
  assert.match(section(output, "Health & current work"), /^Local health OK /);
  const problems = section(output, "Problems");
  assert.match(problems, /(?:Background log|Worker log).*(?:failed|failure)/i);
  assert.match(problems, /database.*(?:unverified|not verified)/i);
  assert.doesNotMatch(problems, /Database failures|current database.*failed|selected database.*failed/i);
  assertDefaultNoiseAbsent(output);
});

test("old-only history is dated, window statistics stay empty, and current work stays unconfirmed", () => {
  const output = renderInEnvironment({ scenario: "old_history", detail: true });
  assert.match(section(output, "Health & current work"), /Current work.*(?:unconfirmed|not verified|unavailable|cannot)/i);
  assert.doesNotMatch(section(output, "Health & current work"), /Current work\s+(?:Syncing|Waiting)/i);
  const history = section(output, "Background history");
  assert.match(history, /2032-02-02/);
  assert.match(history, /0.*(?:succeed|round)|no.*(?:completion|round)/i);
  assert.match(history, /(?:need|fewer than|at least).*2|two.*success/i);
});

test("future or malformed history is not displayed as a success just now", () => {
  const output = text("invalid_history", { detail: true });
  const history = section(output, "Background history");
  assert.match(history, /invalid|unavailable|unverified|not valid|unreliable/i);
  assert.doesNotMatch(history, /(?:Succeeded|Success|OK).*\(0s ago\)/i);
  assert.doesNotMatch(output, /synthetic-invalid-time/);
});

test("log truncation is disclosed without claiming continuous coverage", () => {
  const history = section(text("truncated", { detail: true }), "Background history");
  assert.match(history, /truncat|clipped|tail limit/i);
  assert.doesNotMatch(history, /(?:continuous|complete) (?:24h|24.hour|log coverage)/i);
});

test("sample window, check time and validity are distinct from worker statistics", () => {
  const output = renderInEnvironment({ scenario: "sampled", columns: 96, detail: true });
  const coverage = section(output, "Messages & progress");
  assert.match(coverage, /11.*(?:message|sample)/i);
  assert.match(coverage, /11:50.*11:59/);
  assert.match(coverage, /11:59:30/);
  assert.match(coverage, /12:04:00/);
  assert.match(coverage, /(?:identity|principal).*(?:unverified|unknown|not verified)/i);
  assert.match(section(text("behind"), "Messages & progress"), /Remote sample.*(?:behind|missing|delayed)/i);
  assert.match(section(text("expired"), "Messages & progress"), /Remote sample.*expired/i);
});

test("detail mode adds readable diagnostics and retains the public projection", () => {
  const report = statusScreenFixture("failed", { detail: true });
  const output = plain(renderStatusText(report, { columns: 40, stream }));
  assertWidth(output, 40);
  assert.ok(output.indexOf("\nDiagnostics\n") > output.indexOf("\nBackground history\n"));
  assert.doesNotMatch(output, /"records"\s*:|"by_status"\s*:|"db_path"\s*:/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(STATUS_SCREEN_PRIVATE));
  assert.doesNotMatch(output, new RegExp(STATUS_SCREEN_PRIVATE));
  assert.match(section(output, "Diagnostics"), /26|succeed|run|scope|reservation|lease/i);
});

test("forced color, NO_COLOR and pipe output have identical complete text", () => {
  for (const columns of [96, 80, 56, 40]) {
    const colored = renderInEnvironment({ scenario: "failed", columns, tty: true, color: "force" });
    const noColor = renderInEnvironment({ scenario: "failed", columns, tty: true, color: "none" });
    const piped = renderInEnvironment({ scenario: "failed", columns, tty: false });
    assert.match(colored, /\u001b\[/);
    assert.doesNotMatch(noColor, /\u001b/);
    assert.doesNotMatch(piped, /\u001b/);
    assert.equal(plain(colored), noColor);
    assert.equal(noColor, piped);
    assertWidth(colored, columns);
  }
});

test("explicit private logs remain bounded content and terminal controls cannot execute", () => {
  const report = statusScreenFixture();
  report.privacy = "private";
  report.logs = [{ name: "worker.jsonl", lines: [`invented private log \u001b[2Jpayload\u202e text\u001b]52;c;PRIVATE_CLIPBOARD\u0007`] }];
  const output = renderStatusText(report, { columns: 40, stream });
  assert.match(output, /PRIVATE LOGS|Private logs/);
  assert.match(output, /invented private log/);
  assert.doesNotMatch(output, /\u001b\[2J|\u202e|PRIVATE_CLIPBOARD/);
  assertWidth(output, 40);
});

test("status command uses the caller TTY width and preserves successful local-query exit code", async () => {
  let output = "";
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), { isTTY: true, columns: 40 });
  const context = createCommandContext({ root: "/tmp/invented-status-screen", cwd: "/tmp/invented-status-screen",
    now: () => STATUS_SCREEN_NOW, stdout });
  const code = await runStatusCommand({ db: "/tmp/invented-status-screen.sqlite", logDir: "/tmp/invented-status-screen-logs", format: "text" }, context,
    { readInstalledServiceConfig: () => ({ status: "installed" }), buildServiceStatusReport: () => rawStatusScreenFixture("failed") });
  assert.equal(code, 0);
  assertWidth(output, 40);
  assert.match(output, /Exocortex status/);
});

test("verified work can have zero reservations and an independent foreground command can outlive the service", () => {
  const zeroLocks = statusScreenFixture("syncing");
  assert.equal(zeroLocks.leases.total, 0);
  assert.match(section(plain(renderStatusText(zeroLocks, { stream })), "Health & current work"), /Current work.*Syncing/i);
  const foreground = section(text("foreground_stopped"), "Health & current work");
  assert.match(foreground, /Background.*Stopped/i);
  assert.match(foreground, /Current work.*Syncing.*foreground/i);
});

test("old incomplete history and an expired phase cannot replace the independently observed current state", () => {
  const old = text("old_instance_history", { detail: true });
  assert.match(section(old, "Health & current work"), /Current work.*Waiting/i);
  assert.match(section(old, "Background history"), /no completion record/i);
  const expired = text("expired_phase");
  assert.match(section(expired, "Health & current work"), /Current work.*Unconfirmed/i);
  assert.match(section(text("expired_phase", { detail: true }), "Background history"), /Latest success/i);
  assert.doesNotMatch(section(expired, "Health & current work"), /Current work\s+(?:Syncing|Waiting)/i);
});

test("out-of-range numeric list and detail timestamps remain readable unavailable evidence", () => {
  const report = statusScreenFixture("catching_up", { detail: true });
  report.sync.list_progress.oldest_cursor_ms = Number.MAX_SAFE_INTEGER;
  report.sync.details.oldest_pending_ms = Number.MAX_SAFE_INTEGER;
  report.detail.list_progress.oldest_cursor_ms = Number.MAX_SAFE_INTEGER;
  report.detail.details.oldest_pending_ms = Number.MAX_SAFE_INTEGER;
  for (const columns of [96, 40]) {
    const output = plain(renderStatusText(report, { columns, stream }));
    assertWidth(output, columns);
    assert.doesNotMatch(output, /Invalid Date|RangeError|9007199254740991/);
    assert.match(section(output, "Diagnostics"), /(?:checkpoint|cursor).*(?:time unavailable|unverified|invalid)/i);
    assert.match(section(output, "Diagnostics"), /(?:oldest|pending).*(?:time unavailable|unverified|invalid)/i);
  }
});

test("invalid later failure cannot replace valid older success or create a current failure warning", () => {
  const report = statusScreenFixture("healthy", { detail: true });
  const olderSuccess = new Date(STATUS_SCREEN_NOW - 60_000).toISOString();
  report.stability.last_success = { cycle: 3, at: olderSuccess, age_ms: 60_000 };
  report.worker.last_cycle = { cycle: 6, ok: false, at: new Date(STATUS_SCREEN_NOW + 60_000).toISOString(), age_ms: 0, timestamp_valid: false };
  report.worker.last_step = { cycle: 6, ok: false, name: "sent", at: null, age_ms: 0, timestamp_valid: false };
  report.worker.last_failure = { ...report.worker.last_step, type: "lark_im_worker_step" };
  const output = plain(renderStatusText(report, { columns: 80, stream }));
  const history = section(output, "Background history");
  assert.match(history, /Latest success.*1m.*ago/i);
  assert.match(history, /time unverified|invalid|unavailable/i);
  assert.doesNotMatch(history, /(?:Failed|Succeeded|Success|OK).*\(0s ago\)/i);
  assert.equal(hasSection(output, "Problems"), false, "an unplaceable failure cannot create a current problem");
  assertWidth(output, 80);
});

test("an unavailable direction count is never rewritten as zero sent messages", () => {
  const report = statusScreenFixture();
  report.sync.records.by_direction.find((row) => row.direction === "sent").count = null;
  const coverage = section(plain(renderStatusText(report, { columns: 80, stream })), "Messages & progress");
  assert.match(coverage, /(?:unavailable|unverified|not known) sent/i);
  assert.doesNotMatch(coverage, /\b0 sent\b/i);
  assert.match(coverage, /232 received.*7 unclassified/i);
});

test("an unavailable log event count is never rewritten as no observed events", () => {
  for (const detail of [false, true]) {
    const report = statusScreenFixture("healthy", { detail });
    report.stability.observed_events = null;
    report.stability.evidence = "unavailable";
    report.stability.cycles = { total: null, ok: null, failed: null };
    const output = plain(renderStatusText(report, { columns: 80, stream }));
    if (!detail) {
      assertDefaultNoiseAbsent(output);
      assert.equal(hasSection(output, "Problems"), false, "unbound missing log history is not a selected-database failure");
      continue;
    }
    const history = section(output, "Background history");
    assert.match(history, /(?:Worker log|Log coverage).*(?:unavailable|unverified|not known)/i);
    assert.doesNotMatch(history, /No events|0 succeeded|0 failed|0 total/i);
  }
});

test("failed database read keeps retained-run diagnostics unavailable instead of empty", () => {
  const report = statusScreenFixture("unavailable", { detail: true });
  assert.equal(report.detail, null);
  const diagnostics = section(plain(renderStatusText(report, { columns: 80, stream })), "Diagnostics");
  assert.match(diagnostics, /Retained sync runs.*(?:unavailable|could not|not known)/i);
  assert.doesNotMatch(diagnostics, /No records|No retained runs|0 runs/i);
});

test("recorded discovery completion never borrows a cursor update timestamp", () => {
  const report = statusScreenFixture("healthy", { detail: true });
  report.sync.discovery.complete = true;
  report.sync.discovery.cursor.completed_at = null;
  report.sync.discovery.cursor_updated_at = new Date(STATUS_SCREEN_NOW - 3 * 3_600_000).toISOString();
  const coverage = section(plain(renderStatusText(report, { columns: 96, stream })), "Messages & progress");
  assert.match(coverage, /Conversation list\s+Initial discovery complete.*(?:time unavailable|time unverified|time not recorded)/i);
  assert.doesNotMatch(coverage, /Conversation list\s+Initial discovery complete[^·]*· Today 09:00/);
});

test("missing or expired samples retain their state and move optional actions to detail", () => {
  for (const scenario of ["healthy", "expired"]) {
    const output = text(scenario);
    assert.equal(hasSection(output, "Problems"), false);
    assertDefaultNoiseAbsent(output);
    assert.match(section(output, "Messages & progress"), /Remote sample.*Not verified/i);
    assert.match(section(text(scenario, { detail: true }), "Diagnostics"), /Remote check.*check --live/i);
  }
});

test("all suggested follow-ups explicitly require the original database and log target without exposing paths", async () => {
  for (const detail of [false, true]) {
    for (const [db, logDir] of [["/tmp/INVENTED_PRIVATE_DB/alpha.sqlite", "/tmp/INVENTED_PRIVATE_LOG/alpha"],
      ["/tmp/INVENTED_PRIVATE_DB/beta.sqlite", "/tmp/INVENTED_PRIVATE_LOG/beta"]]) {
      const raw = rawStatusScreenFixture("failed");
      let output = "";
      const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }), { columns: 80 });
      const context = createCommandContext({ now: () => STATUS_SCREEN_NOW, stdout, provided: new Set(["--db", "--log-dir"]) });
      let observedTarget;
      await runStatusCommand({ db, logDir, format: "text", detail }, context, {
        readInstalledServiceConfig: () => ({ status: "installed" }),
        buildServiceStatusReport: (opts) => { observedTarget = { db: opts.db, logDir: opts.logDir }; return raw; },
      });
      assert.deepEqual(observedTarget, { db, logDir });
      const readable = compact(plain(output));
      if (detail) {
        const diagnostics = section(plain(output), "Diagnostics");
        assert.match(diagnostics, /Command targets All suggestions require the same --db and --log-dir values as this status invocation\./);
        assert.match(diagnostics, /npm run exo -- check/);
        assert.match(diagnostics, /npm run exo -- status --format json/);
      } else assertDefaultNoiseAbsent(plain(output));
      assert.doesNotMatch(readable, /INVENTED_PRIVATE_DB|INVENTED_PRIVATE_LOG|alpha\.sqlite|beta\.sqlite/);
      assertWidth(output, 80);
    }
  }
});


test("documented synthetic whole screens match the fixed UTC examples without trailing blank lines", () => {
  const document = readFileSync(new URL("../docs/status-screen-examples.md", import.meta.url), "utf8");
  assert.ok(document.endsWith("\n") && !document.endsWith("\n\n"));
  const examples = [...document.matchAll(/## ([a-z_]+)(-detail)?-(\d+)\.txt\n\n```text\n([\s\S]*?)```/g)];
  assert.equal(examples.length, 8);
  for (const [, scenario, detail, columns, expected] of examples) {
    assert.equal(renderInEnvironment({ scenario, detail: Boolean(detail), columns: Number(columns), zone: "UTC" }), expected, `${scenario}-${columns}`);
  }
});
