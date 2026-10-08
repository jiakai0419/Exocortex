import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startOwnedProcess, waitForPidsToExit, waitUntil } from './helpers/owned-process.mjs';

const WORKER_URL = new URL('../src/runtime/worker/worker.mjs', import.meta.url).href;
const PROCESS_URL = new URL('../src/runtime/worker/step-process.mjs', import.meta.url).href;
const LEASE_URL = new URL('../src/runtime/lark-api-lease.mjs', import.meta.url).href;
const TRANSPORT_URL = new URL('../src/adapters/lark-im/transport.mjs', import.meta.url).href;
const ACCEPTANCE_MS = 10000;
const FALLBACK_MS = 20000;
let firstFailure = null;

// Add observation only before the unchanged guardian program. Recorded PIDs
// never become signal targets: cleanup owns a ChildProcess, not a PID file.
function traceGuardianArgs(args, path, nonce) {
  const index = args.indexOf(WORKER_STEP_GUARDIAN);
  if (index < 0) throw Error('synthetic_guardian_source_missing');
  const traced = [...args];
  traced[index] = `import os,json\n_trace_fd=os.open(${JSON.stringify(`${path}.pending`)},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nos.write(_trace_fd,json.dumps({'pid':os.getpid(),'nonce':${JSON.stringify(nonce)}}).encode('ascii'))\nos.close(_trace_fd)\nos.rename(${JSON.stringify(`${path}.pending`)},${JSON.stringify(path)})\n${traced[index]}`;
  return traced;
}

function recorded(path, nonce) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(value.nonce, nonce, 'the observation belongs to this private fixture');
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
  return value;
}

