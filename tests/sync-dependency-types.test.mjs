import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

test("sync dependency contracts accept partial overrides and reject invalid injections", (t) => {
  const temporary = mkdtempSync(join(tmpdir(), "exocortex-dependency-types-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const imports = `import { createSyncRunner } from ${JSON.stringify(join(root, "src/adapters/lark-im/sync-runner.mjs"))};
import { executeLarkImSync, normalizeSyncOptions } from ${JSON.stringify(join(root, "src/adapters/lark-im/sync-command.mjs"))};
const options = normalizeSyncOptions({ db: "synthetic.sqlite", scope: "sent" });\n`;
  // Compile only: none of these calls runs, opens SQLite, or invokes the API.
  const probes = {
    valid: `createSyncRunner();
createSyncRunner({ nowIso: () => "2026-01-01T00:00:00.000Z" });
createSyncRunner({ commitLarkListRun: () => ({ inserted: 0, updated: 0, duplicate: 0,
  pending_details: 0, full_cursor_promoted: false, list_cursor: {} }) });
executeLarkImSync(options, { syncRunnerDeps: { nowMs: () => 1 } });
executeLarkImSync(options, { syncRunner: { syncSent: () => ({ ok: true }) } });`,
    runner_function: "createSyncRunner({ fetchSentMessageList: 123 });",
    runner_result: "createSyncRunner({ commitLarkListRun: () => null });",
    runner_key: "createSyncRunner({ inventedDependency: () => null });",
    command_function: "executeLarkImSync(options, { syncRunnerDeps: { fetchSentMessageList: 123 } });",
    command_result: "executeLarkImSync(options, { syncRunnerDeps: { commitLarkListRun: () => null } });",
    command_key: "executeLarkImSync(options, { syncRunnerDeps: { inventedDependency: () => null } });",
    command_runner_function: "executeLarkImSync(options, { syncRunner: { syncSent: 123 } });",
    command_runner_result: "executeLarkImSync(options, { syncRunner: { syncSent: () => null } });",
    command_runner_key: "executeLarkImSync(options, { syncRunner: { inventedMethod: () => ({ ok: true }) } });",
  };
  const files = Object.entries(probes).map(([name, source]) => {
    const file = join(temporary, `${name}.mjs`);
    writeFileSync(file, imports + source);
    return file;
  });
  const read = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  assert.equal(read.error, undefined);
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  assert.deepEqual(config.errors, []);
  const program = ts.createProgram(files, { ...config.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const invalidFiles = new Set(files.slice(1).map((file) => resolve(file)));
  const unexpected = diagnostics.filter((diagnostic) => !diagnostic.file || !invalidFiles.has(resolve(diagnostic.file.fileName)));
  const messages = (items) => items.map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n");
  assert.equal(unexpected.length, 0, messages(unexpected));
  for (const file of invalidFiles) {
    const errors = diagnostics.filter((diagnostic) => diagnostic.file && resolve(diagnostic.file.fileName) === file);
    assert.ok(errors.length > 0, `${file}: invalid dependency unexpectedly passed typecheck`);
    assert.ok(errors.every((error) => [2322, 2353].includes(error.code)), messages(errors));
  }
});
