import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readFileTail,
  readRecentWorkerEvents,
  summarizeWorkerStability,
} from "../src/diagnostics/lark-im-service-report.mjs";

// Every timestamp and event in this file is constructed for these tests.
const NOW = Date.parse("2031-02-06T15:20:00.000Z");
const MINUTE = 60_000;
const WINDOW = 120 * MINUTE;
const iso = (offset) => new Date(NOW + offset).toISOString();
const cycle = (offset, ok = true, number = 1) => ({
  type: "lark_im_worker_cycle", cycle: number, ok, at: iso(offset),
});
const line = (event) => `${JSON.stringify(event)}\n`;

function logDirectory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "synthetic-worker-stability-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("no retained events do not invent a full-window success gap or observation origin", () => {
  const result = summarizeWorkerStability([], NOW, WINDOW);
  assert.equal(result.longest_between_successes_ms, null);
  assert.equal(result.last_success, null);
  assert.equal(result.observed_events, 0);
  assert.deepEqual(result.observation, {
    first_event_at: null,
    last_event_at: null,
    range_started_at: null,
    range_ended_at: null,
    window_start_reached: false,
    tail_truncated: null,
  });
});

test("failed cycles alone have no measured gap between successes", () => {
  const result = summarizeWorkerStability([cycle(-90 * MINUTE, false), cycle(-MINUTE, false, 2)], NOW, WINDOW);
  assert.equal(result.longest_between_successes_ms, null);
  assert.equal(result.last_success, null);
  assert.deepEqual(result.cycles, { total: 2, ok: 0, failed: 2 });
});

test("a single success preserves its age without treating either window edge as another success", () => {
  const result = summarizeWorkerStability([cycle(-37 * MINUTE, true, 7)], NOW, WINDOW);
  assert.equal(result.longest_between_successes_ms, null);
  assert.deepEqual(result.last_success, { cycle: 7, at: iso(-37 * MINUTE), age_ms: 37 * MINUTE });
});

test("adjacent successful cycles retain exact milliseconds despite much larger leading and trailing edges", () => {
  const first = -90 * MINUTE;
  const result = summarizeWorkerStability([cycle(first), cycle(first + 110_813, true, 2)], NOW, WINDOW);
  assert.equal(result.longest_between_successes_ms, 110_813);
  assert.equal(result.last_success.age_ms, 90 * MINUTE - 110_813);
  assert.equal(result.window_started_at, iso(-WINDOW));
});

test("out-of-order events are sorted for adjacent gaps and equal timestamps add zero", () => {
  const result = summarizeWorkerStability([
    cycle(-20 * MINUTE, true, 4),
    cycle(-47 * MINUTE, true, 2),
    cycle(-90 * MINUTE, true, 1),
    cycle(-47 * MINUTE, true, 3),
    cycle(-30 * MINUTE, false, 5),
  ], NOW, WINDOW);
  assert.equal(result.longest_between_successes_ms, 43 * MINUTE);
  assert.equal(result.last_success.cycle, 4);
  assert.deepEqual(result.cycles, { total: 5, ok: 4, failed: 1 });
  assert.equal(summarizeWorkerStability([cycle(-1000), cycle(-1000, true, 2)], NOW, WINDOW).longest_between_successes_ms, 0);
});

test("the requested window includes both exact bounds and excludes successes immediately outside", () => {
  const result = summarizeWorkerStability([
    cycle(-WINDOW - 1, true, 1),
    cycle(-WINDOW, true, 2),
    cycle(0, true, 3),
    cycle(1, true, 4),
  ], NOW, WINDOW);
  assert.deepEqual(result.cycles, { total: 2, ok: 2, failed: 0 });
  assert.equal(result.longest_between_successes_ms, WINDOW);
  assert.deepEqual(result.last_success, { cycle: 3, at: iso(0), age_ms: 0 });
  assert.equal(result.observation.last_event_at, iso(0));
});

test("a success before the window cannot pair with the only success inside it", () => {
  const result = summarizeWorkerStability([cycle(-WINDOW - 1), cycle(-5000, true, 2)], NOW, WINDOW);
  assert.equal(result.cycles.ok, 1);
  assert.equal(result.longest_between_successes_ms, null);
  assert.equal(result.last_success.cycle, 2);
});

