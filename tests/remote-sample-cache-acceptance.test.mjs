import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { activityDatabaseKey } from '../src/diagnostics/lark-im-activity-evidence.mjs';
import { liveProbeContext } from '../src/diagnostics/live-probe-cache.mjs';
import { parseRemoteSampleCache, writeRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { SAMPLE_POLICY } from '../src/diagnostics/remote-sample-core.mjs';
import { remoteSamplePaths } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { startOwnedProcess, waitForPidsToExit, waitUntil } from './helpers/owned-process.mjs';

// Real processes and kernel locks, exclusively on invented files in a private
// temporary tree. Workers never open SQLite or invoke a collector/business API.
// Each case has one ten-second deadline, including exit and lock observations.
// Fixture fallback is twenty seconds, so natural fallback cannot make a failed
// cleanup pass. A first failure stops later cases and retains its evidence.
const URLS = Object.fromEntries(Object.entries({
  schedulerURL: '../src/runtime/worker/remote-sample-scheduler.mjs',
  processURL: '../src/runtime/worker/remote-sample-process.mjs',
  anchorURL: '../src/runtime/worker/remote-sample-anchor.mjs',
  leaseURL: '../src/runtime/lark-api-lease.mjs',
  cacheURL: '../src/diagnostics/remote-sample-cache.mjs',
  policyURL: '../src/diagnostics/remote-sample-core.mjs',
}).map(([key, path]) => [key, new URL(path, import.meta.url).href]));
const FLOCK_PATH = fileURLToPath(new URL('../src/runtime/lark-api-flock.py', import.meta.url));

const CALLER_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
const {runManualRemoteSample}=await import(cfg.schedulerURL);
const {REMOTE_SAMPLE_GUARDIAN}=await import(cfg.processURL);
const {REMOTE_SAMPLE_ANCHOR}=await import(cfg.anchorURL);
const record=(path,value)=>{writeFileSync(path+'.pending',JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(path+'.pending',path);};
record(cfg.callerRecord,{pid:process.pid,ppid:process.ppid,nonce:cfg.nonce,role:'caller'});
function trace(source,path,role){
  return 'import os,json\n_synthetic_fd=os.open('+JSON.stringify(path)+',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nos.write(_synthetic_fd,json.dumps({"pid":os.getpid(),"ppid":os.getppid(),"nonce":'+JSON.stringify(cfg.nonce)+',"role":'+JSON.stringify(role)+'}).encode("ascii"))\nos.close(_synthetic_fd)\n'+source;
}
let outer=null,publication=null;
const result=runManualRemoteSample({db:cfg.db,logDir:cfg.logDir,remoteSampleIntervalSeconds:900},{
  pythonPath:cfg.pythonPath,scriptPath:cfg.mode==='startup_failure'?cfg.missingWorkerPath:cfg.workerPath,timeoutMs:6000,
  spawnSync(command,args,options){
    publication=JSON.parse(options.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION);
    record(cfg.precheckRecord,{nonce:cfg.nonce,publication});
    if(cfg.parentGate){
      const until=performance.now()+20000;
      while(!existsSync(cfg.parentGate)){
        if(performance.now()>=until)throw Error('synthetic_parent_gate_timeout');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      }
    }
    const index=args.indexOf(REMOTE_SAMPLE_GUARDIAN);
    assert.ok(index>=0,'actual public helper must launch the guardian');
    const declaration='ANCHOR_CODE='+JSON.stringify(REMOTE_SAMPLE_ANCHOR);
    assert.equal(REMOTE_SAMPLE_GUARDIAN.split(declaration).length,2,'one anchor declaration');
    const withAnchor=REMOTE_SAMPLE_GUARDIAN.replace(declaration,'ANCHOR_CODE='+JSON.stringify(trace(REMOTE_SAMPLE_ANCHOR,cfg.anchorRecord,'anchor')));
    const traced=[...args];traced[index]=trace(withAnchor,cfg.guardianRecord,'guardian');
    const child=spawnSync(command,traced,options);
    outer={pid:child.pid,status:child.status,signal:child.signal,error_code:child.error?.code||null};
    return child;
  },
});
process.stdout.write(JSON.stringify({result,outer,publication}));
`;

const WORKER_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
const cfg=JSON.parse(readFileSync(process.env.EXO_SYNTHETIC_CACHE_CONFIG,'utf8'));
const {writeRemoteSampleCache}=await import(cfg.cacheURL);
const {writeRemoteSampleState}=await import(cfg.schedulerURL);
const {SAMPLE_POLICY}=await import(cfg.policyURL);
const {tryAcquireLarkApiLease}=await import(cfg.leaseURL);
const record=(path,value)=>{writeFileSync(path+'.pending',JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(path+'.pending',path);};
record(cfg.workerRecord,{pid:process.pid,ppid:process.ppid,nonce:cfg.nonce,role:'worker'});
const input=JSON.parse(readFileSync(0,'utf8'));
const publication=JSON.parse(process.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION);
assert.deepEqual(publication,input.publication);
assert.equal(input.db,cfg.db);assert.equal(input.logDir,cfg.logDir);
assert.equal(publication.statePath,cfg.statePath);assert.equal(publication.lockPath,cfg.scheduleLock);
let lease;
if(cfg.workerGate){
  const helpers=[];
  lease=tryAcquireLarkApiLease({role:'probe'},{directory:cfg.apiDirectory,spawnSync(_command,args,options){
    const child=spawnSync(cfg.pythonPath,args,options);helpers.push({pid:child.pid,status:child.status,signal:child.signal,error_code:child.error?.code||null});return child;
  }});
  record(cfg.leaseRecord,{nonce:cfg.nonce,state:lease.state,helpers});
  assert.equal(lease.state,'acquired','synthetic worker private API lease');
  const until=performance.now()+20000;
  while(!existsSync(cfg.workerGate)){
    if(performance.now()>=until)throw Error('synthetic_worker_gate_timeout');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
}
const now=Date.now(),end=now-SAMPLE_POLICY.stableBufferMs;
const report={status:'inconclusive',ok:false,reason:'no_eligible_chats',checked_at:new Date(now).toISOString(),
  window:{start:new Date(end-SAMPLE_POLICY.windowMs).toISOString(),end:new Date(end).toISOString()},probe:{},findings:{},binding:{state:'unverified'}};
if(cfg.mode!=='missing_stage'){
  writeRemoteSampleState(publication.statePath,{kind:'lark_im_remote_sample_schedule/v1',database_key:cfg.databaseKey,
    account_key:null,written_at:now,next_due:now+900000,failures:0,rotation:1,observations:{},last_outcome:'ok',cooldowns:{},blocked_reason:null},now);
  writeRemoteSampleCache(publication.stagePath,{report,cacheContext:cfg.cacheContext});
}
lease?.release();
// A missing-stage worker deliberately claims success. The guardian, not this
// untrusted payload, must reject publication when the private stage is absent.
process.stdout.write(JSON.stringify({outcome:'ok',reason:'sampled',next_due:now+900000,cooldownsByOperation:{},
  cachePrepared:true,cacheWritten:true,report}));
`;

const LOCK_CHECK_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
const cfg=JSON.parse(readFileSync(process.argv[2],'utf8'));
const {tryAcquireLarkApiLease}=await import(cfg.leaseURL);
const helpers=[];
function run(_command,args,options){
  const child=spawnSync(cfg.pythonPath,args,{...options,timeout:Math.min(options.timeout||1000,1000)});
  helpers.push({pid:child.pid,status:child.status,signal:child.signal,error_code:child.error?.code||null});return child;
}
const lease=tryAcquireLarkApiLease({role:'probe'},{directory:cfg.apiDirectory,spawnSync:run});
assert.equal(lease.state,'acquired','private API flock must be available exactly once');
lease.release();
// Open the exact scheduler lock, not a fresh api.lock in the schedule folder.
const fd=openSync(cfg.scheduleLock,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
try{
  const info=fstatSync(fd);assert.ok(info.isFile()&&(info.mode&0o077)===0&&info.uid===process.getuid()&&info.nlink===1);
  const child=run(cfg.pythonPath,['-B',cfg.flockPath],{stdio:['ignore','ignore','ignore',fd],timeout:1000,killSignal:'SIGKILL'});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,'exact schedule flock must be available exactly once');
}finally{closeSync(fd);}
process.stdout.write(JSON.stringify({api_reacquired:true,schedule_reacquired:true,helpers}));
`;

function privateJson(path, value) { writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' }); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function pythonPath() {
  const candidates = process.env.EXOCORTEX_SYNTHETIC_PYTHON ? [process.env.EXOCORTEX_SYNTHETIC_PYTHON]
    : (process.env.PATH || '').split(delimiter).filter(Boolean).map(path => join(path, 'python3'));
  const candidate = candidates.find(path => isAbsolute(path) && existsSync(path));
  assert.ok(candidate, 'an absolute Python 3 executable is required for synthetic cache acceptance');
  return realpathSync(candidate);
}
function caseFixture(name) {
  const root = mkdtempSync(join(tmpdir(), 'exo-synthetic-cache-acceptance-'));
  const logDir = join(root, 'logs'); mkdirSync(logDir, { mode: 0o700 });
  const apiDirectory = join(root, 'api-lease'); mkdirSync(apiDirectory, { mode: 0o700 });
  const callerPath = join(root, 'caller.mjs'), workerPath = join(root, 'worker.mjs'), lockCheckPath = join(root, 'locks.mjs');
  writeFileSync(callerPath, CALLER_SOURCE, { mode: 0o600 });
  writeFileSync(workerPath, WORKER_SOURCE, { mode: 0o600 });
  writeFileSync(lockCheckPath, LOCK_CHECK_SOURCE, { mode: 0o600 });
  const py = pythonPath();
  return { name, root, logDir, apiDirectory, callerPath, workerPath, lockCheckPath, pythonPath: py,
    deadline: performance.now() + 10000, owned: [], attempts: [], observed: [],
    env: { PATH: [dirname(py), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: root, TMPDIR: root } };
}
function database(f, label) {
  const path = join(f.root, `${label}.sqlite`);
  writeFileSync(path, 'synthetic identity file; not a SQLite database\n', { mode: 0o600, flag: 'wx' });
  return path;
}
function attempt(f, label, db, overrides = {}) {
  const directory = join(f.root, label); mkdirSync(directory, { mode: 0o700 });
  const databaseKey = activityDatabaseKey(db); assert.match(databaseKey || '', /^[a-f0-9]{64}$/);
  const paths = remoteSamplePaths(f.logDir, databaseKey);
  const cfg = { ...URLS, nonce: randomUUID(), db, databaseKey, logDir: f.logDir, apiDirectory: f.apiDirectory,
    scheduleLock: paths.lock, statePath: paths.state, cacheContext: liveProbeContext(db), pythonPath: f.pythonPath,
    workerPath: f.workerPath, missingWorkerPath: join(directory, 'does-not-exist.mjs'), mode: 'success',
    callerRecord: join(directory, 'caller.json'), guardianRecord: join(directory, 'guardian.json'), anchorRecord: join(directory, 'anchor.json'),
    workerRecord: join(directory, 'worker.json'), precheckRecord: join(directory, 'precheck.json'), leaseRecord: join(directory, 'lease.json'), ...overrides };
  const configPath = join(directory, 'config.json'); privateJson(configPath, cfg);
  const handle = startOwnedProcess(process.execPath, [f.callerPath, configPath], { deadline: f.deadline, env: { ...f.env, EXO_SYNTHETIC_CACHE_CONFIG: configPath } });
  const value = { cfg, handle }; f.attempts.push(value); f.owned.push(handle); return value;
}
async function completed(handle) {
  const result = await handle.result;
  assert.equal(result.failure, null, `owned process failed: ${result.failure}; signal=${result.signalError}`);
  assert.equal(result.signalError, null); assert.equal(result.signalAttempted, false, 'passing cases cannot use the outer watchdog');
  assert.equal(result.signal, null); assert.equal(result.code, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}
function record(f, item, path, role, expectedParent) {
  const value = readJson(path);
  assert.equal(value.nonce, item.cfg.nonce); assert.equal(value.role, role);
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  if (expectedParent !== undefined) assert.equal(value.ppid, expectedParent);
  f.observed.push(value.pid); return value;
}
function traceAttempt(f, item, output, { guardian = true, anchor = true, worker = true } = {}) {
  const caller = record(f, item, item.cfg.callerRecord, 'caller', process.pid);
  assert.equal(caller.pid, item.handle.child.pid);
  assert.ok(Number.isSafeInteger(output.outer?.pid) && output.outer.pid > 0);
  assert.equal(output.outer.error_code, null); assert.equal(output.outer.signal, null);
  f.observed.push(output.outer.pid);
  if (guardian) {
    const outer = record(f, item, item.cfg.guardianRecord, 'guardian', caller.pid);
    assert.equal(outer.pid, output.outer.pid, 'exec wrapper and guardian retain one owned PID');
    if (anchor) {
      const inner = record(f, item, item.cfg.anchorRecord, 'anchor', outer.pid);
      assert.notEqual(inner.pid, outer.pid);
      if (worker) record(f, item, item.cfg.workerRecord, 'worker', inner.pid);
      else assert.equal(existsSync(item.cfg.workerRecord), false);
    } else {
      assert.equal(existsSync(item.cfg.anchorRecord), false); assert.equal(existsSync(item.cfg.workerRecord), false);
    }
  } else {
    assert.equal(existsSync(item.cfg.guardianRecord), false); assert.equal(existsSync(item.cfg.anchorRecord), false);
    assert.equal(existsSync(item.cfg.workerRecord), false);
  }
  if (existsSync(item.cfg.leaseRecord)) {
    const lease = readJson(item.cfg.leaseRecord); assert.equal(lease.nonce, item.cfg.nonce); assert.equal(lease.state, 'acquired');
    for (const helper of lease.helpers) { assert.equal(helper.status, 0); assert.equal(helper.signal, null); assert.equal(helper.error_code, null); f.observed.push(helper.pid); }
  }
}
function seedHealthy(f, db) {
  const now = Date.now(), end = now - SAMPLE_POLICY.stableBufferMs;
  const report = { status: 'healthy', ok: true, reason: null, checked_at: new Date(now).toISOString(),
    window: { start: new Date(end - SAMPLE_POLICY.windowMs).toISOString(), end: new Date(end).toISOString() },
    binding: { state: 'verified', evidence: 'single_sent_actor' },
    probe: { hot_chats_requested: 1, hot_chats_found: 1, eligible_chats: 1, hot_chats: 1, fair_chats: 0,
      chats_checked: 1, pages: 1, messages_per_chat: 20, remote_messages_checked: 1, api_calls: 3 },
    findings: { present: 1, content_equal: 1 } };
  const cachePath = join(f.logDir, 'live-probe.json');
  writeRemoteSampleCache(cachePath, { report, cacheContext: { ...liveProbeContext(db), account_key: 'a'.repeat(64), auth_identity_verified: true } });
  const value = readJson(cachePath); assert.equal(parseRemoteSampleCache(value)?.ok, true, 'fictional seed must be a structurally valid healthy cache');
  return snapshot(cachePath);
}
function snapshot(path) {
  const bytes = readFileSync(path), value = JSON.parse(bytes), info = statSync(path);
  return { bytes, expires_at: value.expires_at, checked_at: value.checked_at, mtimeMs: info.mtimeMs };
}
function unchanged(path, before) {
  const after = snapshot(path); assert.deepEqual(after.bytes, before.bytes);
  assert.equal(after.expires_at, before.expires_at); assert.equal(after.checked_at, before.checked_at); assert.equal(after.mtimeMs, before.mtimeMs);
}
async function verifyReleased(f) {
  await waitForPidsToExit(f.observed, f.deadline);
  const scheduleLock = f.attempts[0].cfg.scheduleLock;
  const path = join(f.root, 'lock-check.json');
  privateJson(path, { ...URLS, apiDirectory: f.apiDirectory, scheduleLock, pythonPath: f.pythonPath, flockPath: FLOCK_PATH });
  const handle = startOwnedProcess(process.execPath, [f.lockCheckPath, path], { deadline: f.deadline, env: f.env });
  f.owned.push(handle);
  const result = await completed(handle);
  assert.equal(result.api_reacquired, true); assert.equal(result.schedule_reacquired, true); assert.equal(result.helpers.length, 2);
  const pids = [handle.child.pid];
  for (const helper of result.helpers) { assert.equal(helper.status, 0); assert.equal(helper.signal, null); assert.equal(helper.error_code, null); pids.push(helper.pid); }
  await waitForPidsToExit(pids, f.deadline);
}

const CASES = [
  ['worker startup failure invalidates a previously healthy cache', async f => {
    const db = database(f, 'db'), before = seedHealthy(f, db);
    const item = attempt(f, 'startup', db, { mode: 'startup_failure' });
    const output = await completed(item.handle);
    assert.equal(output.result.outcome, 'failed'); assert.equal(output.result.reason, 'sample_process_failed');
    assert.equal(output.result.guardian_diagnostic?.primary?.stage, 'child_exit');
    traceAttempt(f, item, output, { worker: false });
    const cachePath = join(f.logDir, 'live-probe.json'), marker = readJson(cachePath);
    assert.equal(marker.kind, 'lark_im_live_probe_cache/pending'); assert.equal(marker.ok, false); assert.equal(marker.reason, 'attempting');
    assert.equal(parseRemoteSampleCache(marker), null); assert.equal(marker.expires_at, undefined);
    assert.notDeepEqual(readFileSync(cachePath), before.bytes); assert.equal(existsSync(output.publication.stagePath), false);
  }],
  ['successful worker without a stage cannot publish or renew healthy evidence', async f => {
    const db = database(f, 'db'), before = seedHealthy(f, db);
    const item = attempt(f, 'missing-stage', db, { mode: 'missing_stage' });
    const output = await completed(item.handle);
    assert.equal(output.result.outcome, 'failed'); assert.equal(output.result.reason, 'sample_process_failed');
    assert.equal(output.result.guardian_diagnostic?.primary?.stage, 'guardian_result');
    traceAttempt(f, item, output);
    const cachePath = join(f.logDir, 'live-probe.json'), marker = readJson(cachePath);
    assert.equal(marker.kind, 'lark_im_live_probe_cache/pending'); assert.equal(marker.ok, false); assert.equal(marker.reason, 'attempting');
    assert.equal(parseRemoteSampleCache(marker), null); assert.equal(marker.expires_at, undefined);
    assert.notDeepEqual(readFileSync(cachePath), before.bytes); assert.equal(existsSync(output.publication.stagePath), false);
  }],
  ['same database stale parent precheck preserves committed bytes and TTL under the lock', async f => {
    const db = database(f, 'db'), parentGate = join(f.root, 'release-parent-b');
    seedHealthy(f, db);
    const b = attempt(f, 'b', db, { parentGate });
    await waitUntil(() => existsSync(b.cfg.precheckRecord), f.deadline, 'stale_parent_precheck');
    assert.equal(existsSync(b.cfg.guardianRecord), false, 'B is paused after the parent precheck and before actual spawn');
    const a = attempt(f, 'a', db), aOutput = await completed(a.handle);
    assert.equal(aOutput.result.outcome, 'ok'); assert.equal(aOutput.result.cacheWritten, true);
    traceAttempt(f, a, aOutput);
    const cachePath = join(f.logDir, 'live-probe.json'), committed = snapshot(cachePath);
    assert.ok(parseRemoteSampleCache(readJson(cachePath))); assert.ok(Date.parse(committed.expires_at) > Date.now());
    const due = readJson(a.cfg.statePath).next_due;
    privateJson(parentGate, { release: true });
    const bOutput = await completed(b.handle);
    assert.equal(bOutput.result.outcome, 'not_due'); assert.equal(bOutput.result.reason, 'not_due'); assert.equal(bOutput.result.next_due, due);
    traceAttempt(f, b, bOutput, { anchor: false });
    assert.equal(aOutput.publication.statePath, bOutput.publication.statePath);
    assert.notEqual(aOutput.publication.stagePath, bOutput.publication.stagePath);
    unchanged(cachePath, committed); assert.equal(existsSync(bOutput.publication.stagePath), false);
  }],
  ['different database identities contend on the same cache lock before marker publication', async f => {
    const dbA = database(f, 'db-a'), dbB = database(f, 'db-b'), workerGate = join(f.root, 'release-worker-a');
    seedHealthy(f, dbA);
    const a = attempt(f, 'a', dbA, { workerGate });
    await waitUntil(() => existsSync(a.cfg.leaseRecord), f.deadline, 'first_worker_holds_private_locks');
    assert.equal(readJson(a.cfg.leaseRecord).state, 'acquired');
    const cachePath = join(f.logDir, 'live-probe.json'), pending = snapshot(cachePath);
    assert.equal(readJson(cachePath).reason, 'attempting');
    const b = attempt(f, 'b', dbB), bOutput = await completed(b.handle);
    assert.equal(bOutput.result.outcome, 'busy'); assert.equal(bOutput.result.reason, 'scheduler_busy');
    traceAttempt(f, b, bOutput, { guardian: false });
    assert.equal(a.cfg.scheduleLock, b.cfg.scheduleLock); assert.notEqual(a.cfg.statePath, b.cfg.statePath);
    unchanged(cachePath, pending); assert.equal(existsSync(bOutput.publication.stagePath), false);
    privateJson(workerGate, { release: true });
    const aOutput = await completed(a.handle);
    assert.equal(aOutput.result.outcome, 'ok'); assert.equal(aOutput.result.cacheWritten, true);
    traceAttempt(f, a, aOutput); assert.ok(parseRemoteSampleCache(readJson(cachePath)));
    assert.equal(existsSync(aOutput.publication.stagePath), false); assert.equal(existsSync(b.cfg.statePath), false);
  }],
];

test('real synthetic cache publication acceptance (first failure stops the matrix)', async t => {
  let stopped = false;
  for (const [name, body] of CASES) await t.test(name, async childTest => {
    if (stopped) { childTest.skip('earlier synthetic acceptance case failed'); return; }
    let f;
    try {
      f = caseFixture(name);
      await body(f);
      await verifyReleased(f);
      assert.ok(performance.now() < f.deadline, 'all evidence must be observed inside the original ten-second case deadline');
      rmSync(f.root, { recursive: true });
    } catch (error) {
      stopped = true;
      // Only direct, still-owned handles may receive one signal. There is no
      // retry after denial, no signal to recorded numeric PIDs, and no unbounded
      // await of close: every result has the original hard deadline.
      for (const handle of f?.owned || []) handle.stop('cache_acceptance_first_failure');
      await Promise.all((f?.owned || []).map(handle => handle.result));
      if (f) childTest.diagnostic(`Synthetic evidence retained: ${f.root}`);
      throw error;
    }
  });
});
