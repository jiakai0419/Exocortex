import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkGeneratedFiles } from "../src/development/generated-check.mjs";
import { testFiles, verify } from "../src/development/verify.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "synthetic-verification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests"));
  for (const name of ["z-last.test.mjs", "a-first.test.mjs", "python_bridge.test.mjs", "helper.mjs"]) writeFileSync(join(root, "tests", name), "");
  mkdirSync(join(root, "tests", "nested.test.mjs"));
  return root;
}

test("verify checks existing generated output before one build and every glob test with concurrency four", (t) => {
  const root = fixture(t); const calls = [];
  const code = verify(root, {
    spawn: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; },
    generatedCheck: (project) => { assert.equal(project, root); calls.push("generated"); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.map((call) => call.args || call), [
    "generated",
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    ["tools/check-syntax.mjs"],
    ["--test", "--test-concurrency=4", "tests/a-first.test.mjs", "tests/python_bridge.test.mjs", "tests/z-last.test.mjs"],
  ]);
});

test("standalone generated mode does not build or run unrelated steps", (t) => {
  const root = fixture(t); let checks = 0;
  assert.equal(verify(root, { generatedOnly: true, spawn: () => { throw new Error("unrequested build"); },
    generatedCheck: () => { checks += 1; return 7; } }), 7);
  assert.equal(checks, 1);
});

test("verify stops at first failure and never claims later checks ran", (t) => {
  const root = fixture(t); let calls = 0; let checks = 0;
  assert.equal(verify(root, { spawn: () => ({ status: ++calls === 2 ? 2 : 0 }),
    generatedCheck: () => { checks++; return 0; } }), 2);
  assert.equal(calls, 2);
  assert.equal(checks, 1);
});

function generatedFixture(t) {
  const root = fixture(t);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "src/invented.ts"), 'export const fictionalValue: string = "invented";\n');
  writeFileSync(join(root, "tools/check-syntax.mjs"), "// Synthetic syntax step has no work.\n");
  const config = {
    compilerOptions: { target: "ES2024", module: "ESNext", declaration: true, types: [], outDir: "dist", rootDir: "src" },
    include: ["src/**/*.ts"],
  };
  writeFileSync(join(root, "tsconfig.build.json"), JSON.stringify(config));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ ...config,
    compilerOptions: { ...config.compilerOptions, noEmit: true } }));
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"));
  const build = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
    { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stdout + build.stderr);
  return root;
}

for (const kind of ["stale bytes", "missing declaration", "orphan output"]) {
  test(`verify rejects real ${kind} before any checkout build and preserves dist`, (t) => {
    const root = generatedFixture(t);
    const dist = join(root, "dist");
    if (kind === "stale bytes") writeFileSync(join(dist, "invented.js"), 'export const fictionalValue = "stale";\n');
    if (kind === "missing declaration") rmSync(join(dist, "invented.d.ts"));
    if (kind === "orphan output") writeFileSync(join(dist, "obsolete.js"), 'export const obsolete = "synthetic";\n');
    const snapshot = () => readdirSync(dist).sort().map(name => [name, readFileSync(join(dist, name))]);
    const before = snapshot();
    const calls = [];
    let output = "";
    const stream = { write: text => { output += text; } };
    const code = verify(root, {
      // Record actual executions: a misplaced build would really repair dist.
      spawn: (command, args, options) => {
        calls.push(args);
        return spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8", timeout: 30_000 });
      },
      generatedCheck: project => checkGeneratedFiles(project, { stdout: stream, stderr: stream }),
    });
    assert.equal(code, 1, output);
    assert.match(output, kind === "stale bytes" ? /different dist\/invented\.js/
      : kind === "missing declaration" ? /missing dist\/invented\.d\.ts/ : /unexpected dist\/obsolete\.js/);
    assert.deepEqual(calls, [], "invalid committed output must stop before the checkout build");
    assert.deepEqual(snapshot(), before, "verify must not repair or remove the invalid generated output");
  });
}

test("verification discovery equals the retained complete npm test glob", () => {
  const root = new URL("..", import.meta.url);
  assert.deepEqual(testFiles(fileURLToPath(root)), readdirSync(new URL("tests", root)).filter((name) => name.endsWith(".test.mjs")).map((name) => `tests/${name}`).sort());
});
