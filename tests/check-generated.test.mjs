import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGeneratedFiles, compareGeneratedTrees } from "../scripts/check-generated.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compilerPath = join(root, "node_modules/typescript/bin/tsc");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-generated-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/invented.ts"), 'export const fictionalValue: string = "invented";\n');
  writeFileSync(join(dir, "tsconfig.build.json"), JSON.stringify({
    compilerOptions: { target: "ES2024", module: "ESNext", declaration: true, types: [], outDir: "dist", rootDir: "src" },
    include: ["src/**/*.ts"],
  }));
  const build = spawnSync(process.execPath, [compilerPath, "-p", join(dir, "tsconfig.build.json")], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  return dir;
}

function check(dir) {
  let output = "";
  const stream = { write: (text) => { output += text; } };
  return { code: checkGeneratedFiles(dir, { compilerPath, stdout: stream, stderr: stream }), output };
}

test("clean generated check accepts matching output without modifying dist", (t) => {
  const dir = fixture(t);
  const before = readdirSync(join(dir, "dist")).map((name) => [name, readFileSync(join(dir, "dist", name))]);
  assert.equal(check(dir).code, 0);
  assert.deepEqual(before, readdirSync(join(dir, "dist")).map((name) => [name, readFileSync(join(dir, "dist", name))]));
});

test("orphan generated files fail independently of Git status", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "dist/removed-source.js"), 'export const obsolete = "synthetic";\n');
  const result = check(dir);
  assert.equal(result.code, 1);
  assert.match(result.output, /unexpected dist\/removed-source\.js/);
  assert.equal(readFileSync(join(dir, "dist/removed-source.js"), "utf8"), 'export const obsolete = "synthetic";\n');
});

test("clean generated check detects stale bytes and missing declarations without repairing them", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "dist/invented.js"), 'export const fictionalValue = "stale";\n');
  rmSync(join(dir, "dist/invented.d.ts"));
  const result = check(dir);
  assert.equal(result.code, 1);
  assert.match(result.output, /different dist\/invented\.js/);
  assert.match(result.output, /missing dist\/invented\.d\.ts/);
  assert.match(readFileSync(join(dir, "dist/invented.js"), "utf8"), /stale/);
});

test("compiler failure cannot validate old output", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "src/invented.ts"), 'export const fictionalValue: string = 42;\n');
  const result = check(dir);
  assert.equal(result.code, 1);
  assert.match(result.output, /Clean generated-file build failed/);
});

test("generated comparison rejects symlinks and checks nested file sets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-generated-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const expected = join(dir, "expected"); const actual = join(dir, "actual");
  for (const path of [expected, actual]) mkdirSync(join(path, "nested"), { recursive: true });
  writeFileSync(join(expected, "nested/test.js"), "invented\n");
  symlinkSync(join(expected, "nested/test.js"), join(actual, "nested/test.js"));
  assert.deepEqual(compareGeneratedTrees(expected, actual), ["different dist/nested/test.js"]);
  rmSync(join(actual, "nested/test.js"));
  writeFileSync(join(actual, "unexpected.map"), "{}");
  assert.deepEqual(compareGeneratedTrees(expected, actual), ["missing dist/nested/test.js", "unexpected dist/unexpected.map"]);
});
