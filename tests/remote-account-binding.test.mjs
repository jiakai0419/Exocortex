import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureRemoteAccountBinding, readRemoteAccountBinding, recordSuccessfulSyncBinding } from "../src/diagnostics/remote-account-binding.mjs";
import { runLarkImSyncCli } from "./helpers/sync-command.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-binding-synthetic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "synthetic.sqlite");
  const sql = (input) => {
    const result = spawnSync("sqlite3", [db], { encoding: "utf8", input });
    assert.equal(result.status, 0, result.stderr);
  };
  sql(`CREATE TABLE records(source_id TEXT, direction TEXT, actor_id TEXT, canonical_json TEXT);
    CREATE TABLE sync_runs(source_id TEXT);
    CREATE TABLE sync_scopes(source_id TEXT, cursor_json TEXT);`);
  return { db, sql, sidecar: `${db}.remote-account-binding.json` };
}
const self = "ou_synthetic_self";

test("a current profile alone cannot bind an existing received-only database", (t) => {
  const f = fixture(t); f.sql("INSERT INTO records VALUES('lark.im','received','ou_synthetic_other',NULL);");
  const before = captureRemoteAccountBinding(f);
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).state, "unverified");
  assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), false);
  assert.equal(existsSync(f.sidecar), false);
});

test("single stored sent actor is named evidence; mismatch or mixed actors conflict", (t) => {
  const f = fixture(t); f.sql(`INSERT INTO records VALUES('lark.im','sent','${self}','{"sender_id":"${self}","sender_id_type":"open_id"}');`);
  const original = readFileSync(f.db);
  const evidence = readRemoteAccountBinding({ ...f, selfOpenId: self });
  assert.equal(evidence.state, "verified"); assert.equal(evidence.evidence, "single_sent_actor");
  assert.equal(evidence.tenant_verified, false);
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self, selfTenantKey: "synthetic_tenant" }).account_key, evidence.account_key);
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: "ou_synthetic_other" }).state, "conflict");
  assert.deepEqual(readFileSync(f.db), original);
  assert.equal(existsSync(f.sidecar), false);
  f.sql("INSERT INTO records VALUES('lark.im','sent','ou_synthetic_other',NULL);");
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).state, "conflict");
});

test("canonical identity conflict cannot be hidden by matching actor_id", (t) => {
  const f = fixture(t); f.sql(`INSERT INTO records VALUES('lark.im','sent','${self}','{"sender_id":"ou_synthetic_other"}');`);
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).state, "conflict");
});

test("only success from a previously empty source creates a private durable binding", (t) => {
  const f = fixture(t), before = captureRemoteAccountBinding(f);
  assert.equal(before.empty, true);
  assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: false }), false);
  f.sql("INSERT INTO records VALUES('lark.im','received','ou_synthetic_other',NULL);");
  assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), true);
  assert.equal(statSync(f.sidecar).mode & 0o777, 0o600);
  const contents = readFileSync(f.sidecar, "utf8");
  assert.doesNotMatch(contents, /ou_synthetic|synthetic.sqlite/);
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).evidence, "initialized_empty_database");
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: "ou_synthetic_other" }).state, "conflict");
});

test("prior empty sync runs and cursors are not a fresh database", (t) => {
  for (const table of ["sync_runs", "sync_scopes"]) {
    const f = fixture(t); f.sql(table === "sync_runs" ? "INSERT INTO sync_runs VALUES('lark.im');" : "INSERT INTO sync_scopes VALUES('lark.im','{}');");
    const before = captureRemoteAccountBinding(f);
    assert.equal(before.empty, false);
    assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), false);
  }
});

test("database replacement rejects stale empty snapshots and retained sidecars", (t) => {
  const f = fixture(t), before = captureRemoteAccountBinding(f);
  assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), true);
  const bytes = readFileSync(f.db);
  renameSync(f.db, `${f.db}.old`); writeFileSync(f.db, bytes);
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).reason, "binding_database_changed");
  rmSync(f.sidecar);
  assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), false);
});