test("invalid timestamps, future events, and unrelated JSON cannot establish observation evidence", () => {
  const result = summarizeWorkerStability([
    null, [], 0, "synthetic noise",
    { type: "lark_im_worker_cycle", ok: true, at: "invalid-synthetic-time" },
    { type: "lark_im_worker_step", name: "synthetic", ok: false },
    { type: "unrelated_event", at: iso(-WINDOW) },
    cycle(1),
  ], NOW, WINDOW);
  assert.equal(result.observed_events, 0);
  assert.equal(result.longest_between_successes_ms, null);
  assert.equal(result.last_success, null);
  assert.equal(result.observation.first_event_at, null);
  assert.equal(result.observation.range_ended_at, null);
  assert.deepEqual(result.failures.by_step, []);
});

test("the earliest retained worker step sets the range even before the first successful cycle", () => {
  const events = [
    cycle(-80 * MINUTE),
    { type: "lark_im_worker_scheduler", at: iso(-100 * MINUTE) },
    { type: "lark_im_worker_step", name: "synthetic-step", ok: false, finished_at: iso(-110 * MINUTE) },
    cycle(-70 * MINUTE, true, 2),
  ];
  const result = summarizeWorkerStability(events, NOW, WINDOW, { truncated: false });
  assert.equal(result.observation.first_event_at, iso(-110 * MINUTE));
  assert.equal(result.observation.range_started_at, iso(-110 * MINUTE));
  assert.equal(result.observation.last_event_at, iso(-70 * MINUTE));
  assert.equal(result.observation.range_ended_at, iso(0));
  assert.equal(result.observation.window_start_reached, false);
  assert.equal(result.observation.tail_truncated, false);
  assert.equal(result.observed_events, 4);
  assert.deepEqual(result.failures.by_step, [{ name: "synthetic-step", count: 1 }]);
});

test("pre-window retained evidence clips the selection range without rewriting its real first timestamp", () => {
  const result = summarizeWorkerStability([
    { type: "lark_im_worker_step", started_at: iso(-WINDOW - 7000), ok: true },
    cycle(-1000),
  ], NOW, WINDOW, { truncated: true });
  assert.equal(result.observation.first_event_at, iso(-WINDOW - 7000));
  assert.equal(result.observation.range_started_at, iso(-WINDOW));
  assert.equal(result.observation.window_start_reached, true);
  assert.equal(result.observation.tail_truncated, true);
  assert.equal(result.observed_events, 1);
});

test("only older retained successes do not become a last success in the requested window", () => {
  const result = summarizeWorkerStability([cycle(-WINDOW - 8000), cycle(-WINDOW - 2000, true, 2)], NOW, WINDOW);
  assert.equal(result.observed_events, 0);
  assert.equal(result.last_success, null);
  assert.equal(result.longest_between_successes_ms, null);
  assert.equal(result.observation.last_event_at, iso(-WINDOW - 2000));
  assert.equal(result.observation.range_started_at, iso(-WINDOW));
});

test("missing worker logs are distinct from an existing empty current log", (t) => {
  const dir = logDirectory(t);
  const missing = readRecentWorkerEvents(dir);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.events, []);
  fs.writeFileSync(join(dir, "worker.jsonl"), "");
  const empty = readRecentWorkerEvents(dir);
  assert.equal(empty.exists, true);
  assert.equal(empty.truncated, false);
  assert.deepEqual(empty.events, []);
});

