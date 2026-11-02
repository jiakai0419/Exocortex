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

/** Check the existing output before one checkout build can repair it. */
export function verify(projectRoot, { generatedOnly = false, spawn = spawnSync,
  generatedCheck = checkGeneratedFiles } = {}) {
  if (generatedOnly) return generatedCheck(projectRoot);
  const compiler = join(projectRoot, "node_modules/typescript/bin/tsc");
  const tests = testFiles(projectRoot);
  if (!tests.length) throw new Error("No tests matched tests/*.test.mjs");
  const generatedStatus = generatedCheck(projectRoot);
  if (generatedStatus !== 0) return generatedStatus;
  // One timing-sensitive real-process file runs without competing suite files.
  // Both phases belong to this invocation; failures never trigger a retry.
  const serial = tests.filter((file) => file === "tests/resource-worker-idle.test.mjs");
  const parallel = tests.filter((file) => file !== "tests/resource-worker-idle.test.mjs");
  const steps = [
    [compiler, "-p", "tsconfig.build.json"],
    [compiler, "-p", "tsconfig.json"],
    ["tools/check-syntax.mjs"],
    ...(serial.length ? [["--test", "--test-concurrency=1", ...serial]] : []),
    ...(parallel.length ? [["--test", "--test-concurrency=4", ...parallel]] : []),
  ];
  for (const args of steps) {
    const result = spawn(process.execPath, args, { cwd: projectRoot, stdio: "inherit" });
    if (result.error || result.signal || result.status !== 0) return result.status || 1;
  }
  return 0;
}
