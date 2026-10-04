import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeDatabase } from "../dist/storage/sqlite/initialize.js";
import { executeSqliteMaintenance, readDatabaseEvidence, verifyBackupEvidence } from "../src/storage/sqlite/maintenance.mjs";
import { executeEnrichment } from "../src/maintenance/enrich.mjs";
import { runMaintenanceCommand } from "../src/cli/maintenance-command.mjs";
import { createCommandContext } from "../src/cli/context.mjs";
import { parseRouteOptions } from "../src/cli/registry.mjs";

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),"exocortex-cli-maintenance-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,"source","invented.sqlite"); initializeDatabase(db);
  return {root,db,backupDir:join(root,"backups"), backup:null,latest:false,format:"json",dryRun:true,backupKeepCount:7,backupKeepDays:30};
}
const io=()=>{let value="";return{write:text=>{value+=text;},text:()=>value};};

test("compact defaults to a permissions-preserving local preview and never acquires a lock",(t)=>{
  const f=fixture(t);chmodSync(f.db,0o644);const before=readFileSync(f.db);
  const report=executeSqliteMaintenance({...f,action:"compact"},{acquireMaintenanceLock(){assert.fail("preview must not acquire");}});
  assert.equal(report.dry_run,true);assert.equal(report.ok,true);
  assert.deepEqual(readFileSync(f.db),before);assert.equal(statSync(f.db).mode&0o777,0o644);
});

for(const sourceState of ["missing","corrupt"]){
  test(`explicit backup validation continues independently of a ${sourceState} source`,(t)=>{
    const f=fixture(t);const created=executeSqliteMaintenance({...f,action:"backup"},{cwd:f.root});
    const backup=join(f.root,created.backup_path);
    if(sourceState==="missing")rmSync(f.db);else writeFileSync(f.db,"invented invalid database");
    assert.throws(()=>readDatabaseEvidence(f.db));
    const checked=verifyBackupEvidence({...f,backup},{cwd:f.root});
    assert.equal(checked.ok,true);assert.equal(checked.ownership,"matched");
    const latest=verifyBackupEvidence({...f,latest:true},{cwd:f.root});
    assert.equal(latest.ok,true);assert.equal(latest.ownership,"matched");
    const wrong=verifyBackupEvidence({...f,db:join(f.root,"other-invented.sqlite"),backup},{cwd:f.root});
    assert.equal(wrong.ok,false);assert.equal(wrong.ownership,"mismatch");
    const path=`${backup}.manifest.json`,legacy=JSON.parse(readFileSync(path,"utf8"));
    legacy.kind="exocortex.sqlite-backup-manifest/v1";delete legacy.source_db_id;writeFileSync(path,JSON.stringify(legacy));
    const independent=verifyBackupEvidence({...f,backup},{cwd:f.root});
    assert.equal(independent.ok,true);assert.equal(independent.ownership,"unknown");
    assert.throws(()=>verifyBackupEvidence({...f,latest:true},{cwd:f.root}),/no owned SQLite backups/);
  });
}

for(const [target,limit] of [["records",1000],["scopes",50]]){
  test(`enrich ${target} defaults to preview with its own limit and requires apply for writes`,()=>{
    const calls=[];const deps={enrichRecords:opts=>{calls.push(opts);return{ok:true,updated:0};},enrichScopes:opts=>{calls.push(opts);return{ok:true,updated:0};},runLark(){assert.fail("domain fake must avoid remote");}};
    executeEnrichment({target,db:"synthetic.sqlite"},deps);executeEnrichment({target,db:"synthetic.sqlite",apply:true},deps);
    assert.deepEqual(calls.map(x=>[x.limit,x.dryRun]),[[limit,true],[limit,false]]);
  });
}

test("enrichment validates target-specific flags before any remote request; unsafe details are explicitly private",()=>{
  let calls=0;const deps={enrichRecords:opts=>{calls++;return{ok:true,unsafe_details:{invented:true}};},runLark(){assert.fail("unexpected remote");}};
  for(const opts of [{},{target:"all"},{target:"scopes",probeApps:true},{target:"scopes",unsafeDetails:true},{target:"records",senderOnly:true},{target:"records",senderOnly:true,senderId:"ou_invented",limit:101}]){
    assert.throws(()=>executeEnrichment(opts,deps));
  }
  assert.equal(calls,0);
  assert.equal(executeEnrichment({target:"records",unsafeDetails:true},deps).output_sensitivity,"private");
});

test("the common enrichment transport caps each lookup at five seconds and preserves a shorter deadline", () => {
  const calls = [];
  executeEnrichment({ target: "records", db: "synthetic.sqlite" }, {
    runLark(args, settings) { calls.push({ args, settings }); return {}; },
    enrichRecords(_options, { runLark }) {
      runLark(["invented", "default"]);
      runLark(["invented", "long"], { timeoutMs: 30_000, retryBudgetMs: 60_000, retries: 3 });
      runLark(["invented", "short"], { timeoutMs: 400, retryBudgetMs: 250 });
      return { ok: true, updated: 0 };
    },
  });
  assert.deepEqual(calls.map(({ settings }) => [settings.timeoutMs, settings.retryBudgetMs, settings.retries]), [
    [5_000, 5_000, 0], [5_000, 5_000, 0], [400, 250, 0],
  ]);
});

test("replay adapter requires explicit DB independently of the shared default path",()=>{
  const out=io(),err=io();const context=createCommandContext({stdout:out,stderr:err,provided:new Set(),deps:{executeLarkImReplay(){assert.fail("must validate first");}}});
  assert.equal(runMaintenanceCommand({action:"replay",db:"synthetic.sqlite"},context),1);
  assert.match(err.text(),/explicit --db/);assert.equal(out.text(),"");
});

test("shared maintenance routes expose preview/apply only where supported",()=>{
  for(const action of ["repair","prune-runs","compact"]){assert.equal(parseRouteOptions(`maintenance.${action}`,[]).options.apply,false);}
  for(const action of ["init","backup"]){assert.throws(()=>parseRouteOptions(`maintenance.${action}`,["--apply"]));}
});

test("a database without the required schema reports execution failure before any maintenance write", (t) => {
  const f = fixture(t);
  const db = join(f.root, "unsupported.sqlite");
  const created = spawnSync("sqlite3", [db, "CREATE TABLE synthetic_marker (value TEXT);"], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const before = readFileSync(db);
  const mode = statSync(db).mode;
  for (const action of ["backup", "prune-runs", "compact"]) {
    for (const apply of action === "backup" ? [false] : [false, true]) {
      const stdout = io(), stderr = io();
      const context = createCommandContext({ root: f.root, stdout, stderr,
        deps: { acquireMaintenanceLock() { assert.fail("invalid schema must not acquire a write lock"); } } });
      const code = runMaintenanceCommand({ action, db, apply, format: "json" }, context);
      assert.equal(code, 1, action);
      assert.equal(JSON.parse(stdout.text()).status, "failed");
      assert.equal(stderr.text(), "");
      assert.deepEqual(readFileSync(db), before);
      assert.equal(statSync(db).mode, mode);
      assert.equal(existsSync(join(f.root, "backups")), false);
    }
  }
});
