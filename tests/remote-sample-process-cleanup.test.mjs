import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';
import { startOwnedProcess, waitForPidsToExit, waitUntil } from './helpers/owned-process.mjs';

const LEASE_URL = new URL('../src/runtime/lark-api-lease.mjs', import.meta.url).href;
const PROCESS_URL = new URL('../src/runtime/worker/remote-sample-process.mjs', import.meta.url).href;
const SCHEDULER_URL = new URL('../src/runtime/worker/remote-sample-scheduler.mjs', import.meta.url).href;
const SAMPLE_URL = new URL('../src/diagnostics/remote-sample.mjs', import.meta.url).href;
const CACHE_URL = new URL('../src/diagnostics/remote-sample-cache.mjs', import.meta.url).href;
const POLICY_URL = new URL('../src/diagnostics/remote-sample-core.mjs', import.meta.url).href;
let firstFailure = null;

// Prefix only: the guardian records its own PID before running unchanged code.
// Records are for observation, never the target of a cleanup signal.
function traceGuardianArgs(args, path, nonce) {
  const index = args.indexOf(REMOTE_SAMPLE_GUARDIAN);
  if (index < 0) throw Error('guardian source missing from synthetic invocation');
  const traced = [...args];
  traced[index] = `import os,json\n_trace_fd=os.open(${JSON.stringify(`${path}.pending`)},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nos.write(_trace_fd,json.dumps({'pid':os.getpid(),'nonce':${JSON.stringify(nonce)}}).encode('ascii'))\nos.close(_trace_fd)\nos.rename(${JSON.stringify(`${path}.pending`)},${JSON.stringify(path)})\n${traced[index]}`;
  return traced;
}
function recorded(path, nonce) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(value.nonce, nonce, 'the PID record belongs to this private fixture');
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  return value;
}
function fixture(kind, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'exo-synthetic-process-cleanup-'));
  const nonce = randomUUID();
  const db = join(directory, 'invented.sqlite');
  writeFileSync(db, 'invented database identity', { mode: 0o600, flag: 'wx' });
  const lockDirectory = join(directory, 'synthetic-api-lock');
  const workerRecord = join(directory, 'worker.json'), cliRecord = join(directory, 'cli.json');
  const callerRecord = join(directory, 'caller.json'), guardianRecord = join(directory, 'guardian.json');
  const workerPath = join(directory, 'synthetic-worker.mjs'), cliPath = join(directory, 'synthetic-cli.mjs');
  const callerPath = join(directory, 'synthetic-caller.mjs');
  const recordSource = `function record(path,value){writeFileSync(path+'.pending',JSON.stringify({...value,nonce:${JSON.stringify(nonce)}}),{mode:0o600,flag:'wx'});renameSync(path+'.pending',path);}`;
  // Fallback is deliberately later than the 10-second acceptance boundary.
  // It bounds failed fixtures; it can never supply successful cleanup evidence.
  writeFileSync(cliPath, `import{writeFileSync,renameSync,fstatSync,statSync}from'node:fs';${recordSource}
    const inherited=fstatSync(3),named=statSync(${JSON.stringify(join(lockDirectory, 'api.lock'))});
    const leaseMatches=inherited.isFile()&&inherited.dev===named.dev&&inherited.ino===named.ino;
    const stdoutFifo=fstatSync(1).isFIFO();
    if(!leaseMatches||!stdoutFifo)throw Error('synthetic_inheritance_evidence_invalid');
    record(${JSON.stringify(cliRecord)},{pid:process.pid,parent:process.ppid,lease_matches:leaseMatches,stdout_fifo:stdoutFifo});
    setTimeout(()=>process.exit(98),20000);`, { mode: 0o600, flag: 'wx' });
  const complete = `const now=Date.now(),end=now-SAMPLE_POLICY.stableBufferMs;
    const report={schema_version:3,status:'inconclusive',ok:false,reason:'no_eligible_chats',checked_at:new Date(now).toISOString(),
      window:{start:new Date(end-SAMPLE_POLICY.windowMs).toISOString(),end:new Date(end).toISOString()},probe:{},findings:{},binding:{state:'unverified'}};
    const publication=JSON.parse(process.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION||'null');
    if(publication&&!writeRemoteSampleCache(publication.stagePath,{report,cacheContext:{database_key:'a'.repeat(64),account_key:null,auth_identity_verified:false}}))process.exit(2);
    process.stdout.write(JSON.stringify({outcome:'ok',reason:'sampled',cacheWritten:Boolean(publication),report}));`;
  writeFileSync(workerPath, `import{spawn}from'node:child_process';import{existsSync,writeFileSync,renameSync}from'node:fs';
    import{tryAcquireLarkApiLease}from ${JSON.stringify(LEASE_URL)};
    import{writeRemoteSampleCache}from ${JSON.stringify(CACHE_URL)};
    import{SAMPLE_POLICY}from ${JSON.stringify(POLICY_URL)};${recordSource}
    setTimeout(()=>process.exit(98),20000);
    ${mode.startsWith('fast') ? `record(${JSON.stringify(workerRecord)},{pid:process.pid,anchor:process.ppid});
      ${mode === 'fast0' ? `${complete}process.exit(0);` : 'process.exit(7);'}` : ''}
    const lease=tryAcquireLarkApiLease({role:'probe'},{directory:${JSON.stringify(lockDirectory)}});
    if(lease.state!=='acquired')throw Error('synthetic_lease_unavailable:'+lease.reason);
    const cli=spawn(process.execPath,[${JSON.stringify(cliPath)}],{stdio:['ignore','inherit','inherit',lease.stdio[3]]});
    const readyLimit=performance.now()+2000;
    while(!existsSync(${JSON.stringify(cliRecord)})){
      if(performance.now()>=readyLimit)throw Error('synthetic_cli_start_deadline');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    record(${JSON.stringify(workerRecord)},{pid:process.pid,cli:cli.pid,anchor:process.ppid});
    ${mode === 'exit' ? `${complete}cli.unref();process.exit(0);` : mode === 'overflow' ? `process.stdout.write('x'.repeat(200000));` : ''}
  `, { mode: 0o600, flag: 'wx' });
  const opts = { db, logDir: directory, remoteSampleIntervalSeconds: 900 };
  writeFileSync(callerPath, `import{runManualRemoteSample}from ${JSON.stringify(SCHEDULER_URL)};
    import{runReadOnlyRemoteSample}from ${JSON.stringify(SAMPLE_URL)};
    import{REMOTE_SAMPLE_GUARDIAN}from ${JSON.stringify(PROCESS_URL)};
    import{spawnSync}from'node:child_process';import{writeFileSync,renameSync}from'node:fs';${recordSource}
    ${traceGuardianArgs.toString()}
    record(${JSON.stringify(callerRecord)},{pid:process.pid});
    const options=${JSON.stringify(opts)};const deps={scriptPath:${JSON.stringify(workerPath)},timeoutMs:Number(process.argv[2])};
    deps.spawnSync=(command,args,options)=>spawnSync(command,traceGuardianArgs(args,${JSON.stringify(guardianRecord)},${JSON.stringify(nonce)}),options);
    const result=${kind === 'manual_cache' ? 'runManualRemoteSample(options,deps)' : 'runReadOnlyRemoteSample(options.db,{},deps)'};
    process.stdout.write(JSON.stringify(result));`, { mode: 0o600, flag: 'wx' });
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    LARK_CLI: join(directory, 'remote-api-disabled') };
  return { directory, nonce, lockDirectory, workerRecord, cliRecord, callerRecord, guardianRecord, callerPath, opts, env };
}

