import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testFiles, verify } from "../src/development/verify.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "synthetic-verification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"));
  for (const name of ["z-last.test.mjs", "a-first.test.mjs", "python_bridge.test.mjs", "helper.mjs"]) writeFileSync(join(root, "tests", name), "");
  mkdirSync(join(root, "tests", "nested.test.mjs"));
  return root;
}

test("verify builds once, runs every glob test with concurrency four, and checks generated output last", (t) => {
  const root = fixture(t); const calls = [];
  const code = verify(root, {
    spawn: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; },
    generatedCheck: (project) => { assert.equal(project, root); calls.push("generated"); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.args || call), [
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    ["tools/check-syntax.mjs"],
    ["--test", "--test-concurrency=4", "tests/a-first.test.mjs", "tests/python_bridge.test.mjs", "tests/z-last.test.mjs"],
    "generated",
  ]);
});

test("standalone generated mode does not build or run unrelated steps", (t) => {
  const root = fixture(t); let checks = 0;
  assert.equal(verify(root, { generatedOnly: true, spawn: () => { throw new Error("unrequested build"); },
    generatedCheck: () => { checks += 1; return 7; } }), 7);
  assert.equal(checks, 1);
});

test("verify stops at first failure and never claims later checks ran", (t) => {
  const root = fixture(t); let calls = 0;
  assert.equal(verify(root, { spawn: () => ({ status: ++calls === 2 ? 2 : 0 }),
    generatedCheck: () => { throw new Error("must not run"); } }), 2);
  assert.equal(calls, 2);
});

test("verification discovery equals the retained complete npm test glob", () => {
  const root = new URL("..", import.meta.url);
  assert.deepEqual(testFiles(fileURLToPath(root)), readdirSync(new URL("tests", root)).filter((name) => name.endsWith(".test.mjs")).map((name) => `tests/${name}`).sort());
});
