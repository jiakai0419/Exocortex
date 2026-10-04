import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Authored from empty objects for this suite: an imaginary materials bench.
// The API field names are contracts; all identities, prose, times and relationships
// below are composed here, without loading or transforming captured messages.
const LAB = Object.freeze({
  self: Object.freeze({ open_id: "ou_fixture_bench_operator", name: "Operator Seven" }),
  room: Object.freeze({ id: "oc_fixture_paper_bench", name: ["Paper", "Kite", "Bench"].join(" ") }),
  shelf: Object.freeze({ id: "oc_fixture_tile_shelf", name: ["Copper", "Tile", "Shelf"].join(" ") }),
  app: Object.freeze({ id: "cli_fixture_counter", name: ["Pebble", "Counter"].join(" ") }),
  receivedScope: "lark.im.received.chat.fixture_bench",
});
const FIXTURE_EPOCH = Date.UTC(2042, 1, 3, 4, 5, 6);
const CONCURRENT_AT = new Date(FIXTURE_EPOCH + 86_400_000).toISOString();
const SAFE_PATH = [...new Set([dirname(process.execPath), "/usr/bin", "/bin"])].join(":");

function syntheticRecord({ key = "calibration", ordinal = 0, room = LAB.room,
  sender = { id: LAB.self.open_id, name: LAB.self.name, sender_type: "user" },
  msgType = "text", content, ...overrides } = {}) {
  const occurredAt = FIXTURE_EPOCH + ordinal * 13_000;
  const body = ["Count", ordinal + 3, "paper triangles on tray", key].join(" ");
  const messageId = ["om", "fixture", "bench", key, ordinal].join("_");
  const raw = {
    message_id: messageId, msg_type: msgType, create_time: String(occurredAt),
    update_time: String(occurredAt + 137), chat_id: room.id,
    // These authored person fixtures use open IDs. Explicit per-case overrides
    // remain available; app fixtures keep their separate namespace contract.
    sender: { ...(sender.sender_type === "user" ? { id_type: "open_id" } : {}), ...sender },
    content: content ?? { text: body },
  };
  const canonical = {
    message_id: messageId, msg_type: msgType,
    sender_id: sender.id || null, sender_name: sender.name || null,
    sender_type: sender.sender_type || null,
    chat_id: room.id, chat_type: "group", chat_name: null, content: raw.content,
    ...overrides.canonical,
  };
  return {
    raw, external_id: messageId, external_version: raw.update_time,
    body, occurred_at_ms: occurredAt, updated_at: new Date(occurredAt + 500).toISOString(),
    ...overrides, canonical,
  };
}

