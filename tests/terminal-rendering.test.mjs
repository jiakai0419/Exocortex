import assert from "node:assert/strict";
import test from "node:test";

import { kv, plain, statusBadge, table } from "../scripts/lib/terminal.mjs";

test("terminal rendering exposes plain text for styled status labels", () => {
  assert.equal(plain(statusBadge("catching_up")), "CATCHING UP");
  assert.equal(plain(statusBadge("needs_attention")), "NEEDS ATTENTION");
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
