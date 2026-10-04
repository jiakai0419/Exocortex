import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  const result = spawnSync(process.execPath, ["tools/check-syntax.mjs", valid, invalid], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /02-invalid\.mjs/);
});

test("default syntax discovery includes bin, tools and ordinary source modules", (t) => {
  const root = mkdtempSync(join(tmpdir(), "synthetic-syntax-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["bin", "tools/probes", "src/development", "dist"]) mkdirSync(join(root, name), { recursive: true });
  copyFileSync("tools/check-syntax.mjs", join(root, "tools/check-syntax.mjs"));
  for (const file of ["bin/exocortex.mjs", "tools/probes/example.mjs", "src/development/module.mjs", "dist/value.js"]) {
    writeFileSync(join(root, file), "export const valid = true;\n");
  }
  const args = [join(root, "tools/check-syntax.mjs")];
  let result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Syntax checked 5 JavaScript files/);
  writeFileSync(join(root, "tools/probes/example.mjs"), "export const invalid = ;\n");
  result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /tools\/probes\/example.mjs/);
});