test("read limits must be positive safe integers", (t) => {
  const dir = logDirectory(t);
  fs.writeFileSync(join(dir, "worker.jsonl"), line(cycle(-1000)));
  for (const limits of [{ maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: Infinity }, { maxEvents: -1 }, { maxEvents: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => readRecentWorkerEvents(dir, limits), /positive integers/);
  }
});

test("count-capped current log evidence reports clipping and retains only the bounded tail", (t) => {
  const dir = logDirectory(t);
  const events = [cycle(-5000, true, 1), cycle(-3000, true, 2), cycle(-1000, true, 3)];
  fs.writeFileSync(join(dir, "worker.jsonl"), events.map(line).join(""));
  const result = readRecentWorkerEvents(dir, { maxEvents: 2 });
  assert.deepEqual(result.events, events.slice(1));
  assert.equal(result.truncated, true);
  assert.equal(summarizeWorkerStability(result.events, NOW, WINDOW, result).observation.first_event_at, iso(-3000));
});

test("byte-capped current log evidence discards the cut first line and reports clipping", (t) => {
  const dir = logDirectory(t);
  const events = [cycle(-7000, true, 1), cycle(-5000, true, 2), cycle(-3000, true, 3), cycle(-1000, true, 4)];
  const lines = events.map(line);
  const maxBytes = Buffer.byteLength(lines[2] + lines[3]) + Math.floor(Buffer.byteLength(lines[1]) / 2);
  fs.writeFileSync(join(dir, "worker.jsonl"), lines.join(""));
  const result = readRecentWorkerEvents(dir, { maxBytes });
  assert.deepEqual(result.events, events.slice(2));
  assert.equal(result.truncated, true);
});

test("a byte tail without any newline cannot promote a partial JSON fragment to an event", (t) => {
  const dir = logDirectory(t);
  const path = join(dir, "worker.jsonl");
  fs.writeFileSync(path, JSON.stringify(cycle(-1000)));
  const result = readRecentWorkerEvents(dir, { maxBytes: 20 });
  assert.deepEqual(result.events, []);
  assert.equal(result.truncated, true);
  assert.equal(readFileTail(path, 20), "");
});

test("malformed and partial lines do not create successes or observation timestamps", (t) => {
  const dir = logDirectory(t);
  const valid = cycle(-1000);
  fs.writeFileSync(join(dir, "worker.jsonl"), `synthetic non-json line\n${line(valid)}{"type":"lark_im_worker_cycle",`);
  const result = readRecentWorkerEvents(dir);
  assert.deepEqual(result.events, [valid]);
  const stability = summarizeWorkerStability(result.events, NOW, WINDOW, result);
  assert.equal(stability.cycles.ok, 1);
  assert.equal(stability.longest_between_successes_ms, null);
  assert.equal(stability.observation.first_event_at, valid.at);
});

test("rotated files do not silently extend the current log observation range", (t) => {
  const dir = logDirectory(t);
  const current = cycle(-2000, true, 3);
  fs.writeFileSync(join(dir, "worker.jsonl.1"), line(cycle(-WINDOW)) + line(cycle(-60 * MINUTE, true, 2)));
  fs.writeFileSync(join(dir, "worker.jsonl"), line(current));
  const result = readRecentWorkerEvents(dir);
  assert.deepEqual(result.events, [current]);
  assert.equal(result.truncated, false);
  const stability = summarizeWorkerStability(result.events, NOW, WINDOW, result);
  assert.equal(stability.observation.first_event_at, current.at);
  assert.equal(stability.observation.window_start_reached, false);
  assert.equal(stability.longest_between_successes_ms, null);
});

test("rotation after open keeps file size and event bytes on the same opened file", (t) => {
  const dir = logDirectory(t);
  const path = join(dir, "worker.jsonl");
  const openedEvents = [cycle(-6000, true, 1), cycle(-4000, true, 2)];
  const replacement = cycle(-1000, false, 3);
  fs.writeFileSync(path, openedEvents.map(line).join(""));
  const originalFstat = fs.fstatSync;
  let rotated = false;
  const patched = t.mock.method(fs, "fstatSync", (fd) => {
    const stat = originalFstat(fd);
    fs.renameSync(path, `${path}.1`);
    fs.writeFileSync(path, line(replacement));
    rotated = true;
    return stat;
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = readRecentWorkerEvents(dir);
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(rotated, true);
  assert.deepEqual(result.events, openedEvents);
  assert.equal(result.truncated, false);
  assert.deepEqual(readRecentWorkerEvents(dir).events, [replacement]);
});

test("a shortened file read marks incomplete byte evidence and never parses zero-filled bytes", (t) => {
  const dir = logDirectory(t);
  const path = join(dir, "worker.jsonl");
  const first = cycle(-4000, true, 1);
  fs.writeFileSync(path, line(first) + line(cycle(-2000, true, 2)));
  const originalRead = fs.readSync;
  const patched = t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    fs.truncateSync(path, Buffer.byteLength(line(first)));
    return originalRead(fd, buffer, offset, length, position);
  });
  syncBuiltinESMExports();
  let result;
  try {
    result = readRecentWorkerEvents(dir);
  } finally {
    patched.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(result.events, [first]);
  assert.equal(result.truncated, true);
  assert.equal(summarizeWorkerStability(result.events, NOW, WINDOW, result).longest_between_successes_ms, null);
});