function fixture(mode, callerSignal) {
  const directory = mkdtempSync(join(tmpdir(), 'exo-synthetic-worker-step-'));
  const nonce = randomUUID();
  const lockDirectory = join(directory, 'private-api-lease');
  const files = Object.fromEntries(['caller', 'guardian', 'step', 'bridge', 'request', 'transport']
    .map(name => [name, join(directory, `${name}.json`)]));
  const requestPath = join(directory, 'invented-request.mjs');
  const bridgePath = join(directory, 'invented-bridge.mjs');
  const stepPath = join(directory, 'invented-step.mjs');
  const callerPath = join(directory, 'invented-caller.mjs');
  const fallbackPath = join(directory, 'fallback-used');
  const transportMode = mode.startsWith('transport_');
  const fastMode = mode.startsWith('fast');
  const timeoutMs = callerSignal ? 5000 : ['transport_step_timeout', 'dual_deadline'].includes(mode) ? 1000 : 5000;
  const maxBuffer = mode.endsWith('_overflow') ? (mode === 'dual_overflow' ? 128 * 1024 : 32 * 1024)
    : mode === 'dual_deadline' ? 1024 * 1024 : 100 * 1024 * 1024;
  const recordSource = `function record(path,value){writeFileSync(path+'.pending',JSON.stringify({...value,nonce:${JSON.stringify(nonce)}}),{mode:0o600,flag:'wx'});renameSync(path+'.pending',path);}`;
  const fallbackSource = `setTimeout(()=>{writeFileSync(${JSON.stringify(fallbackPath)},'fixture fallback');process.exit(98);},${FALLBACK_MS});`;
  const inheritanceSource = `const inherited=fstatSync(3),named=statSync(${JSON.stringify(join(lockDirectory, 'api.lock'))});
    const leaseMatches=inherited.isFile()&&inherited.dev===named.dev&&inherited.ino===named.ino;
    const stdoutStat=fstatSync(1),stderrStat=fstatSync(2);
    const stdoutPipe=stdoutStat.isFIFO()||stdoutStat.isSocket(),stderrPipe=stderrStat.isFIFO()||stderrStat.isSocket();
    if(!leaseMatches||!stdoutPipe||!stderrPipe)throw Error('synthetic_inheritance_invalid');`;
  writeFileSync(requestPath, `import{writeFileSync,renameSync,fstatSync,statSync}from'node:fs';
    ${recordSource}${fallbackSource}${inheritanceSource}
    record(${JSON.stringify(files.request)},{pid:process.pid,parent:process.ppid,lease_matches:leaseMatches,stdout_pipe:stdoutPipe,stderr_pipe:stderrPipe});
    ${mode === 'transport_normal' ? `setTimeout(()=>{process.stdout.write('{"invented":true}');process.exit(0);},80);` : ''}
  `, { mode: 0o600, flag: 'wx' });
  writeFileSync(bridgePath, `import{spawn}from'node:child_process';import{writeFileSync,renameSync,fstatSync,statSync}from'node:fs';
    ${recordSource}${fallbackSource}${inheritanceSource}
    const child=spawn(process.execPath,[${JSON.stringify(requestPath)}],{stdio:['ignore','inherit','inherit',3]});
    record(${JSON.stringify(files.bridge)},{pid:process.pid,parent:process.ppid,request:child.pid,lease_matches:leaseMatches,stdout_pipe:stdoutPipe,stderr_pipe:stderrPipe});
  `, { mode: 0o600, flag: 'wx' });
  const summary = mode === 'early_partial' || mode === 'fast2' ? { ok: false, partial: true } : { ok: true };
  const fastCode = Number(mode.slice(4));
  const exitCode = mode === 'early_partial' || mode === 'fast2' ? 2 : 0;
  writeFileSync(stepPath, `import{spawn}from'node:child_process';import{existsSync,writeFileSync,renameSync}from'node:fs';
    import{tryAcquireLarkApiLease}from ${JSON.stringify(LEASE_URL)};
    import{createLarkCliRunner}from ${JSON.stringify(TRANSPORT_URL)};
    ${recordSource}${fallbackSource}
    record(${JSON.stringify(files.step)},{pid:process.pid,anchor:process.ppid});
    ${fastMode ? `process.stdout.write(${JSON.stringify(JSON.stringify(summary))});
      ${mode === 'fast_signal' ? `process.kill(process.pid,'SIGTERM');await new Promise(()=>{});` : `process.exit(${fastCode});`}` : ''}
    const lease=tryAcquireLarkApiLease({role:'sync'},{directory:${JSON.stringify(lockDirectory)}});
    if(lease.state!=='acquired')throw Error('synthetic_lease_unavailable:'+lease.reason);
    ${transportMode ? `const run=createLarkCliRunner({bin:process.execPath,readSharedCooldown:()=>({state:'ready',untilMs:null}),writeSharedCooldown:()=>true});
      let failed=false;
      try{run([${JSON.stringify(requestPath)}],{timeoutMs:${mode === 'transport_timeout_control' ? 600 : 5000},retryBudgetMs:6000,retries:0});}
      catch{failed=true;}finally{lease.release();}
      record(${JSON.stringify(files.transport)},{pid:process.pid,failed});
      process.stdout.write('{"ok":true}');process.exit(0);` : `
      const bridge=spawn(process.execPath,[${JSON.stringify(bridgePath)}],{stdio:['ignore','inherit','inherit',lease.stdio[3]]});
      const readyLimit=performance.now()+2000;
      while(!existsSync(${JSON.stringify(files.request)})){
        if(performance.now()>=readyLimit)throw Error('synthetic_request_start_deadline');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      ${['early_ok', 'early_partial'].includes(mode) ? `process.stdout.write(${JSON.stringify(JSON.stringify(summary))});bridge.unref();process.exit(${exitCode});` : ''}
      ${mode === 'stdout_overflow' ? `process.stdout.write('x'.repeat(200000));` : ''}
      ${mode === 'stderr_overflow' ? `process.stderr.write('x'.repeat(200000));` : ''}
      ${mode.startsWith('dual_') ? `setInterval(()=>{process.stdout.write('x'.repeat(256));process.stderr.write('y'.repeat(256));},${mode === 'dual_deadline' ? 4 : 1});` : ''}
    `}
  `, { mode: 0o600, flag: 'wx' });
  writeFileSync(callerPath, `import{spawnSync}from'node:child_process';import{writeFileSync,renameSync}from'node:fs';
    import{runStep}from ${JSON.stringify(WORKER_URL)};
    import{runGuardedWorkerStep,WORKER_STEP_GUARDIAN}from ${JSON.stringify(PROCESS_URL)};
    ${recordSource}${fallbackSource}${traceGuardianArgs.toString()}
    record(${JSON.stringify(files.caller)},{pid:process.pid});
    let capture;
    const started=performance.now();
    const result=runStep('synthetic-step',[],{scriptPath:${JSON.stringify(stepPath)},timeoutSeconds:${timeoutMs / 1000},
      runProcess:(command,args,options)=>{
        const value=runGuardedWorkerStep(command,args,{...options,maxBuffer:${maxBuffer}},{spawnSync:(bin,argv,opts)=>
          spawnSync(bin,traceGuardianArgs(argv,${JSON.stringify(files.guardian)},${JSON.stringify(nonce)}),opts)});
        capture={status:value.status,signal:value.signal,stdoutBytes:Buffer.byteLength(value.stdout),stderrBytes:Buffer.byteLength(value.stderr),diagnostic:value.guardian_diagnostic??null};
        return value;
      }});
    process.stdout.write(JSON.stringify({result,capture,elapsedMs:performance.now()-started}));process.exit(0);
  `, { mode: 0o600, flag: 'wx' });
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    TMPDIR: tmpdir(), LARK_CLI: join(directory, 'real-api-disabled') };
  return { directory, nonce, lockDirectory, files, fallbackPath, callerPath, env, timeoutMs, maxBuffer, fastMode, transportMode };
}

