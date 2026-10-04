import assert from "node:assert/strict";
import test from "node:test";

import {
  compact,
  kv,
  list,
  plain,
  sanitizeTerminalText,
  statusBadge,
  table,
} from "../dist/terminal/index.js";

test("terminal rendering exposes plain text for styled status labels", () => {
  assert.equal(plain(statusBadge("catching_up")), "CATCHING UP");
  assert.equal(plain(statusBadge("needs_attention")), "NEEDS ATTENTION");
  assert.equal(plain(statusBadge("problem")), "PROBLEM");
  assert.equal(plain(statusBadge("running")), "RUNNING");
  assert.equal(plain(statusBadge("stopped")), "STOPPED");
  assert.equal(plain(statusBadge("idle")), "IDLE");
  assert.equal(plain(statusBadge("verified")), "VERIFIED");
  assert.equal(plain(statusBadge("behind")), "BEHIND");
  assert.equal(plain(statusBadge("ok")), "OK");
});

test("terminal kv and table helpers produce aligned readable text", () => {
  assert.match(kv([["Health", "ok"], ["Records", "27 total"]]), /Health\s+ok/);
  assert.match(
    table([{ kind: "received", count: 22 }], [
      { header: "Kind", key: "kind" },
      { header: "Count", key: "count" },
    ]),
    /Kind\s+Count\nreceived\s+22/,
  );
});

test("terminal rendering removes ANSI, CSI, OSC, C0/C1, and bidi controls", () => {
  const hostile = [
    "before",
    "\u001b[31mred\u001b[0m",
    "\u009b2Jc1-csi",
    "\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007",
    "\u001b]52;c;Y2xpcGJvYXJk\u0007",
    "line\rreturn\nnewline\ttab\u0000nul\u0085c1",
    "left\u202Eright\u2066isolate\u2069",
  ].join(" ");

  const safe = sanitizeTerminalText(hostile);
  const rendered = `${kv([["Remote", hostile]])}\n${table([{ value: hostile }], [{ header: "Value", key: "value" }])}\n${list([hostile])}\n${compact(hostile)}`;

  for (const output of [safe, rendered]) {
    assert.doesNotMatch(output, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
    assert.doesNotMatch(output, /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    assert.doesNotMatch(output, /Y2xpcGJvYXJk|https:\/\/example\.invalid/);
  }
  assert.match(safe, /before/);
  assert.match(safe, /red/);
  assert.match(safe, /link/);
});
