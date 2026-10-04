import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkGeneratedFiles } from "./generated-check.mjs";

/** The same complete top-level test set as npm test's tests/*.test.mjs. */
export function testFiles(projectRoot) {
  return readdirSync(join(projectRoot, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `tests/${entry.name}`).sort();
}

/** One checkout build; the final independent clean build checks the output set. */
export function verify(projectRoot, { generatedOnly = false, spawn = spawnSync,
  generatedCheck = checkGeneratedFiles } = {}) {
  if (generatedOnly) return generatedCheck(projectRoot);
  const compiler = join(projectRoot, "node_modules/typescript/bin/tsc");
  const tests = testFiles(projectRoot);
  if (!tests.length) throw new Error("No tests matched tests/*.test.mjs");
  const steps = [
    [compiler, "-p", "tsconfig.build.json"],
    [compiler, "-p", "tsconfig.json"],
    ["tools/check-syntax.mjs"],
    ["--test", "--test-concurrency=4", ...tests],
  ];
  for (const args of steps) {
    const result = spawn(process.execPath, args, { cwd: projectRoot, stdio: "inherit" });
    if (result.error || result.signal || result.status !== 0) return result.status || 1;
  }
  return generatedCheck(projectRoot);
}
