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

const SECTIONS = ["Health & current work", "Coverage", "Attention", "Recent history"];
const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { isTTY: false, columns: 80 });
const text = (name = "healthy", options = {}) => plain(renderStatusText(statusScreenFixture(name, options), { columns: 96, stream, ...options }));
const compact = (value) => value.replace(/\s+/g, " ");

function section(output, heading) {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if ([...SECTIONS, "Diagnostics", "PRIVATE LOGS", "Private logs"].includes(lines[index].trim())) { end = index; break; }
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
  const positions = SECTIONS.map((heading) => output.indexOf(`\n${heading}\n`));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  assert.doesNotMatch(output, /Recent cycles \(up to|Statistics range:|Last event:|Last step:|Unfinished history:|\bUNKNOWN\b|lark_im_worker_|discover-reconcile/);
  assert.match(section(output, "Health & current work"), /Current work.*(?:Syncing|Synchronizing).*conversation/i);
  assert.match(section(text("syncing", { detail: true }), "Recent history"), /(?:round|completion).*record|record.*(?:round|completion)/i);
  assert.match(section(output, "Coverage"), /293.*54.*232.*7/s);
  assert.match(section(output, "Coverage"), /unclassified|unknown direction/i);
});

for (const name of STATUS_SCREEN_SCENARIOS) {
  for (const columns of [96, 80, 56, 40]) {
    for (const detail of [false, true]) {
      test(`whole ${name}${detail ? " detail" : ""} screen fits ${columns} columns without dropping sections or private values`, () => {
        const report = statusScreenFixture(name, { detail });
        const before = structuredClone(report);
        const output = plain(renderStatusText(report, { columns, stream }));
        assertWidth(output, columns);
        for (const heading of [...SECTIONS, ...(detail ? ["Diagnostics"] : [])]) assert.ok(output.split("\n").includes(heading), heading);
        assert.doesNotMatch(output, new RegExp(STATUS_SCREEN_PRIVATE));
        assert.doesNotMatch(output, /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
        assert.deepEqual(report, before, "rendering must not mutate the report");
        assert.match(output, /\n$/);
      });
    }
  }
}

test("catch-up retains independent discovery, full-content cursors, detail debt and every restriction", () => {
  const output = text("catching_up", { columns: 40 });
  const coverage = section(output, "Coverage");
  assert.match(coverage, /(?:discover|conversation list).*?(?:remaining|more|progress|incomplete|not complete)/i);
  assert.match(coverage, /9.*(?:cursor|successful)/i);
  assert.match(coverage, /6 pending.*2 due/i);
  assert.match(coverage, /71101/);
  assert.match(coverage, /71102/);
  assert.match(section(output, "Health & current work"), /catching up/i);
  assert.match(section(output, "Attention"), /detail|content|retry/i);
  assert.match(section(output, "Attention"), /restrict|access|excluded/i);
  assert.doesNotMatch(output, /discover-catchup|received-fair|bot_user_out_of_chat|restricted_mode/);
});

test("healthy local progress and waiting never claim complete remote freshness", () => {
  const output = text();
  const current = section(output, "Health & current work");
  assert.match(current, /Current work.*Waiting/i);
  assert.match(current, /Background.*Running/i);
  assert.match(section(output, "Coverage"), /Remote sample.*(?:not verified|unverified|no cached)/i);
  assert.match(section(output, "Attention"), /check --live/);
  assert.doesNotMatch(output, /all remote messages|fully up.to.date|real.time coverage|current work.*received-fair/i);
});

test("empty database retains missing initial evidence instead of implying complete coverage", () => {
  const output = text("empty");
  const coverage = section(output, "Coverage");
  assert.match(coverage, /Stored messages.*0 total/i);
  assert.match(coverage, /(?:discovery|conversation list).*(?:not started|not complete|not recorded|no completion|not yet established)/i);
  assert.match(coverage, /1.*without.*success/i);
  assert.doesNotMatch(section(output, "Health & current work"), /Local health\s+OK\b/);
  assert.match(section(output, "Recent history"), /no.*(?:event|observation|round)|(?:event|observation|round).*not available/i);
});

test("stopped service and unavailable inspection remain different conclusions", () => {
  const stopped = section(text("stopped"), "Health & current work");
  const unavailable = section(text("unavailable"), "Health & current work");
  assert.match(stopped, /Background.*(?:Stopped|not loaded)/i);
  assert.match(stopped, /Current work.*(?:Stopped|no current.*sync)/i);
  assert.match(unavailable, /Background.*(?:unavailable|not verified|cannot|unconfirmed|could not)/i);
  assert.doesNotMatch(unavailable, /Background\s+Stopped/i);
  assert.match(section(text("unavailable"), "Recent history"), /Database failures.*(?:unavailable|could not|cannot)/i);
  assert.doesNotMatch(section(text("unavailable"), "Recent history"), /Database failures\s+0\b/);
});

test("a legacy database has unavailable detail and list evidence rather than zero debt", () => {
  const coverage = section(text("legacy"), "Coverage");
  assert.match(coverage, /Message (?:details|content).*(?:legacy|unavailable in this database version)/i);
  assert.match(coverage, /Message lists.*(?:legacy|unavailable in this database version)/i);
  assert.doesNotMatch(coverage, /Message (?:details|content)\s+0 pending/i);
});

test("failures preserve all categories, numeric counts and abnormal reservations", () => {
  const output = text("failed", { columns: 40 });
  const history = section(output, "Recent history");
  assert.match(section(output, "Health & current work"), /(?:PROBLEM|attention|failed)/i);
  assert.match(history, /3.*succeed.*1.*fail.*4.*total/i);
  assert.match(history, /15.*(?:failed|failure)/i);
  for (const pattern of [/permission|access denied/i, /timeout|timed out/i, /rate limit/i, /service unavailable/i, /unclassified|unknown failure/i]) assert.match(history, pattern);
  assert.match(section(output, "Attention"), /reservation|lease|lock/i);
  assert.match(output, /expired/i);
  assert.match(output, /future/i);
});

test("two-hour worker observations and database 24-hour failures have separate window labels", () => {
  const output = renderInEnvironment({ scenario: "failed", columns: 96, detail: true });
  const history = section(output, "Recent history");
  assert.match(history, /Worker log|Log window|Worker window/i);
  assert.match(history, /10:00.*11:59/);
  assert.match(history, /Database (?:window|failure window)/i);
  assert.match(history, /2032-02-03 12:00.*(?:Today |2032-02-04 )?12:00/);
  assert.match(history, /partial|earlier.*unavailable|does not cover/i);
  assert.match(history, /retained|retention/i);
});

test("old-only history is dated, window statistics stay empty, and current work stays unconfirmed", () => {
  const output = renderInEnvironment({ scenario: "old_history", detail: true });
  assert.match(section(output, "Health & current work"), /Current work.*(?:unconfirmed|not verified|unavailable|cannot)/i);
  assert.doesNotMatch(section(output, "Health & current work"), /Current work\s+(?:Syncing|Waiting)/i);
  const history = section(output, "Recent history");
  assert.match(history, /2032-02-02/);
  assert.match(history, /0.*(?:succeed|round)|no.*(?:completion|round)/i);
  assert.match(history, /(?:need|fewer than|at least).*2|two.*success/i);
});

test("future or malformed history is not displayed as a success just now", () => {
  const output = text("invalid_history");
  const history = section(output, "Recent history");
  assert.match(history, /invalid|unavailable|unverified|not valid|unreliable/i);
  assert.doesNotMatch(history, /(?:Succeeded|Success|OK).*\(0s ago\)/i);
  assert.doesNotMatch(output, /synthetic-invalid-time/);
});

test("log truncation is disclosed without claiming continuous coverage", () => {
  const history = section(text("truncated"), "Recent history");
  assert.match(history, /truncat|clipped|tail limit/i);
  assert.doesNotMatch(history, /(?:continuous|complete) (?:24h|24.hour|log coverage)/i);
});

test("sample window, check time and validity are distinct from worker statistics", () => {
  const output = renderInEnvironment({ scenario: "sampled", columns: 96 });
  const coverage = section(output, "Coverage");
  assert.match(coverage, /11.*(?:message|sample)/i);
  assert.match(coverage, /11:50.*11:59/);
  assert.match(coverage, /11:59:30/);
  assert.match(coverage, /12:04:00/);
  assert.match(coverage, /(?:identity|principal).*(?:unverified|unknown|not verified)/i);
  assert.match(section(text("behind"), "Coverage"), /Remote sample.*(?:behind|missing|delayed)/i);
  assert.match(section(text("expired"), "Coverage"), /Remote sample.*expired/i);
});

test("detail mode adds readable diagnostics and retains the public projection", () => {
  const report = statusScreenFixture("failed", { detail: true });
  const output = plain(renderStatusText(report, { columns: 40, stream }));
  assertWidth(output, 40);
  assert.ok(output.indexOf("\nDiagnostics\n") > output.indexOf("\nRecent history\n"));
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
  assert.match(section(old, "Recent history"), /no completion record/i);
  const expired = text("expired_phase");
  assert.match(section(expired, "Health & current work"), /Current work.*Unconfirmed/i);
  assert.match(section(expired, "Recent history"), /Latest success/i);
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
    assert.match(section(output, "Coverage"), /(?:checkpoint|cursor).*(?:time unavailable|unverified|invalid)/i);
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
  const history = section(output, "Recent history");
  assert.match(history, /Latest success.*1m.*ago/i);
  assert.match(history, /time unverified|invalid|unavailable/i);
  assert.doesNotMatch(history, /(?:Failed|Succeeded|Success|OK).*\(0s ago\)/i);
  assert.doesNotMatch(section(output, "Attention"), /Logged failure|recorded background round failed/i);
  assertWidth(output, 80);
});

test("an unavailable direction count is never rewritten as zero sent messages", () => {
  const report = statusScreenFixture();
  report.sync.records.by_direction.find((row) => row.direction === "sent").count = null;
  const coverage = section(plain(renderStatusText(report, { columns: 80, stream })), "Coverage");
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
    const history = section(plain(renderStatusText(report, { columns: 80, stream })), "Recent history");
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
  const coverage = section(plain(renderStatusText(report, { columns: 96, stream })), "Coverage");
  assert.match(coverage, /Conversation list\s+Initial discovery complete.*(?:time unavailable|time unverified|time not recorded)/i);
  assert.doesNotMatch(coverage, /Conversation list\s+Initial discovery complete[^·]*· Today 09:00/);
});

test("missing or expired samples offer an optional check without inventing required action", () => {
  for (const scenario of ["healthy", "expired"]) {
    const output = text(scenario);
    const attention = section(output, "Attention");
    assert.match(attention, /Action\s+No required action identified/i);
    assert.match(attention, /Optional sample.*check --live/i);
    assert.doesNotMatch(attention, /Remote freshness|sample is required|must.*sample/i);
    assert.match(section(output, "Coverage"), /Remote sample.*Not verified/i);
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
      assert.match(readable, /Command targets All suggestions require the same --db and --log-dir values as this status invocation\./);
      assert.match(readable, /npm run exo -- check/);
      assert.match(readable, /npm run exo -- status --detail/);
      if (detail) assert.match(readable, /npm run exo -- status --format json/);
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
