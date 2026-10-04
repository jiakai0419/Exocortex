import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function sqlValue(value) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

function sqlite(dbPath, sql, readonly = false) {
  const args = readonly ? ["-readonly", "-json", dbPath] : ["-json", dbPath];
  const result = spawnSync("sqlite3", args, {
    input: `.bail on\n.timeout 5000\n${readonly ? "PRAGMA query_only=ON;" : ""}\n${sql}`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function installFakeLarkCli(dir, dbPath, { beforeLookupSql = "", fail = false, empty = false } = {}) {
  const path = join(dir, "fake-lark-cli.mjs");
  writeFileSync(path, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.slice(0, 3).join(" ") !== "im chats get") {
  process.stderr.write("unexpected synthetic API call");
  process.exit(1);
}
const dbPath = ${JSON.stringify(dbPath)};
const locks = spawnSync("sqlite3", ["-readonly", dbPath, "SELECT count(*) FROM maintenance_locks;"], { encoding: "utf8" });
if (locks.status !== 0 || locks.stdout.trim() !== "0") {
  process.stderr.write("network lookup unexpectedly held a maintenance lock");
  process.exit(1);
}
const params = JSON.parse(args[args.indexOf("--params") + 1]);
const sql = ${JSON.stringify(beforeLookupSql)};
if (sql && params.chat_id === "oc_shape_a") {
  const changed = spawnSync("sqlite3", [dbPath], { input: ".bail on\\n" + sql, encoding: "utf8" });
  if (changed.status !== 0) {
    process.stderr.write(changed.stderr || "synthetic interleaving failed");
    process.exit(1);
  }
}
if (${JSON.stringify(fail)}) {
  process.stderr.write("synthetic lookup failure");
  process.exit(1);
}
process.stdout.write(JSON.stringify(${JSON.stringify(empty)} ? {} : { data: { name: "Resolved " + params.chat_id } }));
`);
  chmodSync(path, 0o755);
  return path;
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-enrich-scopes-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "shape.sqlite");
  sqlite(dbPath, `
    CREATE TABLE sync_scopes (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, config_json TEXT NOT NULL,
      updated_at TEXT, cursor_json TEXT, cursor_updated_at TEXT
    );
    CREATE TABLE records (id INTEGER PRIMARY KEY, first_seen_scope_id TEXT NOT NULL);
    CREATE TABLE sync_locks (scope_id TEXT PRIMARY KEY);
    CREATE TABLE maintenance_locks (
      name TEXT PRIMARY KEY, owner TEXT NOT NULL, acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT ''
    );
  `);
  addScope(dbPath, "a", options.config || {});
  const fakeLarkCli = installFakeLarkCli(dir, dbPath, options);
  return { dir, dbPath, fakeLarkCli };
}

function addScope(dbPath, suffix, overrides = {}) {
  const config = { chat_id: `oc_shape_${suffix}`, chat_type: "group", chat_name: null, marker: "preserve", ...overrides };
  sqlite(dbPath, `
    INSERT INTO sync_scopes VALUES (
      ${sqlValue(`lark.im.received.chat.${suffix}`)}, 'lark.im', ${sqlValue(JSON.stringify(config))},
      '2027-01-01T00:00:00.000Z', '{"created_at_ms":1800000000000}', '2027-01-01T00:00:00.000Z'
    );
    INSERT INTO records (first_seen_scope_id) VALUES (${sqlValue(`lark.im.received.chat.${suffix}`)});
  `);
}

function run(fixture, args = [], env = {}) {
  return spawnSync(process.execPath, ["scripts/lark-im-enrich-scopes.mjs", "--db", fixture.dbPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, LARK_CLI: fixture.fakeLarkCli, ...env },
    encoding: "utf8",
  });
}

function scopes(dbPath) {
  return sqlite(dbPath, "SELECT * FROM sync_scopes ORDER BY id;", true);
}

function locks(dbPath) {
  return sqlite(dbPath, "SELECT * FROM maintenance_locks;", true);
}

test("scope enrichment queries without a maintenance lock, preserves cursor, and is idempotent", (t) => {
  const f = fixture(t);
  const before = scopes(f.dbPath)[0];
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.planned, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped_conflicts, 0);
  assert.equal(summary.dry_run, false);
  const after = scopes(f.dbPath)[0];
  assert.deepEqual(JSON.parse(after.config_json), { ...JSON.parse(before.config_json), chat_name: "Resolved oc_shape_a" });
  for (const key of ["id", "source_id", "cursor_json", "cursor_updated_at"]) assert.equal(after[key], before[key]);
  assert.deepEqual(locks(f.dbPath), []);
  assert.equal(result.stdout.includes("oc_shape_a"), false);
  assert.equal(result.stdout.includes("Resolved"), false);
  const repeated = run(f);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).scanned, 0);
  assert.equal(JSON.parse(repeated.stdout).updated, 0);
  assert.deepEqual(scopes(f.dbPath), [after]);
});

for (const [name, mutation] of [
  ["config", "config_json = json_set(config_json, '$.marker', 'newer discovery metadata')"],
  ["updated_at", "updated_at = '2030-01-01T00:00:00.000Z'"],
  ["source identity", "source_id = 'other.source'"],
]) {
  test(`scope enrichment skips concurrent ${name} changes`, (t) => {
    const f = fixture(t, { beforeLookupSql: `UPDATE sync_scopes SET ${mutation};` });
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.planned, 1);
    assert.equal(summary.updated, 0);
    assert.equal(summary.skipped_conflicts, 1);
    assert.equal(summary.failed, 0);
    const scope = scopes(f.dbPath)[0];
    assert.equal(JSON.parse(scope.config_json).chat_name, null);
    assert.equal(scope.cursor_json, '{"created_at_ms":1800000000000}');
    assert.deepEqual(locks(f.dbPath), []);
  });
}

test("partial conflicts preserve new discovery config while unchanged scopes are enriched", (t) => {
  const newConfig = JSON.stringify({ chat_id: "oc_shape_a", chat_name: "New Discovery Name", muted: true });
  const newCursor = '{"created_at_ms":1800000600000}';
  const f = fixture(t, { beforeLookupSql: `UPDATE sync_scopes SET config_json = ${sqlValue(newConfig)},
    cursor_json = ${sqlValue(newCursor)}, updated_at = '2030-01-01T00:00:00.000Z'
    WHERE id = 'lark.im.received.chat.a';` });
  addScope(f.dbPath, "b");
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.planned, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped_conflicts, 1);
  assert.equal(summary.failed, 0);
  const [a, b] = scopes(f.dbPath);
  assert.equal(a.config_json, newConfig);
  assert.equal(a.cursor_json, newCursor);
  assert.equal(a.updated_at, "2030-01-01T00:00:00.000Z");
  assert.equal(JSON.parse(b.config_json).chat_name, "Resolved oc_shape_b");
  assert.deepEqual(locks(f.dbPath), []);
});

test("a cursor-only advance is preserved when the config CAS still matches", (t) => {
  const newCursor = '{"created_at_ms":1800000600000}';
  const f = fixture(t, { beforeLookupSql: `UPDATE sync_scopes SET cursor_json = ${sqlValue(newCursor)},
    cursor_updated_at = '2030-01-01T00:00:00.000Z';` });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const scope = scopes(f.dbPath)[0];
  assert.equal(scope.cursor_json, newCursor);
  assert.equal(scope.cursor_updated_at, "2030-01-01T00:00:00.000Z");
});

test("a deleted scope is counted as a conflict and not recreated", (t) => {
  const f = fixture(t, { beforeLookupSql: "DELETE FROM records; DELETE FROM sync_scopes;" });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).skipped_conflicts, 1);
  assert.deepEqual(scopes(f.dbPath), []);
  assert.deepEqual(locks(f.dbPath), []);
});

test("scope dry-run leaves bytes, permissions, and file layout unchanged", (t) => {
  const f = fixture(t);
  chmodSync(f.dir, 0o755);
  chmodSync(f.dbPath, 0o644);
  const before = readFileSync(f.dbPath);
  const beforeFiles = readdirSync(f.dir).sort();
  const result = run(f, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.dry_run, true);
  assert.equal(summary.planned, 1);
  assert.equal(summary.updated, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(readFileSync(f.dbPath), before);
  assert.equal(statSync(f.dir).mode & 0o777, 0o755);
  assert.equal(statSync(f.dbPath).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(f.dir).sort(), beforeFiles);
  assert.deepEqual(locks(f.dbPath), []);
});

for (const mode of ["fail", "empty"]) {
  test(`${mode} remote lookup never writes or takes a maintenance lock`, (t) => {
    const f = fixture(t, { [mode]: true });
    chmodSync(f.dir, 0o755);
    chmodSync(f.dbPath, 0o644);
    const before = readFileSync(f.dbPath);
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.planned, 0);
    assert.equal(summary.updated, 0);
    assert.equal(summary.failed, mode === "fail" ? 1 : 0);
    assert.deepEqual(readFileSync(f.dbPath), before);
    assert.equal(statSync(f.dir).mode & 0o777, 0o755);
    assert.equal(statSync(f.dbPath).mode & 0o777, 0o644);
    assert.deepEqual(locks(f.dbPath), []);
  });
}

test("scope dry-run cannot create a missing database or parent directory", (t) => {
  const f = fixture(t);
  const missingParent = join(f.dir, "missing");
  const result = run({ ...f, dbPath: join(missingParent, "shape.sqlite") }, ["--dry-run"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /database not found/);
  assert.equal(existsSync(missingParent), false);
});

test("failed scope commit rolls back and releases its own lock", (t) => {
  const f = fixture(t);
  sqlite(f.dbPath, `CREATE TRIGGER reject_enrichment BEFORE UPDATE ON sync_scopes
    BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PRIVATE_SQL_BODY /invented/private-fixture.sqlite'); END;`);
  const before = scopes(f.dbPath);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scope enrichment failed/);
  assert.doesNotMatch(result.stderr + result.stdout, /SYNTHETIC_PRIVATE_SQL_BODY|private-fixture|CREATE TRIGGER|RAISE/);
  assert.deepEqual(scopes(f.dbPath), before);
  assert.deepEqual(locks(f.dbPath), []);
});

test("scope commit respects a sync lock acquired during network lookup", (t) => {
  const f = fixture(t, { beforeLookupSql: "INSERT INTO sync_locks VALUES ('synthetic-worker');" });
  const before = scopes(f.dbPath);
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /active sync lock/);
  assert.deepEqual(scopes(f.dbPath), before);
  assert.equal(sqlite(f.dbPath, "SELECT count(*) AS count FROM sync_locks;", true)[0].count, 1);
  assert.deepEqual(locks(f.dbPath), []);
});

