import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInitialized, quoteSql, sqliteExec } from "../dist/storage/sqlite/ingestion-store.js";
import { runCli } from "../bin/exocortex.mjs";
import { readOnlySqliteJson } from "../src/storage/sqlite/readonly-query.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "invented-message-query-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite");
  ensureInitialized(db);
  const bodies = ["discount 10%", "task_A", "taskZA", "O'Hara", "ALPHA", "Äpfel", "äpfel", "path\\name", "plain", ""];
  const start = Date.parse("2032-01-01T00:00:00Z");
  sqliteExec(db, bodies.map((body, i) => `INSERT INTO records(source_id,first_seen_scope_id,external_id,record_type,occurred_at,occurred_at_ms,direction,body,canonical_json,raw_json)
    VALUES('lark.im','lark.im.sent_by_me','invented_${i}','lark.im.message',${quoteSql(new Date(start + i).toISOString())},${start + i},'${i === 2 ? "sent" : "received"}',${quoteSql(body)},'{}','{}');`).join("\n"));
  return { dir, db, bodies };
}
function cli(db, args, env = process.env) {
  return spawnSync(process.execPath, ["bin/exocortex.mjs", "messages", "--db", db, ...args], { encoding: "utf8", env, timeout: 10_000 });
}

test("messages retains SQLite LIKE wildcard, quoting, case, direction and ordered limit semantics", (t) => {
  const f = fixture(t), before = readFileSync(f.db);
  const cases = [
    ["%", [9,8,7,6,5,4,3,2,1,0]], ["_", [8,7,6,5,4,3,2,1,0]], ["task_A", [2,1]],
    ["O'Hara", [3]], ["alpha", [4]], ["ä", [6]], ["Ä", [5]], ["\\", [7]], ["", [9,8,7,6,5,4,3,2,1,0]],
    ["' OR 1=1 --", []], ["task%", [2,1]],
  ];
  for (const [search, indexes] of cases) {
    const result = cli(f.db, ["--search", search, "--format", "json"]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout).map((row) => row.body), indexes.map((i) => f.bodies[i]), search);
  }
  const filtered = cli(f.db, ["--search", "task_A", "--direction", "received", "--limit", "1", "--format", "json"]);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual(JSON.parse(filtered.stdout).map((row) => row.body), ["task_A"]);
  const limited = cli(f.db, ["--search", "%", "--limit", "2", "--format", "json"]);
  assert.equal(limited.status, 0, limited.stderr);
  assert.deepEqual(JSON.parse(limited.stdout).map((row) => row.body), ["", "plain"]);
  assert.deepEqual(readFileSync(f.db), before, "queries must not rewrite the synthetic database");
});

test("real CLI distinguishes missing SQLite from unreadable schema without disclosing target paths", (t) => {
  const f = fixture(t), empty = join(f.dir, "invented-empty.sqlite");
  writeFileSync(empty, "", { mode: 0o600 });
  for (const [db, env, reason, expected] of [
    [f.db, { ...process.env, PATH: join(f.dir, "no-programs") }, "dependency_unavailable", /ensure sqlite3 is on PATH/],
    [empty, process.env, "read_failed", /run check against the same --db/],
  ]) for (const format of ["json", "text"]) {
    const result = cli(db, ["--format", format], env);
    assert.equal(result.status, 1);
    if (format === "json") {
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.schema_version, 1); assert.equal(report.ok, false);
      assert.equal(report.error.code, "execution_failed"); assert.equal(report.error.reason, reason);
      assert.match(report.error.message, expected);
    } else { assert.equal(result.stdout, ""); assert.match(result.stderr, expected); }
    assert.ok(!(result.stdout + result.stderr).includes(f.dir));
    assert.doesNotMatch(result.stdout + result.stderr, /no such table|SELECT|canonical_json/);
  }
  assert.equal(readFileSync(empty, "utf8"), "");
});

const PRIVATE = "INVENTED_PRIVATE_QUERY_SENTINEL";
function writer() { let text = ""; return { write(value) { text += value; }, value: () => text }; }

test("typed query failures cross the CLI boundary only as fixed categories and instructions", async () => {
  const cases = [
    [{ status: null, error: Object.assign(new Error(PRIVATE), { code: "ENOENT" }) }, "dependency_unavailable", /SQLite command unavailable/],
    [{ status: null, error: Object.assign(new Error(PRIVATE), { code: "ETIMEDOUT" }) }, "read_timeout", /query timed out/],
    [{ status: null, signal: "SIGKILL" }, "read_timeout", /query timed out/],
    [{ status: 1, stderr: PRIVATE }, "read_failed", /Message query failed/],
    [{ status: 0, stdout: `{${PRIVATE}` }, "invalid_response", /invalid query response/],
    [{ status: 0, stdout: JSON.stringify({ private: PRIVATE }) }, "invalid_response", /invalid query response/],
  ];
  for (const [child, reason, expected] of cases) for (const format of ["text", "json"]) {
    const stdout = writer(), stderr = writer();
    const exit = await runCli(["messages", "--db", `/synthetic/${PRIVATE}`, "--format", format], { stdout, stderr,
      deps: { existsSync: () => true, readLocalChatAppNames: () => null,
        loadMessages: () => readOnlySqliteJson(`/synthetic/${PRIVATE}`, `SELECT '${PRIVATE}'`, PRIVATE, { spawnSync: () => child }) } });
    assert.equal(exit, 1);
    assert.doesNotMatch(stdout.value() + stderr.value(), new RegExp(`${PRIVATE}|SELECT|synthetic/`));
    if (format === "json") {
      assert.equal(stderr.value(), ""); const report = JSON.parse(stdout.value());
      assert.equal(report.error.code, "execution_failed"); assert.equal(report.error.reason, reason);
      assert.match(report.error.message, expected);
    } else { assert.equal(stdout.value(), ""); assert.match(stderr.value(), expected); }
  }
});

test("untyped errors cannot opt into a public classification by name or reason", async () => {
  const output = writer();
  const error = Object.assign(new Error(PRIVATE), { name: "SqliteReadError", reason: "read_failed" });
  assert.equal(await runCli(["messages", "--format", "json"], { stdout: output,
    deps: { existsSync: () => true, readLocalChatAppNames: () => null, loadMessages: () => { throw error; } } }), 1);
  assert.deepEqual(JSON.parse(output.value()).error, { code: "execution_failed", message: "Unable to complete command; check its required dependencies and local evidence." });
  assert.doesNotMatch(output.value(), new RegExp(PRIVATE));
});
