import assert from "node:assert/strict";
import test from "node:test";

import { plain as shimPlain } from "../scripts/lib/terminal.mjs";
import { kv, plain, statusBadge, table } from "../dist/terminal/index.js";

test("terminal rendering exposes plain text for styled status labels", () => {
  assert.equal(plain(statusBadge("catching_up")), "CATCHING UP");
  assert.equal(plain(statusBadge("needs_attention")), "NEEDS ATTENTION");
  assert.equal(plain(statusBadge("problem")), "PROBLEM");
  assert.equal(plain(statusBadge("running")), "RUNNING");
  assert.equal(plain(statusBadge("stopped")), "STOPPED");
  assert.equal(plain(statusBadge("idle")), "IDLE");
  assert.equal(plain(statusBadge("verified")), "VERIFIED");
  assert.equal(plain(statusBadge("behind")), "BEHIND");
  assert.equal(shimPlain(statusBadge("ok")), "OK");
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