for (const replacement of [false, true]) {
  test(`scope commit rejects a lease ${replacement ? "replaced" : "expired"} before the write transaction`, (t) => {
    const f = fixture(t);
    const before = scopes(f.dbPath);
    const path = join(f.dir, "sqlite3");
    const mutation = replacement ? "UPDATE maintenance_locks SET owner = 'other-owner';"
      : "UPDATE maintenance_locks SET expires_at = '2000-01-01T00:00:00.000Z';";
    writeFileSync(path, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
if (input.includes("CREATE TEMP TABLE __enrichment_fence")) {
  const changed = spawnSync("/usr/bin/sqlite3", [${JSON.stringify(f.dbPath)}], {
    input: ${JSON.stringify(`.bail on\n${mutation}`)}, encoding: "utf8",
  });
  if (changed.status !== 0) { process.stderr.write(changed.stderr); process.exit(1); }
}
const result = spawnSync("/usr/bin/sqlite3", args, { input, encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`);
    chmodSync(path, 0o755);
    const result = run(f, [], { PATH: `${f.dir}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scope enrichment failed/);
    assert.doesNotMatch(result.stderr, /CHECK constraint|INSERT INTO|maintenance_locks|other-owner/);
    assert.deepEqual(scopes(f.dbPath), before);
    const remaining = locks(f.dbPath);
    if (replacement) {
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].owner, "other-owner");
    } else {
      assert.deepEqual(remaining, []);
    }
  });
}

test("failed readonly query cannot expose SQLite stderr, literals or paths", (t) => {
  const f = fixture(t);
  const before = scopes(f.dbPath);
  const beforeBytes = readFileSync(f.dbPath);
  const path = join(f.dir, "sqlite3");
  writeFileSync(path, `#!/usr/bin/env node
process.stderr.write("SYNTHETIC_PRIVATE_READ_BODY /invented/private-fixture.sqlite SELECT secret FROM invented;");
process.exit(1);
`);
  chmodSync(path, 0o700);
  const result = run(f, ["--dry-run"], { PATH: `${f.dir}:${process.env.PATH}` });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "scope enrichment failed\n");
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE|private-fixture|SELECT secret/);
  assert.deepEqual(readFileSync(f.dbPath), beforeBytes);
  assert.deepEqual(scopes(f.dbPath), before);
  assert.deepEqual(locks(f.dbPath), []);
});
