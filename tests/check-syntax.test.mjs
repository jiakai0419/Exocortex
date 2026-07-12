import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("syntax checker validates every requested file, including non-first files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-syntax-check-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const valid = join(dir, "01-valid.mjs");
  const invalid = join(dir, "02-invalid.mjs");
  writeFileSync(valid, "export const ok = true;\n");
  writeFileSync(invalid, "export const broken = ;\n");

  const result = spawnSync(process.execPath, ["scripts/check-syntax.mjs", valid, invalid], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /02-invalid\.mjs/);
});
