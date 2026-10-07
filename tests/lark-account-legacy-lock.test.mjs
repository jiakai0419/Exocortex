import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli } from "../bin/exocortex.mjs";
import { readRemoteAccountBinding } from "../src/diagnostics/remote-account-binding.mjs";
import { defaultOwnerState, quoteSql, recoverStaleSyncState, sqliteExec, sqliteQuery } from "../dist/storage/sqlite/ingestion-store.js";

// Recreate the old first-run window through real store calls: acquire a lock,
// but never create a run or reserve an account. Only test-owned children die.
// Profiles and all adapter responses are synthetic; no business API is called.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_URL = pathToFileURL(join(ROOT, "dist/storage/sqlite/ingestion-store.js")).href;
const START = "2026-01-01T00:00:00.000Z";
const END = "2026-01-01T00:05:00.000Z";
const SCOPE = "lark.im.sent_by_me";
const A = { open_id: "ou_synthetic_legacy_lock_a", name: "Invented Lock A" };
const B = { open_id: "ou_synthetic_legacy_lock_b", name: "Invented Lock B" };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-account-legacy-lock-"));
  const f = { dir, db: join(dir, "synthetic.sqlite"), profile: A, fetches: 0, allowFetch: false,
    unexpected: [], children: [] };
  f.sidecar = `${f.db}.remote-account-binding.json`;
  t.after(async () => {
    try {
      for (const { child, exited } of f.children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
      assert.deepEqual(f.unexpected, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return f;
}

function childSource(alive) {
  return `import assert from 'node:assert/strict';
    import { ensureInitialized, ensureSourceInitialSyncStart, acquireLock } from ${JSON.stringify(STORE_URL)};
    const db = process.argv[1];
    ensureInitialized(db);
    ensureSourceInitialSyncStart(db, 'lark.im', Date.parse(${JSON.stringify(START)}), { explicit: true });
    assert.equal(acquireLock(db, ${JSON.stringify(SCOPE)}, 600), true);
    ${alive ? "process.send({ ready: true }); setInterval(() => {}, 1000);" : "process.kill(process.pid, 'SIGKILL');"}`;
}

function leaveDeadLegacyLock(f) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource(false), f.db], {
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, "SIGKILL", result.stderr);
  assert.equal(result.stderr, "");
}

async function leaveLiveLegacyLock(f) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource(true), f.db], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => resolve({ error }));
  });
  f.children.push({ child, exited });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`synthetic lock child did not become ready: ${stderr}`)), 5_000);
    const finish = callback => value => { clearTimeout(timeout); callback(value); };
    child.once("message", finish(value => value?.ready === true ? resolve() : reject(new Error("unexpected child readiness"))));
    child.once("error", finish(reject));
    child.once("exit", finish(() => reject(new Error(`synthetic lock child exited before readiness: ${stderr}`))));
  });
  assert.equal(stderr, "");
}

function softExpire(f) {
  // Keep the acquired time inside the hard lease. A live owner must survive
  // an expired soft deadline; hard-lease reclamation has a different contract.
  const now = Date.now();
  sqliteExec(f.db, `UPDATE sync_locks SET locked_at=${quoteSql(new Date(now - 60_000).toISOString())},
    expires_at=${quoteSql(new Date(now - 1_000).toISOString())} WHERE scope_id=${quoteSql(SCOPE)};`);
}

const rows = (f, table) => sqliteQuery(f.db, `SELECT * FROM ${table} ORDER BY rowid;`);
function snapshot(f) {
  return { tables: Object.fromEntries(["sources", "sync_scopes", "sync_runs", "records", "sync_locks",
    "maintenance_locks", "lark_im_list_progress", "lark_im_detail_tasks"].map(table => [table, rows(f, table)])),
    sidecar: existsSync(f.sidecar) ? readFileSync(f.sidecar, "utf8") : null };
}
function assertLegacyWindow(f, state) {
  const locks = rows(f, "sync_locks");
  assert.equal(locks.length, 1); assert.equal(defaultOwnerState(locks[0].locked_by), state);
  assert.equal(rows(f, "sync_runs").length, 0); assert.equal(rows(f, "records").length, 0);
  assert.equal(rows(f, "sync_scopes").some(scope => scope.cursor_json !== null), false);
  const config = JSON.parse(rows(f, "sources").find(source => source.id === "lark.im").config_json);
  assert.equal(config.initial_sync_start_ms, Date.parse(START));
  assert.equal(config.initial_account_binding, undefined); assert.equal(existsSync(f.sidecar), false);
}

async function sync(f) {
  let stdout = "", stderr = "";
  const unexpected = name => () => { f.unexpected.push(name); assert.fail(`unexpected remote adapter: ${name}`); };
  const code = await runCli(["sync", "--db", f.db, "--scope", "sent", "--start", START, "--end", END], {
    root: ROOT, cwd: f.dir, env: {}, stdout: { write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } }, deps: {
      tryAcquireLarkApiLease: () => ({ state: "acquired", release() {} }),
      getSelfProfile: () => f.profile,
      syncRunnerDeps: {
        fetchSentMessageList: () => {
          if (!f.allowFetch) return unexpected("fetchSentMessageList")();
          f.fetches++; return { messages: [], detailRoots: [], pages: 1 };
        },
        fetchChatMessageList: unexpected("fetchChatMessageList"),
        fetchChatDiscoveryPage: unexpected("fetchChatDiscoveryPage"),
        fetchMessageDetails: unexpected("fetchMessageDetails"),
        buildPeopleContext: () => ({ self: f.profile }),
      },
    },
  });
  return { code, stderr, summary: stdout ? JSON.parse(stdout) : null };
}