async function assertReleased(f, deadline) {
  const checker = startOwnedProcess(process.execPath, ['--input-type=module', '-e', `
    import{tryAcquireLarkApiLease}from ${JSON.stringify(LEASE_URL)};
    const lease=tryAcquireLarkApiLease({role:'probe'},{directory:${JSON.stringify(f.lockDirectory)}});
    try{if(lease.state!=='acquired')throw Error('synthetic_lock_not_released:'+lease.reason);process.stdout.write('released');}
    finally{lease.release();}`], { deadline, cwd: f.directory, env: f.env });
  const result = await checker.result;
  assert.equal(result.failure, null, 'private lease checker must finish within this same case deadline');
  assert.equal(result.signalError, null);
  assert.equal(result.code, 0, result.stderr.toString());
  assert.equal(result.stdout.toString(), 'released');
}

function lifecycleTest(name, kind, mode, callerSignal = null) {
  test(name, { timeout: 11000, concurrency: false }, async t => {
    if (firstFailure) { t.skip('a prior lifecycle failure stopped this process matrix'); return; }
    const deadline = performance.now() + 10000;
    let f, owner, completed = false;
    try {
      f = fixture(kind, mode);
      owner = startOwnedProcess(process.execPath, [f.callerPath, callerSignal ? '30000' : '3000'],
        { deadline, cwd: f.directory, env: f.env, detached: true });
      if (callerSignal) {
        await waitUntil(() => existsSync(f.workerRecord) && existsSync(f.cliRecord) && existsSync(f.guardianRecord),
          deadline - 2000, 'synthetic_caller_signal_ready');
        assert.equal(owner.signalOnce(callerSignal, { group: callerSignal === 'SIGHUP' }), true,
          'send the requested signal once to the owned caller or its newly created group');
      }
      const call = await owner.result;
      assert.equal(call.failure, null, 'the asynchronous caller must close before its outer watchdog');
      assert.equal(call.signalError, null, 'signal refusal is not retried');
      if (callerSignal) assert.equal(call.signal, callerSignal);
      else { assert.equal(call.code, 0, call.stderr.toString()); assert.equal(call.signal, null); }
      // Validate reported cleanup before any PID wait or lock probe. Observed
      // process exit and a free lock cannot erase a reported cleanup failure.
      if (!callerSignal) {
        const result = JSON.parse(call.stdout.toString());
        assert.equal(result.outcome, ['exit', 'fast0'].includes(mode) ? 'ok' : 'failed');
        const diagnostic = result.guardian_diagnostic || result.report?.guardian_diagnostic;
        if (!['exit', 'fast0'].includes(mode) || diagnostic) assert.equal(diagnostic?.cleanup, null);
        if (mode === 'fast7') assert.equal(diagnostic?.primary?.stage, 'child_exit');
        if (mode === 'overflow') assert.equal(diagnostic?.primary?.stage, 'output_limit');
        if (mode === 'blocked') assert.ok(['deadline', 'anchor_deadline'].includes(diagnostic?.primary?.stage));
        if (['exit', 'fast0'].includes(mode) && kind === 'manual_cache') {
          assert.equal(result.cacheWritten, true);
          assert.ok(parseRemoteSampleCache(JSON.parse(readFileSync(join(f.directory, 'live-probe.json'), 'utf8'))));
        }
        assert.doesNotMatch(JSON.stringify(result), /invented database|"probe":\d|"cli":\d/);
      }
      const caller = recorded(f.callerRecord, f.nonce), worker = recorded(f.workerRecord, f.nonce);
      const guardian = recorded(f.guardianRecord, f.nonce);
      assert.equal(caller.pid, owner.child.pid);
      assert.notEqual(guardian.pid, worker.anchor, 'outer guardian and group anchor must be distinct');
      assert.ok(Number.isSafeInteger(worker.anchor) && worker.anchor > 0);
      const pids = [caller.pid, guardian.pid, worker.anchor, worker.pid];
      if (!mode.startsWith('fast')) {
        const cli = recorded(f.cliRecord, f.nonce);
        assert.equal(cli.pid, worker.cli);
        assert.equal(cli.parent, worker.pid);
        assert.equal(cli.lease_matches, true, 'the CLI must hold this fixture API flock descriptor');
        assert.equal(cli.stdout_fifo, true, 'the CLI must inherit the captured output pipe');
        pids.push(cli.pid);
      } else assert.equal(worker.cli, undefined);
      await waitForPidsToExit(pids, deadline - 1000);
      await assertReleased(f, deadline);
      assert.ok(performance.now() < deadline, 'fallback exits cannot count as accepted cleanup');
      completed = true;
    } catch (error) {
      firstFailure = error;
      owner?.stop('lifecycle_assertion_failed');
      if (owner) await owner.result;
      t.diagnostic(`Synthetic evidence retained at ${f?.directory || 'fixture setup did not finish'}; cleanup is unconfirmed. No signal retry or alternate target was used.`);
      throw error;
    } finally {
      if (completed) rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

for (const kind of ['manual_cache', 'read_only']) {
  for (const mode of ['blocked', 'exit', 'overflow']) lifecycleTest(`${kind} actual entry cleans descendants and releases flock after ${mode}`, kind, mode);
  for (const code of [0, 7]) lifecycleTest(`${kind} fast worker without descendants preserves exit ${code}`, kind, `fast${code}`);
  for (const signal of ['SIGTERM', 'SIGKILL', 'SIGHUP']) lifecycleTest(`${kind} actual entry cleans inherited flock when its caller receives ${signal}`, kind, 'blocked', signal);
}