function isolatedEnvironment(dir, fakeLarkCli, overrides = {}) {
  return {
    PATH: SAFE_PATH, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"),
    TMPDIR: dir, LANG: "C", TZ: "UTC",
    LARK_CLI: fakeLarkCli, ...overrides,
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-enrich-records-test-"));
  for (const child of ["home", "config", "cache", "data"]) mkdirSync(join(dir, child));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sqliteExec(dbPath, sql, label) {
  const result = spawnSync("sqlite3", [dbPath], {
    input: `.bail on\n.timeout 5000\n${sql}`,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
}

function sqliteJson(dbPath, sql, label) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath], {
    input: `.bail on\n.timeout 5000\nPRAGMA query_only=ON;\n${sql}`,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr.trim()}`);
  const trimmed = result.stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function quoteSql(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function installFakeLarkCli(dir, { dbPath = null, beforeSelfSql = "", assertNoMaintenanceLock = false,
  denyLookups = false, contactUsers = null, paginateContacts = false, memberItems = null, callLogPath = null } = {}) {
  const path = join(dir, "fake-lark-cli.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (${JSON.stringify(callLogPath)} !== null) appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(args) + "\\n");
const dbPath = ${JSON.stringify(dbPath)};
if (${JSON.stringify(assertNoMaintenanceLock)}) {
  const locks = spawnSync("sqlite3", ["-readonly", dbPath, "SELECT count(*) FROM maintenance_locks;"], { encoding: "utf8" });
  if (locks.status !== 0 || locks.stdout.trim() !== "0") {
    process.stderr.write("network lookup unexpectedly held maintenance lock");
    process.exit(1);
  }
}
if (args.join(" ") === "contact +get-user --as user --format json") {
  const sql = ${JSON.stringify(beforeSelfSql)};
  if (sql) {
    const changed = spawnSync("sqlite3", [dbPath], { input: ".bail on\\n" + sql, encoding: "utf8" });
    if (changed.status !== 0) {
      process.stderr.write(changed.stderr || "synthetic interleaving failed");
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify(${JSON.stringify(LAB.self)}));
  process.exit(0);
}
if (${JSON.stringify(denyLookups)}) {
  process.stderr.write('synthetic permission denied');
  process.exit(1);
}
if (args[0] === 'contact' && args[1] === '+search-user' && ${JSON.stringify(contactUsers)} !== null) {
  let users = ${JSON.stringify(contactUsers)};
  if (${JSON.stringify(paginateContacts)}) {
    const requested = new Set((args[args.indexOf('--user-ids') + 1] || '').split(','));
    const pageSize = args.includes('--page-size') ? Number(args[args.indexOf('--page-size') + 1]) : 20;
    users = users.filter(user => requested.has(user.open_id)).slice(0, pageSize);
  }
  process.stdout.write(JSON.stringify({ users }));
  process.exit(0);
}
if (args[0] === 'im' && args[1] === 'chat.members' && args[2] === 'get' && ${JSON.stringify(memberItems)} !== null) {
  process.stdout.write(JSON.stringify({ items: ${JSON.stringify(memberItems)}, has_more: false }));
  process.exit(0);
}
process.stderr.write("unexpected lark-cli call: " + args.join(" "));
process.exit(1);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function installSchema(dbPath) {
  sqliteExec(
    dbPath,
    `CREATE TABLE sync_scopes (
       id TEXT PRIMARY KEY,
       source_id TEXT NOT NULL,
       config_json TEXT NOT NULL
     );
     CREATE TABLE sync_locks (
       scope_id TEXT PRIMARY KEY
     );
     CREATE TABLE maintenance_locks (
       name TEXT PRIMARY KEY,
       owner TEXT NOT NULL,
       acquired_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       reason TEXT NOT NULL DEFAULT ''
     );
     CREATE TABLE records (
       id INTEGER PRIMARY KEY,
       source_id TEXT NOT NULL,
       first_seen_scope_id TEXT NOT NULL,
       external_id TEXT NOT NULL,
       external_version TEXT,
       content_hash TEXT,
       actor_id TEXT,
       container_id TEXT,
       body TEXT NOT NULL,
       canonical_json TEXT NOT NULL,
       raw_json TEXT NOT NULL,
       record_type TEXT NOT NULL,
       occurred_at_ms INTEGER NOT NULL,
       updated_at TEXT
     );`,
    "install schema",
  );
}

function insertScope(dbPath, id, config) {
  sqliteExec(
    dbPath,
    `INSERT INTO sync_scopes (id, source_id, config_json)
     VALUES (${quoteSql(id)}, 'lark.im', ${quoteSql(JSON.stringify(config))});`,
    `insert ${id}`,
  );
}

function insertRecord(dbPath, overrides = {}) {
  const fixture = syntheticRecord(overrides);
  const { canonical, raw } = fixture;
  sqliteExec(
    dbPath,
    `INSERT INTO records (
       source_id,
       first_seen_scope_id,
       external_id,
       external_version,
       content_hash,
       actor_id,
       container_id,
       body,
       canonical_json,
       raw_json,
       record_type,
       occurred_at_ms,
       updated_at
     )
     VALUES (
       'lark.im',
       ${quoteSql(fixture.first_seen_scope_id || "lark.im.sent_by_me")},
       ${quoteSql(fixture.external_id)},
       ${quoteSql(fixture.external_version)},
       ${quoteSql(fixture.content_hash ?? createHash("sha256").update(JSON.stringify(raw)).digest("hex"))},
       ${quoteSql(canonical.sender_id)},
       ${quoteSql(canonical.chat_id)},
       ${quoteSql(fixture.body)},
       ${quoteSql(JSON.stringify(canonical))},
       ${quoteSql(JSON.stringify(raw))},
       'lark.im.message',
       ${Number(fixture.occurred_at_ms)},
       ${quoteSql(fixture.updated_at)}
     );`,
    `insert ${fixture.external_id}`,
  );
  return fixture;
}

test("scope and record metadata independently name synthetic rooms without exposing app details", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "bench.sqlite");
  const fakeLarkCli = installFakeLarkCli(dir);
  installSchema(dbPath);
  insertScope(dbPath, "lark.im.sent_by_me", {});
  insertScope(dbPath, LAB.receivedScope, {
    chat_id: LAB.room.id,
    chat_type: "group",
    chat_name: LAB.room.name,
  });
  const unnamedBench = insertRecord(dbPath, { key: "fold", ordinal: 2 });
  const unnamedShelf = insertRecord(dbPath, { key: "stack", ordinal: 3, room: LAB.shelf });
  insertRecord(dbPath, {
    key: "inventory", ordinal: 4, room: LAB.shelf,
    first_seen_scope_id: LAB.receivedScope,
    canonical: { chat_name: LAB.shelf.name },
  });
  insertRecord(dbPath, {
    key: "counter", ordinal: 5,
    sender: { id: LAB.app.id, name: LAB.app.name, sender_type: "app" },
    canonical: { chat_name: LAB.room.name },
  });

  const result = spawnSync(
    process.execPath,
    ["scripts/lark-im-enrich-records.mjs", "--db", dbPath, "--limit", "10"],
    {
      cwd: process.cwd(),
      env: isolatedEnvironment(dir, fakeLarkCli),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.updated, 2);
  for (const value of [LAB.app.id, LAB.app.name, LAB.room.name, LAB.shelf.name]) {
    assert.equal(result.stdout.includes(value), false);
  }

  const rows = sqliteJson(
    dbPath,
    `SELECT external_id, json_extract(canonical_json, '$.chat_name') AS chat_name
     FROM records
     WHERE external_id IN (${quoteSql(unnamedBench.external_id)}, ${quoteSql(unnamedShelf.external_id)}) ORDER BY id;`,
    "read enriched sent record",
  );
  assert.deepEqual(rows, [
    { external_id: unnamedBench.external_id, chat_name: LAB.room.name },
    { external_id: unnamedShelf.external_id, chat_name: LAB.shelf.name },
  ]);

  const unsafe = spawnSync(
    process.execPath,
    ["scripts/lark-im-enrich-records.mjs", "--db", dbPath, "--limit", "10", "--unsafe-details"],
    {
      cwd: process.cwd(),
      env: isolatedEnvironment(dir, fakeLarkCli),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  assert.equal(unsafe.status, 0, unsafe.stderr);
  assert.equal(unsafe.stdout.includes(LAB.app.id), true);
  assert.equal(unsafe.stdout.includes(LAB.app.name), true);
});

function enrichmentFixture(t, options = {}) {
  const dir = tempDir(t);
  const dbPath = join(dir, "bench.sqlite");
  installSchema(dbPath);
  insertScope(dbPath, "lark.im.sent_by_me", {});
  insertScope(dbPath, LAB.receivedScope, {
    chat_id: LAB.room.id, chat_type: "group", chat_name: LAB.room.name,
  });
  insertRecord(dbPath, options.record || {});
  const fakeLarkCli = installFakeLarkCli(dir, {
    dbPath, assertNoMaintenanceLock: true, ...options,
  });
  return { dir, dbPath, fakeLarkCli };
}

function runEnrichment(fixture, args = [], env = {}) {
  return spawnSync(process.execPath, ["scripts/lark-im-enrich-records.mjs", "--db", fixture.dbPath, ...args], {
    cwd: process.cwd(),
    env: isolatedEnvironment(fixture.dir || dirname(fixture.dbPath), fixture.fakeLarkCli, env),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function readRecords(dbPath) {
  return sqliteJson(dbPath, "SELECT * FROM records ORDER BY id;", "read synthetic records");
}

function maintenanceLocks(dbPath) {
  return sqliteJson(dbPath, "SELECT * FROM maintenance_locks;", "read synthetic locks");
}

test("enrichment commits only derived fields, holds no lock during lookup, and is idempotent", (t) => {
  const fixture = enrichmentFixture(t);
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.planned, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped_conflicts, 0);
  assert.equal(summary.dry_run, false);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).chat_name, LAB.room.name);
  for (const field of Object.keys(before).filter((key) => !["canonical_json", "updated_at"].includes(key))) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);

  const repeated = runEnrichment(fixture);
  assert.equal(repeated.status, 0, repeated.stderr);
  const repeatedSummary = JSON.parse(repeated.stdout);
  assert.equal(repeatedSummary.planned, 0);
  assert.equal(repeatedSummary.updated, 0);
  assert.equal(repeatedSummary.unchanged, 1);
  assert.deepEqual(readRecords(fixture.dbPath), [after]);
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

test("room enrichment preserves an independently composed system event and absent actor", (t) => {
  const content = { template: "Tile {item} moved to {slot}.", item: "hexagon" };
  const display = "Tile hexagon moved to [未知参数：slot].";
  const fixture = enrichmentFixture(t, { record: {
    key: "system_tile", ordinal: 11, msgType: "system", sender: {}, content, body: display,
    canonical: { thread_id: "omt_fixture_tile_chain" },
  } });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(after.body, display);
  assert.equal(after.actor_id, null);
  assert.equal(after.raw_json, before.raw_json);
  assert.equal(after.content_hash, before.content_hash);
  assert.equal(after.external_version, before.external_version);
  const canonical = JSON.parse(after.canonical_json);
  assert.deepEqual(canonical.content, content);
  assert.equal(canonical.thread_id, "omt_fixture_tile_chain");
  assert.equal(canonical.sender_id, null);
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.chat_name, LAB.room.name);
});

const concurrentChanges = [
  ["external version", `external_version = ${quoteSql(String(FIXTURE_EPOCH + 9_100))}`],
  ["content hash", `content_hash = ${quoteSql(createHash("sha256").update("six spare tiles").digest("hex"))}`],
  ["raw content", `raw_json = ${quoteSql(JSON.stringify(syntheticRecord({ key: "raw_swap", ordinal: 8 }).raw))}`],
  ["canonical content", "canonical_json = json_set(canonical_json, '$.content', 'Draw four violet squares.')"],
  ["body", "body = 'Move five cork disks to tray B.'"],
  ["actor", "actor_id = 'ou_fixture_bench_observer'"],
  ["container", `container_id = ${quoteSql(LAB.shelf.id)}`],
];

for (const [label, update] of concurrentChanges) {
  test(`enrichment skips a concurrent ${label} change and reports actual effects`, (t) => {
    const fixture = enrichmentFixture(t, {
      beforeSelfSql: `UPDATE records SET ${update}, updated_at = ${quoteSql(CONCURRENT_AT)};`,
    });
    const result = runEnrichment(fixture);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.planned, 1);
    assert.equal(summary.updated, 0);
    assert.equal(summary.skipped_conflicts, 1);
    const row = readRecords(fixture.dbPath)[0];
    assert.equal(row.updated_at, CONCURRENT_AT);
    assert.equal(JSON.parse(row.canonical_json).chat_name, null);
    assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
    assert.equal(result.stdout.includes(LAB.self.open_id), false);
    assert.equal(result.stdout.includes(syntheticRecord().external_id), false);
  });
}

test("a full newer source snapshot survives enrichment while unchanged rows can commit", (t) => {
  const newerBody = "Sort seven wooden polygons by edge count.";
  const replacement = syntheticRecord({ content: { text: newerBody }, body: newerBody,
    canonical: { chat_name: "Polygon Sorting Station" } });
  const version = String(FIXTURE_EPOCH + 19_000);
  replacement.raw.update_time = version;
  const newerRaw = JSON.stringify(replacement.raw);
  const newerCanonical = JSON.stringify(replacement.canonical);
  const newerHash = createHash("sha256").update(newerRaw).digest("hex");
  const fixture = enrichmentFixture(t, {
    beforeSelfSql: `UPDATE records SET external_version = ${quoteSql(version)},
      raw_json = ${quoteSql(newerRaw)}, content_hash = ${quoteSql(newerHash)},
      canonical_json = ${quoteSql(newerCanonical)}, body = ${quoteSql(newerBody)},
      updated_at = ${quoteSql(CONCURRENT_AT)}
      WHERE external_id = ${quoteSql(replacement.external_id)};`,
  });
  insertRecord(fixture.dbPath, { key: "uncontended", ordinal: 6 });
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.planned, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped_conflicts, 1);
  const [newer, enriched] = readRecords(fixture.dbPath);
  assert.equal(newer.external_version, version);
  assert.equal(newer.content_hash, newerHash);
  assert.equal(newer.raw_json, newerRaw);
  assert.equal(newer.canonical_json, newerCanonical);
  assert.equal(newer.body, newerBody);
  assert.equal(newer.updated_at, CONCURRENT_AT);
  assert.equal(JSON.parse(enriched.canonical_json).chat_name, LAB.room.name);
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

test("enrichment does not resurrect a record deleted during lookup", (t) => {
  const fixture = enrichmentFixture(t, { beforeSelfSql: "DELETE FROM records;" });
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.updated, 0);
  assert.equal(summary.skipped_conflicts, 1);
  assert.deepEqual(readRecords(fixture.dbPath), []);
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

test("dry-run changes no database bytes, permissions, files, or maintenance locks", (t) => {
  const fixture = enrichmentFixture(t);
  chmodSync(fixture.dir, 0o755);
  chmodSync(fixture.dbPath, 0o644);
  const beforeBytes = readFileSync(fixture.dbPath);
  const beforeFiles = readdirSync(fixture.dir).sort();
  const result = runEnrichment(fixture, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.dry_run, true);
  assert.equal(summary.planned, 1);
  assert.equal(summary.updated, 0);
  assert.equal(summary.skipped_conflicts, 0);
  assert.deepEqual(readFileSync(fixture.dbPath), beforeBytes);
  assert.equal(statSync(fixture.dir).mode & 0o777, 0o755);
  assert.equal(statSync(fixture.dbPath).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(fixture.dir).sort(), beforeFiles);
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

test("a no-change default run reads without chmod or database writes", (t) => {
  const fixture = enrichmentFixture(t, { record: { canonical: { chat_name: LAB.room.name } } });
  chmodSync(fixture.dir, 0o755);
  chmodSync(fixture.dbPath, 0o644);
  const before = readFileSync(fixture.dbPath);
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).planned, 0);
  assert.deepEqual(readFileSync(fixture.dbPath), before);
  assert.equal(statSync(fixture.dir).mode & 0o777, 0o755);
  assert.equal(statSync(fixture.dbPath).mode & 0o777, 0o644);
});

test("dry-run on a missing path creates neither database nor parent directory", (t) => {
  const dir = tempDir(t);
  const missingParent = join(dir, "missing");
  const result = runEnrichment({ dir, dbPath: join(missingParent, "bench.sqlite"), fakeLarkCli: "/usr/bin/false" }, ["--dry-run"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /database not found/);
  assert.equal(existsSync(missingParent), false);
});

test("a failed commit rolls back all enrichment and releases its maintenance lock", (t) => {
  const fixture = enrichmentFixture(t);
  sqliteExec(fixture.dbPath, `CREATE TRIGGER reject_enrichment BEFORE UPDATE ON records
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`, "install rejection trigger");
  const before = readRecords(fixture.dbPath);
  const result = runEnrichment(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic write failure/);
  assert.deepEqual(readRecords(fixture.dbPath), before);
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

test("an active sync lock blocks only the commit and remains untouched", (t) => {
  const fixture = enrichmentFixture(t, {
    beforeSelfSql: "INSERT INTO sync_locks (scope_id) VALUES ('lark.im.sent_by_me');",
  });
  const before = readRecords(fixture.dbPath);
  const result = runEnrichment(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /active sync lock/);
  assert.deepEqual(readRecords(fixture.dbPath), before);
  assert.equal(sqliteJson(fixture.dbPath, "SELECT count(*) AS count FROM sync_locks;", "read sync lock")[0].count, 1);
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

function installCommitInterleavingSqlite(dir, dbPath, sql) {
  const path = join(dir, "sqlite3");
  writeFileSync(path, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
if (input.includes("CREATE TEMP TABLE __enrichment_fence")) {
  const changed = spawnSync("/usr/bin/sqlite3", [${JSON.stringify(dbPath)}], {
    input: ${JSON.stringify(`.bail on\n${sql}`)}, encoding: "utf8",
  });
  if (changed.status !== 0) {
    process.stderr.write(changed.stderr || "synthetic interleaving failed");
    process.exit(1);
  }
}
const result = spawnSync("/usr/bin/sqlite3", args, { input, encoding: "utf8" });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status ?? 1);
`);
  chmodSync(path, 0o755);
}

for (const replacement of [false, true]) {
  test(`commit rejects a maintenance lease ${replacement ? "replaced" : "expired"} after acquisition`, (t) => {
    const fixture = enrichmentFixture(t);
    const before = readRecords(fixture.dbPath);
    const mutation = replacement
      ? "UPDATE maintenance_locks SET owner = 'synthetic-other-owner';"
      : "UPDATE maintenance_locks SET expires_at = '1997-03-11T12:13:14.000Z';";
    installCommitInterleavingSqlite(fixture.dir, fixture.dbPath, mutation);
    const result = runEnrichment(fixture, [], { PATH: `${fixture.dir}:${SAFE_PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CHECK constraint failed/);
    assert.deepEqual(readRecords(fixture.dbPath), before);
    const locks = maintenanceLocks(fixture.dbPath);
    if (replacement) {
      assert.equal(locks.length, 1);
      assert.equal(locks[0].owner, "synthetic-other-owner");
    } else {
      assert.deepEqual(locks, []);
    }
  });
}


test("failed app probe keeps existing name and provenance byte-stable", (t) => {
  const fixture = enrichmentFixture(t, { denyLookups: true, record: {
    sender: { id: LAB.app.id, sender_type: "app" },
    canonical: { chat_name: LAB.room.name, sender_name: LAB.app.name,
      sender_name_source: "application_api", sender_name_confidence: "high" },
  } });
  const before = readRecords(fixture.dbPath);
  const result = runEnrichment(fixture, ["--probe-apps"]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.app_lookup_permission_denied, 1);
  assert.equal(summary.updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath), before);
});

test("explicit cleared app name survives failed enrichment without unknown diagnostics churn", (t) => {
  const fixture = enrichmentFixture(t, { denyLookups: true, record: {
    sender: { id: LAB.app.id, name: "Historical Counter Name", sender_type: "app" },
    canonical: { chat_name: LAB.room.name, sender_name: null, sender_name_state: "cleared",
      sender_name_source: "synthetic_authority", sender_name_confidence: "high" },
  } });
  const before = readRecords(fixture.dbPath);
  const result = runEnrichment(fixture, ["--probe-apps"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath), before);
});

test("fresh partner lookup replaces explicit clear and removes its clear marker once", (t) => {
  const partnerId = "ou_fixture_pendulum_reader";
  const fixture = enrichmentFixture(t, {
    contactUsers: [{ open_id: partnerId, name: "Pendulum Reader" }],
    record: { canonical: { chat_name: LAB.room.name,
      chat_partner: { open_id: partnerId, name: null, name_state: "cleared" } } },
  });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const after = readRecords(fixture.dbPath)[0];
  const partner = JSON.parse(after.canonical_json).chat_partner;
  assert.equal(partner.name, "Pendulum Reader");
  assert.equal(partner.name_state, undefined);
  for (const field of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(after[field], before[field]);
  const repeated = runEnrichment(fixture);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath)[0], after);
});

test("fresh contact lookup replaces a cleared sender with current provenance", (t) => {
  const personId = "ou_fixture_pendulum_maker";
  const fixture = enrichmentFixture(t, {
    contactUsers: [{ open_id: personId, name: "Pendulum Maker" }],
    record: { sender: { id: personId, sender_type: "user" }, canonical: {
      chat_name: LAB.room.name, sender_name: null, sender_name_state: "cleared",
      sender_name_source: "synthetic_authority", sender_name_confidence: "high",
    } },
  });
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const canonical = JSON.parse(readRecords(fixture.dbPath)[0].canonical_json);
  assert.equal(canonical.sender_name, "Pendulum Maker");
  assert.equal(canonical.sender_name_state, undefined);
  assert.equal(canonical.sender_name_source, "contact");
  assert.equal(canonical.sender_name_confidence, "high");
});

for (const state of ["cleared", "known"]) {
  test(`failed enrichment cannot replace a ${state} chat name from cached scope metadata`, (t) => {
    const fixture = enrichmentFixture(t, { denyLookups: true, record: {
      first_seen_scope_id: LAB.receivedScope,
      sender: { id: LAB.app.id, sender_type: "app" },
      canonical: {
        chat_name: state === "known" ? "Current Pendulum Studio" : null,
        ...(state === "cleared" ? { chat_name_state: "cleared" } : {}),
        chat_name_source: "synthetic_authority",
        sender_name: LAB.app.name, sender_name_source: "application_api", sender_name_confidence: "high",
      },
    } });
    const before = readRecords(fixture.dbPath);
    assert.equal(before[0].raw_json.includes('"chat_name"'), false);
    const result = runEnrichment(fixture, ["--probe-apps"]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.app_lookup_permission_denied, 1);
    assert.equal(summary.updated, 0);
    assert.deepEqual(readRecords(fixture.dbPath), before);
  });
}

test("historical room enrichment fills unknown names once with explicit provenance", (t) => {
  const fixture = enrichmentFixture(t);
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const after = readRecords(fixture.dbPath)[0];
  const canonical = JSON.parse(after.canonical_json);
  assert.equal(canonical.chat_name, LAB.room.name);
  assert.equal(canonical.chat_name_source, "local_history");
  for (const field of ["raw_json", "content_hash", "external_version", "body"]) assert.equal(after[field], before[field]);
  const repeated = runEnrichment(fixture);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath)[0], after);
});

function enrichmentCalls(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

test("ordinary enrichment resolves 65 distinct missing person names through explicit 30/30/5 contact pages", (t) => {
  const users = Array.from({ length: 65 }, (_, index) => ({
    open_id: `ou_fixture_parity_tessellation_${index}`, name: `Synthetic Tessellation Maker ${index}`,
  }));
  const fixture = enrichmentFixture(t, {
    record: { key: "parity_contact_0", ordinal: 1,
      sender: { id: users[0].open_id, sender_type: "user" }, canonical: { chat_name: LAB.room.name } },
    contactUsers: users, paginateContacts: true,
  });
  const callsPath = join(fixture.dir, "parity-calls.jsonl");
  installFakeLarkCli(fixture.dir, { dbPath: fixture.dbPath, assertNoMaintenanceLock: true,
    contactUsers: users, paginateContacts: true, callLogPath: callsPath });
  users.slice(1).forEach((user, index) => insertRecord(fixture.dbPath, {
    key: `parity_contact_${index + 1}`, ordinal: index + 2,
    sender: { id: user.open_id, sender_type: "user" }, canonical: { chat_name: LAB.room.name },
  }));
  const before = readRecords(fixture.dbPath);
  const result = runEnrichment(fixture, ["--limit", "65"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 65);
  const requests = enrichmentCalls(callsPath).filter(args => args[0] === "contact" && args[1] === "+search-user");
  const requestedIds = requests.map(args => args[args.indexOf("--user-ids") + 1].split(","));
  assert.deepEqual(requestedIds.map(ids => ids.length), [30, 30, 5]);
  for (const args of requests) assert.equal(args[args.indexOf("--page-size") + 1], "30");
  assert.deepEqual(new Set(requestedIds.flat()), new Set(users.map(user => user.open_id)));
  const expected = new Map(users.map(user => [user.open_id, user.name]));
  const after = readRecords(fixture.dbPath);
  for (let index = 0; index < after.length; index += 1) {
    const canonical = JSON.parse(after[index].canonical_json);
    assert.equal(canonical.sender_name, expected.get(after[index].actor_id));
    assert.equal(canonical.sender_name_source, "contact");
    for (const field of ["raw_json", "content_hash", "external_version", "body"])
      assert.equal(after[index][field], before[index][field], field);
  }
  assert.deepEqual(maintenanceLocks(fixture.dbPath), []);
});

test("ordinary enrichment accepts a localized-only chat member name through the shared resolver", (t) => {
  const personId = "ou_fixture_parity_localized_weaver";
  const fixture = enrichmentFixture(t, {
    contactUsers: [], memberItems: [{ member_id: personId, localized_name: "Synthetic Localized Weaver" }],
    record: { sender: { id: personId, sender_type: "user" }, canonical: { chat_name: LAB.room.name } },
  });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 1);
  const after = readRecords(fixture.dbPath)[0];
  const canonical = JSON.parse(after.canonical_json);
  assert.equal(canonical.sender_name, "Synthetic Localized Weaver");
  assert.equal(canonical.sender_name_source, "chat_member");
  for (const field of ["raw_json", "content_hash", "external_version", "body"])
    assert.equal(after[field], before[field], field);
});

test("ordinary enrichment keeps the fresh self seed when another lookup returns an unsolicited old self name", (t) => {
  const otherId = "ou_fixture_parity_glaze_reader";
  const responses = [{ open_id: LAB.self.open_id, name: "Synthetic Obsolete Operator" },
    { open_id: otherId, name: "Synthetic Glaze Reader" }];
  const fixture = enrichmentFixture(t, {
    contactUsers: responses,
    record: { key: "parity_self", ordinal: 1,
      sender: { id: LAB.self.open_id, sender_type: "user" }, canonical: { chat_name: LAB.room.name } },
  });
  insertRecord(fixture.dbPath, { key: "parity_other", ordinal: 2,
    sender: { id: otherId, sender_type: "user" }, canonical: { chat_name: LAB.room.name } });
  const callsPath = join(fixture.dir, "parity-calls.jsonl");
  installFakeLarkCli(fixture.dir, { dbPath: fixture.dbPath, assertNoMaintenanceLock: true,
    contactUsers: responses, callLogPath: callsPath });
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const rows = readRecords(fixture.dbPath);
  assert.equal(JSON.parse(rows.find(row => row.actor_id === LAB.self.open_id).canonical_json).sender_name, LAB.self.name);
  assert.equal(JSON.parse(rows.find(row => row.actor_id === otherId).canonical_json).sender_name, "Synthetic Glaze Reader");
  const requests = enrichmentCalls(callsPath).filter(args => args[0] === "contact" && args[1] === "+search-user");
  assert.equal(requests.length, 1);
  assert.equal(requests[0][requests[0].indexOf("--user-ids") + 1], otherId);
  assert.doesNotMatch(JSON.stringify(rows), /Synthetic Obsolete Operator/);
});

test("ordinary enrichment retries a permission failure on a later run and fills the same source version once", (t) => {
  const personId = "ou_fixture_parity_pottery_reader";
  const fixture = enrichmentFixture(t, {
    denyLookups: true,
    record: { sender: { id: personId, sender_type: "user" }, canonical: { chat_name: LAB.room.name } },
  });
  const before = readRecords(fixture.dbPath)[0];
  const denied = runEnrichment(fixture);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(readRecords(fixture.dbPath)[0].canonical_json).sender_name, null);
  installFakeLarkCli(fixture.dir, { dbPath: fixture.dbPath, assertNoMaintenanceLock: true,
    contactUsers: [{ open_id: personId, name: "Synthetic Pottery Reader" }] });
  const recovered = runEnrichment(fixture);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).updated, 1);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, "Synthetic Pottery Reader");
  for (const field of ["raw_json", "content_hash", "external_version", "body"])
    assert.equal(after[field], before[field], field);
  const repeated = runEnrichment(fixture);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath)[0], after);
});

const ENRICHMENT_ALIASES = Object.freeze({ open_id: "ou_fixture_alias_pottery_maker",
  user_id: "synthetic_pottery_user_alias", union_id: "synthetic_pottery_union_alias" });
const ALIAS_PERSON = "Synthetic Pottery Maker";

function aliasEnrichmentFixture(t, senderOverrides = {}, remoteOverrides = {}, canonicalOverrides = {}) {
  const sender = { id: ENRICHMENT_ALIASES.open_id, id_type: "open_id", sender_type: "user",
    ...ENRICHMENT_ALIASES, ...senderOverrides };
  const fixture = enrichmentFixture(t, { ...remoteOverrides,
    contactUsers: [{ open_id: ENRICHMENT_ALIASES.open_id, name: ALIAS_PERSON }],
    record: { sender, canonical: { sender_id: ENRICHMENT_ALIASES.open_id,
      sender_name: null, chat_name: LAB.room.name, ...canonicalOverrides } },
  });
  const callsPath = join(fixture.dir, "alias-calls.jsonl");
  installFakeLarkCli(fixture.dir, { dbPath: fixture.dbPath, assertNoMaintenanceLock: true,
    contactUsers: [{ open_id: ENRICHMENT_ALIASES.open_id, name: ALIAS_PERSON }],
    callLogPath: callsPath, ...remoteOverrides });
  return { ...fixture, callsPath };
}

function assertAliasSourcePreserved(before, after) {
  for (const field of ["raw_json", "content_hash", "external_version", "body", "actor_id", "container_id"])
    assert.equal(after[field], before[field], field);
  const omitName = value => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["sender_id_type", "sender_name", "sender_name_source", "sender_name_confidence"].includes(key)));
  assert.deepEqual(omitName(JSON.parse(after.canonical_json)), omitName(JSON.parse(before.canonical_json)));
}

for (const aliasType of ["user_id", "union_id"]) {
  test(`ordinary sender alias ${aliasType} already in canonical sender_name is corrected`, (t) => {
    const fixture = aliasEnrichmentFixture(t, {}, {}, {
      sender_name: ENRICHMENT_ALIASES[aliasType], sender_name_source: "contact", sender_name_confidence: "high" });
    const before = readRecords(fixture.dbPath)[0];
    const result = runEnrichment(fixture);
    assert.equal(result.status, 0, result.stderr);
    const after = readRecords(fixture.dbPath)[0];
    assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
    assertAliasSourcePreserved(before, after);
    const searches = enrichmentCalls(fixture.callsPath).filter(args => args[0] === "contact" && args[1] === "+search-user");
    assert.equal(searches.length, 1);
    assert.equal(searches[0][searches[0].indexOf("--user-ids") + 1], ENRICHMENT_ALIASES.open_id);
  });
}

test("ordinary sender alias already in canonical sender_name is corrected using only nested typed identities", (t) => {
  const fixture = aliasEnrichmentFixture(t, { id: undefined, id_type: undefined,
    open_id: undefined, user_id: undefined, union_id: undefined, sender_id: { ...ENRICHMENT_ALIASES } }, {},
    { sender_name: ENRICHMENT_ALIASES.union_id });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
  assertAliasSourcePreserved(before, after);
  const searches = enrichmentCalls(fixture.callsPath).filter(args => args[0] === "contact" && args[1] === "+search-user");
  assert.equal(searches.length, 1);
  assert.equal(searches[0][searches[0].indexOf("--user-ids") + 1], ENRICHMENT_ALIASES.open_id);
});

test("ordinary sender alias evidence preserves a genuine canonical sender_name without lookup", (t) => {
  const fixture = aliasEnrichmentFixture(t, {}, {}, { sender_name: ALIAS_PERSON });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
  assertAliasSourcePreserved(before, after);
  assert.deepEqual(enrichmentCalls(fixture.callsPath).map(args => args.slice(0, 2)), [["contact", "+get-user"]]);
});

for (const [aliasType, alias] of Object.entries(ENRICHMENT_ALIASES)) {
  for (const field of ["name", "display_name"]) {
    test(`ordinary sender alias ${aliasType} echoed in ${field} requires reliable open-ID enrichment`, (t) => {
      const fixture = aliasEnrichmentFixture(t, { [field]: alias });
      const before = readRecords(fixture.dbPath)[0];
      const result = runEnrichment(fixture);
      assert.equal(result.status, 0, result.stderr);
      const after = readRecords(fixture.dbPath)[0];
      const canonical = JSON.parse(after.canonical_json);
      assert.equal(canonical.sender_name, ALIAS_PERSON);
      assert.equal(canonical.sender_name_source, "contact");
      assertAliasSourcePreserved(before, after);
      const searches = enrichmentCalls(fixture.callsPath).filter(args => args[0] === "contact" && args[1] === "+search-user");
      assert.equal(searches.length, 1);
      assert.equal(searches[0][searches[0].indexOf("--user-ids") + 1], ENRICHMENT_ALIASES.open_id);
    });
  }
  test(`ordinary sender alias ${aliasType} in name falls through to a genuine display_name`, (t) => {
    const fixture = aliasEnrichmentFixture(t, { name: alias, display_name: ALIAS_PERSON });
    const before = readRecords(fixture.dbPath)[0];
    const result = runEnrichment(fixture);
    assert.equal(result.status, 0, result.stderr);
    const after = readRecords(fixture.dbPath)[0];
    assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
    assertAliasSourcePreserved(before, after);
    assert.deepEqual(enrichmentCalls(fixture.callsPath).map(args => args.slice(0, 2)), [["contact", "+get-user"]]);
  });
}

test("ordinary sender alias in nested typed sender_id resolves the matching stored actor through open_id", (t) => {
  const fixture = aliasEnrichmentFixture(t, { id: undefined, id_type: undefined, open_id: undefined,
    user_id: undefined, union_id: undefined, sender_id: { ...ENRICHMENT_ALIASES },
    name: ENRICHMENT_ALIASES.user_id });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
  assertAliasSourcePreserved(before, after);
  const searches = enrichmentCalls(fixture.callsPath).filter(args => args[0] === "contact" && args[1] === "+search-user");
  assert.equal(searches.length, 1);
  assert.equal(searches[0][searches[0].indexOf("--user-ids") + 1], ENRICHMENT_ALIASES.open_id);
});

for (const type of ["user_id", "union_id"]) {
  for (const nested of [false, true]) {
    test(`ordinary sender alias with only ${nested ? "nested " : ""}${type} never triggers an open-ID lookup`, (t) => {
      const evidence = { [type]: ENRICHMENT_ALIASES.open_id };
      const fixture = aliasEnrichmentFixture(t, { id: undefined, id_type: undefined,
        open_id: undefined, user_id: undefined, union_id: undefined,
        ...(nested ? { sender_id: evidence } : evidence) });
      const before = readRecords(fixture.dbPath)[0];
      const result = runEnrichment(fixture);
      assert.equal(result.status, 0, result.stderr);
      const after = readRecords(fixture.dbPath)[0];
      assert.equal(JSON.parse(after.canonical_json).sender_name, null);
      assertAliasSourcePreserved(before, after);
      assert.deepEqual(enrichmentCalls(fixture.callsPath).map(args => args.slice(0, 2)), [["contact", "+get-user"]]);
    });
  }
}

test("ordinary sender alias remains unknown through permission failure and can recover on the next run", (t) => {
  const fixture = aliasEnrichmentFixture(t,
    { name: ENRICHMENT_ALIASES.user_id, display_name: ENRICHMENT_ALIASES.union_id }, { denyLookups: true });
  const before = readRecords(fixture.dbPath)[0];
  const denied = runEnrichment(fixture);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(readRecords(fixture.dbPath)[0].canonical_json).sender_name, null);
  installFakeLarkCli(fixture.dir, { dbPath: fixture.dbPath, assertNoMaintenanceLock: true,
    contactUsers: [{ open_id: ENRICHMENT_ALIASES.open_id, name: ALIAS_PERSON }], callLogPath: fixture.callsPath });
  const recovered = runEnrichment(fixture);
  assert.equal(recovered.status, 0, recovered.stderr);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
  assertAliasSourcePreserved(before, after);
});

// These remote-alias counterexamples were added after the original 9b8e750
// RED capture; the remote item intentionally omits its alternate-ID fields.
test("ordinary sender remote alias contact echo falls back to a genuine member name", (t) => {
  const fixture = aliasEnrichmentFixture(t, {}, {
    contactUsers: [{ open_id: ENRICHMENT_ALIASES.open_id, name: ENRICHMENT_ALIASES.user_id }],
    memberItems: [{ member_id: ENRICHMENT_ALIASES.open_id, name: ALIAS_PERSON }],
  });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
  assert.equal(JSON.parse(after.canonical_json).sender_name_source, "chat_member");
  assertAliasSourcePreserved(before, after);
  assert.deepEqual(enrichmentCalls(fixture.callsPath).map(args => args.slice(0, 2)),
    [["contact", "+get-user"], ["contact", "+search-user"], ["im", "chat.members"]]);
});

test("ordinary sender remote alias contact and member echoes remain unwritten and recover next run", (t) => {
  const fixture = aliasEnrichmentFixture(t, {}, {
    contactUsers: [{ open_id: ENRICHMENT_ALIASES.open_id, name: ENRICHMENT_ALIASES.user_id }],
    memberItems: [{ member_id: ENRICHMENT_ALIASES.open_id, name: ENRICHMENT_ALIASES.union_id }],
  }, { sender_id_type: "open_id" });
  const before = readRecords(fixture.dbPath)[0];
  const unresolved = runEnrichment(fixture);
  assert.equal(unresolved.status, 0, unresolved.stderr);
  assert.equal(JSON.parse(unresolved.stdout).updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath)[0], before);
  assert.deepEqual(enrichmentCalls(fixture.callsPath).map(args => args.slice(0, 2)),
    [["contact", "+get-user"], ["contact", "+search-user"], ["im", "chat.members"]]);
  installFakeLarkCli(fixture.dir, { dbPath: fixture.dbPath, assertNoMaintenanceLock: true,
    contactUsers: [{ open_id: ENRICHMENT_ALIASES.open_id, name: ALIAS_PERSON }], callLogPath: fixture.callsPath });
  const recovered = runEnrichment(fixture);
  assert.equal(recovered.status, 0, recovered.stderr);
  const after = readRecords(fixture.dbPath)[0];
  assert.equal(JSON.parse(after.canonical_json).sender_name, ALIAS_PERSON);
  assertAliasSourcePreserved(before, after);
});

test("ordinary sender remote alias member echo remains unknown after an empty contact response", (t) => {
  const fixture = aliasEnrichmentFixture(t, {}, { contactUsers: [],
    memberItems: [{ member_id: ENRICHMENT_ALIASES.open_id, name: ENRICHMENT_ALIASES.user_id }],
  }, { sender_id_type: "open_id" });
  const before = readRecords(fixture.dbPath)[0];
  const result = runEnrichment(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updated, 0);
  assert.deepEqual(readRecords(fixture.dbPath)[0], before);
  assert.deepEqual(enrichmentCalls(fixture.callsPath).map(args => args.slice(0, 2)),
    [["contact", "+get-user"], ["contact", "+search-user"], ["im", "chat.members"]]);
});