test("damaged binding and unavailable read evidence fail closed", (t) => {
  const f = fixture(t);
  writeFileSync(f.sidecar, "not-json");
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).state, "unavailable");
  assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }, { query: () => { throw new Error("private"); } }).reason, "database_evidence_unavailable");
  assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before: captureRemoteAccountBinding(f), successful: true }), false);
});

test("CLI acquires before initialization/API, refuses contention and always releases", () => {
  for (const fail of [false, true]) {
    const calls = [];
    const code = runLarkImSyncCli(["--scope", "sent"], {
      stdout: { write() {} }, stderr: { write() {} }, deps: {
        tryAcquireLarkApiLease: () => { calls.push("acquire"); return { state: "acquired", release() { calls.push("release"); } }; },
        ensureInitialized: () => calls.push("initialize"), ensureSourceInitialSyncStart: (_db, _source, ms) => ms,
        captureRemoteAccountBinding: () => null,
        getSelfProfile: () => { calls.push("profile"); if (fail) throw new Error("synthetic failure"); return { open_id: self, name: "Synthetic" }; },
        syncRunner: { syncSent: () => { calls.push("sync"); return { ok: true }; } },
      },
    });
    assert.equal(code, fail ? 1 : 0);
    assert.deepEqual(calls, fail ? ["acquire", "initialize", "profile", "release"] : ["acquire", "initialize", "profile", "sync", "release"]);
  }
  const code = runLarkImSyncCli(["--scope", "sent"], {
    stdout: { write() {} }, stderr: { write() {} }, deps: {
      tryAcquireLarkApiLease: () => ({ state: "busy", release() {} }),
      ensureInitialized: () => assert.fail("busy lease must precede all initialization and API work"),
    },
  });
  assert.equal(code, 1);
});

test("sync persists new binding only after an actual successful non-skipped run", () => {
  for (const result of [{ ok: true }, { ok: false }, { ok: true, skipped: true }, { skipped: true }]) {
    const observed = [];
    const before = { database_key: "a".repeat(64), empty: true };
    runLarkImSyncCli(["--scope", "sent"], {
      stdout: { write() {} }, stderr: { write() {} }, deps: {
        ensureInitialized: () => {}, ensureSourceInitialSyncStart: (_db, _source, ms) => ms,
        captureRemoteAccountBinding: (options) => { assert.equal(options.emptyOnly, true); return before; },
        getSelfProfile: () => ({ open_id: self, name: "Synthetic" }),
        syncRunner: { syncSent: () => result },
        recordSuccessfulSyncBinding: (options) => { observed.push(options); return options.successful; },
      },
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].before, before);
    assert.equal(observed[0].selfOpenId, self);
    assert.equal(observed[0].successful, result.ok === true && result.skipped !== true);
  }
});


test("binding rejects writable, multiply linked, and future evidence before accepting a matching hash", (t) => {
  for (const mutation of ['permissions', 'hardlink', 'future', 'invalid_time']) {
    const f = fixture(t), before = captureRemoteAccountBinding(f);
    assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), true);
    if (mutation === 'permissions') chmodSync(f.sidecar, 0o666);
    if (mutation === 'hardlink') linkSync(f.sidecar, `${f.sidecar}.linked`);
    if (mutation === 'future' || mutation === 'invalid_time') {
      const value = JSON.parse(readFileSync(f.sidecar, 'utf8'));
      value.bound_at = mutation === 'future' ? new Date(Date.now() + 86400000).toISOString() : '2030-01-01';
      writeFileSync(f.sidecar, JSON.stringify(value));
    }
    assert.equal(readRemoteAccountBinding({ ...f, selfOpenId: self }).state, 'unavailable', mutation);
    assert.equal(recordSuccessfulSyncBinding({ ...f, selfOpenId: self, before, successful: true }), false, mutation);
  }
});
