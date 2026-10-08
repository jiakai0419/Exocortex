import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerEventTimestamp } from "../src/diagnostics/worker-event-time.mjs";

test("worker-event times accept valid calendar dates, fractions and offset equivalents", () => {
  for (const [value, canonical] of [
    ["2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z"],
    ["2036-02-29T00:00:00.1Z", "2036-02-29T00:00:00.100Z"],
    ["2400-02-29T00:00:00.12Z", "2400-02-29T00:00:00.120Z"],
    ["2037-03-02T08:00:00.123+08:00", "2037-03-02T00:00:00.123Z"],
    ["2037-03-01T20:00:00.123-04:00", "2037-03-02T00:00:00.123Z"],
  ]) assert.equal(parseWorkerEventTimestamp(value), Date.parse(canonical), value);
});

test("worker-event times reject normalized dates, invalid clocks and missing explicit timezones", () => {
  for (const value of [
    "1900-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2037-02-29T00:00:00Z",
    "2037-02-30T00:00:02.000Z", "2037-04-31T00:00:00Z",
    "2037-00-01T00:00:00Z", "2037-13-01T00:00:00Z", "2037-03-00T00:00:00Z",
    "2037-03-02T24:00:00Z", "2037-03-02T00:60:00Z", "2037-03-02T00:00:60Z",
    "2037-03-02T00:00:00+24:00", "2037-03-02T00:00:00+08:60",
    "2037-03-02T00:00:00", "2037-03-02", "2037-03-02T00:00:00.0000Z",
  ]) assert.equal(parseWorkerEventTimestamp(value), null, value);
});

test("worker-event times do not coerce values into timestamps", () => {
  for (const value of [null, undefined, 0, Date.parse("2037-03-02T00:00:00Z"), NaN, Infinity, true,
    new Date("2037-03-02T00:00:00Z"), { toString: () => "2037-03-02T00:00:00Z" }]) {
    assert.equal(parseWorkerEventTimestamp(value), null);
  }
});