for (const expired of [false, true]) {
  test(`first sync recovers a real dead legacy owner with ${expired ? "expired" : "unexpired"} soft lease before reserving the account`, async t => {
    const f = fixture(t); leaveDeadLegacyLock(f);
    if (expired) softExpire(f);
    assertLegacyWindow(f, "dead"); f.allowFetch = true;
    const result = await sync(f);
    assert.equal(result.code, 0, JSON.stringify(result)); assert.equal(result.stderr, "");
    assert.equal(f.fetches, 1); assert.equal(result.summary.sent.ok, true);
    assert.equal(rows(f, "sync_locks").length, 0);
    const runs = rows(f, "sync_runs"); assert.equal(runs.length, 1); assert.equal(runs[0].status, "succeeded");
    const binding = readRemoteAccountBinding({ db: f.db, selfOpenId: A.open_id });
    assert.equal(binding.state, "verified"); assert.equal(binding.evidence, "initialized_empty_database");
    assert.equal(readRemoteAccountBinding({ db: f.db, selfOpenId: B.open_id }).state, "conflict");
    const before = snapshot(f); f.profile = B; f.allowFetch = false;
    const rejected = await sync(f);
    assert.equal(rejected.code, 1); assert.match(rejected.summary.error.message, /account conflicts/);
    assert.equal(f.fetches, 1); assert.deepEqual(snapshot(f), before);
  });
}

for (const expired of [false, true]) {
  test(`first sync preserves a live legacy owner with ${expired ? "expired" : "unexpired"} soft lease and performs no fetch`, async t => {
    const f = fixture(t); await leaveLiveLegacyLock(f);
    if (expired) softExpire(f);
    assertLegacyWindow(f, "alive"); const before = snapshot(f);
    const result = await sync(f);
    assert.equal(result.code, 1); assert.equal(result.summary.error.code, "execution_failed");
    assert.equal(f.fetches, 0); assert.deepEqual(snapshot(f), before); assertLegacyWindow(f, "alive");
  });
}

test("a live owner replacing the observed dead legacy lease survives recovery CAS and still blocks first account reservation", async t => {
  const f = fixture(t); leaveDeadLegacyLock(f); assertLegacyWindow(f, "dead");
  const original = rows(f, "sync_locks")[0];
  const replacementOwner = `pid:${process.pid}:synthetic-replacement`;
  let observations = 0;
  const result = recoverStaleSyncState(f.db, { scopeId: SCOPE, ownerState: owner => {
    observations++; assert.equal(owner, original.locked_by); assert.equal(defaultOwnerState(owner), "dead");
    const now = Date.now();
    sqliteExec(f.db, `UPDATE sync_locks SET locked_by=${quoteSql(replacementOwner)},
      locked_at=${quoteSql(new Date(now).toISOString())}, expires_at=${quoteSql(new Date(now + 600_000).toISOString())}
      WHERE scope_id=${quoteSql(SCOPE)};`);
    return "dead";
  } });
  assert.equal(observations, 1);
  assert.deepEqual(result, { recovered_locks: 0, cancelled_runs: 0, active_expired_locks: 0 });
  assert.equal(rows(f, "sync_locks")[0].locked_by, replacementOwner);
  assertLegacyWindow(f, "alive"); const before = snapshot(f);
  const rejected = await sync(f);
  assert.equal(rejected.code, 1); assert.equal(rejected.summary.error.code, "execution_failed");
  assert.equal(f.fetches, 0); assert.deepEqual(snapshot(f), before);
});

test("first Lark account reservation does not recover a dead owner's lock belonging to another source", async t => {
  const f = fixture(t); leaveDeadLegacyLock(f);
  sqliteExec(f.db, `INSERT INTO sources(id,kind,display_name)
    VALUES('synthetic.other.source','test','Invented independent source');
    INSERT INTO sync_scopes(id,source_id,name,config_json)
    VALUES('synthetic.other.scope','synthetic.other.source','Invented independent scope','{}');
    UPDATE sync_locks SET scope_id='synthetic.other.scope' WHERE scope_id=${quoteSql(SCOPE)};`);
  assertLegacyWindow(f, "dead"); const before = snapshot(f);
  const result = await sync(f);
  assert.equal(result.code, 1); assert.equal(result.summary.error.code, "execution_failed");
  assert.equal(f.fetches, 0); assert.deepEqual(snapshot(f), before);
  assert.equal(rows(f, "sync_locks")[0].scope_id, "synthetic.other.scope");
});

test("an active maintenance lease preserves a simultaneous dead legacy sync lock before account reservation", async t => {
  const f = fixture(t); leaveDeadLegacyLock(f); softExpire(f);
  const now = Date.now();
  sqliteExec(f.db, `INSERT INTO maintenance_locks(name,owner,acquired_at,expires_at,reason)
    VALUES('global',${quoteSql(`pid:${process.pid}:synthetic-maintenance`)},
      ${quoteSql(new Date(now).toISOString())},${quoteSql(new Date(now + 600_000).toISOString())},
      'Invented maintenance lease with a legacy dead sync lock');`);
  assertLegacyWindow(f, "dead"); const before = snapshot(f);
  const result = await sync(f);
  assert.equal(result.code, 1); assert.equal(result.summary.error.code, "execution_failed");
  assert.equal(f.fetches, 0); assert.deepEqual(snapshot(f), before);
  assert.equal(rows(f, "sync_locks").length, 1); assert.equal(rows(f, "maintenance_locks").length, 1);
});