async function assertReleased(f, deadline) {
  const checker = startOwnedProcess(process.execPath, ['--input-type=module', '-e', `
    import{tryAcquireLarkApiLease}from ${JSON.stringify(LEASE_URL)};
    setTimeout(()=>process.exit(98),${FALLBACK_MS}).unref();
    const lease=tryAcquireLarkApiLease({role:'probe'},{directory:${JSON.stringify(f.lockDirectory)}});
    try{if(lease.state!=='acquired')throw Error('synthetic_lock_not_released:'+lease.reason);process.stdout.write('released');}
    finally{lease.release();}`], { deadline, cwd: f.directory, env: f.env });
  const result = await checker.result;
  assert.equal(result.failure, null, 'lease checker must finish inside the same case deadline');
  assert.equal(result.signalError, null);
  assert.equal(result.code, 0, result.stderr.toString());
  assert.equal(result.stdout.toString(), 'released');
}

function lifecycleTest(name, mode, callerSignal = null) {
  test(name, { timeout: ACCEPTANCE_MS + 1000, concurrency: false }, async t => {
    if (firstFailure) { t.skip('a prior lifecycle failure stopped this process matrix'); return; }
    const deadline = performance.now() + ACCEPTANCE_MS;
    let f, owner, signaledAt, completed = false;
    try {
      f = fixture(mode, callerSignal);
      owner = startOwnedProcess(process.execPath, [f.callerPath], { deadline, cwd: f.directory, env: f.env, detached: true });
      if (callerSignal) {
        await waitUntil(() => existsSync(f.files.step) && existsSync(f.files.request) && existsSync(f.files.guardian),
          deadline - 2000, 'synthetic_caller_signal_ready');
        signaledAt = performance.now();
        assert.equal(owner.signalOnce(callerSignal, { group: callerSignal === 'SIGHUP' }), true,
          'signal only the owned caller or its explicitly detached group, once');
      }
      const call = await owner.result;
      assert.equal(call.failure, null, 'caller must close before the outer watchdog');
      assert.equal(call.signalError, null, 'a refused signal is never retried');
      if (callerSignal) assert.equal(call.signal, callerSignal);
      else {
        assert.equal(call.code, 0, call.stderr.toString());
        assert.equal(call.signal, null);
        const { result, capture, elapsedMs } = JSON.parse(call.stdout.toString());
        const success = ['transport_normal', 'transport_timeout_control', 'early_ok', 'fast0'].includes(mode);
        const partial = ['early_partial', 'fast2'].includes(mode);
        assert.equal(result.ok, success);
        assert.equal(result.partial === true, partial);
        assert.ok(elapsedMs < ACCEPTANCE_MS - 1000, 'independent fixture fallbacks cannot satisfy cleanup');
        // A free lease or vanished PID must never hide a cleanup failure.
        assert.equal(capture.diagnostic?.cleanup ?? null, null);
        if (mode.endsWith('_overflow')) {
          assert.equal(capture.diagnostic?.primary?.stage, 'output_limit');
          assert.ok(capture.stdoutBytes + capture.stderrBytes <= f.maxBuffer + 1);
          assert.equal(result.exit_code, undefined);
        } else if (['transport_step_timeout', 'dual_deadline'].includes(mode)) {
          assert.ok(['deadline', 'anchor_deadline'].includes(capture.diagnostic?.primary?.stage));
          assert.ok(elapsedMs < 4000, 'step cleanup must precede the 5000ms transport request timeout');
          assert.equal(result.exit_code, undefined);
        } else {
          assert.equal(capture.diagnostic, null);
          assert.equal(result.exit_code, mode === 'fast_signal' ? undefined : partial ? 2 : mode === 'fast7' ? 7 : 0);
          assert.equal(capture.signal, mode === 'fast_signal' ? 'SIGTERM' : null);
        }
        if (mode.startsWith('dual_')) {
          assert.ok(capture.stdoutBytes > 0 && capture.stderrBytes > 0, 'neither active output stream starves the other');
          assert.ok(capture.stdoutBytes + capture.stderrBytes <= f.maxBuffer + 1);
        }
        assert.doesNotMatch(JSON.stringify(result.guardian_diagnostic || {}), /invented|private-api-lease|pid/);
        if (['transport_normal', 'transport_timeout_control'].includes(mode)) {
          assert.equal(recorded(f.files.transport, f.nonce).failed, mode === 'transport_timeout_control');
        }
      }
      const caller = recorded(f.files.caller, f.nonce), step = recorded(f.files.step, f.nonce);
      const guardian = recorded(f.files.guardian, f.nonce);
      assert.equal(caller.pid, owner.child.pid);
      assert.notEqual(guardian.pid, step.anchor, 'guardian must be outside the owned anchor group');
      assert.ok(Number.isSafeInteger(step.anchor) && step.anchor > 0);
      const pids = [caller.pid, guardian.pid, step.anchor, step.pid];
      if (!f.fastMode) {
        const request = recorded(f.files.request, f.nonce);
        assert.equal(request.lease_matches, true, 'request holds this exact private API flock');
        assert.equal(request.stdout_pipe, true);
        assert.equal(request.stderr_pipe, true);
        pids.push(request.pid);
        if (f.transportMode) assert.equal(request.parent, step.pid, 'actual transport launched the invented request');
        else {
          const bridge = recorded(f.files.bridge, f.nonce);
          assert.equal(bridge.parent, step.pid);
          assert.equal(bridge.request, request.pid);
          assert.equal(request.parent, bridge.pid);
          assert.equal(bridge.lease_matches, true);
          assert.equal(bridge.stdout_pipe, true);
          assert.equal(bridge.stderr_pipe, true);
          pids.push(bridge.pid);
        }
      }
      // Parent death must trigger cleanup before the step's own 5s deadline.
      const cleanupDeadline = callerSignal ? Math.min(deadline - 1000, signaledAt + 2000) : deadline - 1000;
      await waitForPidsToExit(pids, cleanupDeadline);
      await assertReleased(f, callerSignal ? cleanupDeadline : deadline);
      assert.equal(existsSync(f.fallbackPath), false, '20-second self exits cannot explain accepted cleanup');
      assert.ok(performance.now() < deadline);
      completed = true;
    } catch (error) {
      firstFailure = error;
      owner?.stop('lifecycle_assertion_failed');
      if (owner) await owner.result;
      t.diagnostic(`Synthetic evidence retained at ${f?.directory || 'fixture setup did not finish'}; cleanup is unconfirmed. No PID-record signal or signal retry was used.`);
      throw error;
    } finally {
      if (completed) rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

lifecycleTest('actual worker step timeout ends transport request and releases its inherited flock', 'transport_step_timeout');
lifecycleTest('live transport request timeout still releases flock before successful worker completion', 'transport_timeout_control');
lifecycleTest('normal transport request and worker completion preserve success and release flock', 'transport_normal');
for (const mode of ['early_ok', 'early_partial']) lifecycleTest(`${mode} cleans two descendant generations holding flock and captured pipes`, mode);
for (const mode of ['fast0', 'fast2', 'fast7', 'fast_signal']) lifecycleTest(`fast worker ${mode} preserves status while reaping guardian and anchor`, mode);
for (const mode of ['stdout_overflow', 'stderr_overflow', 'dual_overflow', 'dual_deadline']) lifecycleTest(`${mode} bounds output and still cleans both descendant generations`, mode);
for (const signal of ['SIGTERM', 'SIGKILL', 'SIGHUP']) lifecycleTest(`actual worker transport descendants release flock when caller receives ${signal}`, 'transport_step_timeout', signal);
