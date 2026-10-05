import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { REMOTE_SAMPLE_GUARDIAN } from '../src/runtime/worker/remote-sample-process.mjs';
import { runManualRemoteSample } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { runReadOnlyRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';
import { parseRemoteSampleCache } from '../src/diagnostics/remote-sample-cache.mjs';

const LEASE_URL = new URL('../src/runtime/lark-api-lease.mjs', import.meta.url).href;
const PROCESS_URL = new URL('../src/runtime/worker/remote-sample-process.mjs', import.meta.url).href;
const SCHEDULER_URL = new URL('../src/runtime/worker/remote-sample-scheduler.mjs', import.meta.url).href;
const SAMPLE_URL = new URL('../src/diagnostics/remote-sample.mjs', import.meta.url).href;
const CACHE_URL = new URL('../src/diagnostics/remote-sample-cache.mjs', import.meta.url).href;
const POLICY_URL = new URL('../src/diagnostics/remote-sample-core.mjs', import.meta.url).href;
// Test-only instrumentation writes the outer supervisor's own PID before its
// unmodified source. It keeps the same interpreter/PID and records no other
// process or machine state. This file is defined for later authorized runs.
function traceGuardianArgs(args, path) {
  const index = args.indexOf(REMOTE_SAMPLE_GUARDIAN);
  if (index < 0) throw Error('guardian source missing from synthetic invocation');
  const traced = [...args];
  traced[index] = `import os\n_trace_fd=os.open(${JSON.stringify(path)},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nos.write(_trace_fd,str(os.getpid()).encode('ascii'))\nos.close(_trace_fd)\n${traced[index]}`;
  return traced;
}
function recordedGuardian(f) {
  const pid = Number(readFileSync(f.guardianReady, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'outer guardian must record its own synthetic PID');
  return pid;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error('synthetic lifecycle observation timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function fixture(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'exo-synthetic-process-cleanup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'invented.sqlite'); writeFileSync(db, 'invented database identity', { mode: 0o600 });
  const lockDirectory = join(directory, 'synthetic-api-lock');
  const ready = join(directory, 'synthetic-processes.json');
  const scriptPath = join(directory, 'synthetic-probe.mjs');
  const guardianReady = join(directory, 'synthetic-guardian.pid');
  const complete = `const now=Date.now(),end=now-SAMPLE_POLICY.stableBufferMs;
    const report={schema_version:3,status:'inconclusive',ok:false,reason:'no_eligible_chats',checked_at:new Date(now).toISOString(),
      window:{start:new Date(end-SAMPLE_POLICY.windowMs).toISOString(),end:new Date(end).toISOString()},probe:{},findings:{},binding:{state:'unverified'}};
    const publication=JSON.parse(process.env.EXOCORTEX_REMOTE_SAMPLE_PUBLICATION||'null');
    if(publication)writeRemoteSampleCache(publication.stagePath,{report,cacheContext:{database_key:'a'.repeat(64),account_key:null,auth_identity_verified:false}});
    process.stdout.write(JSON.stringify({outcome:'ok',reason:'sampled',cacheWritten:Boolean(publication),report}));`;
  writeFileSync(scriptPath, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
    import{tryAcquireLarkApiLease}from ${JSON.stringify(LEASE_URL)};
    import{writeRemoteSampleCache}from ${JSON.stringify(CACHE_URL)};
    import{SAMPLE_POLICY}from ${JSON.stringify(POLICY_URL)};
    ${mode.startsWith('fast') ? `writeFileSync(${JSON.stringify(ready)},JSON.stringify({probe:process.pid,anchor:process.ppid}),{mode:0o600});
      ${mode === 'fast0' ? `${complete}process.exit(0);` : 'process.exit(7);'}` : ''}
    const lease=tryAcquireLarkApiLease({role:'probe'},{directory:${JSON.stringify(lockDirectory)}});
    if(lease.state!=='acquired')process.exit(2);
    // The fake CLI descendant deliberately retains the API fd and
    // output pipes. No credential, business DB or remote endpoint is accessed.
    const cli=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit',lease.stdio[3]]});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({probe:process.pid,cli:cli.pid,anchor:process.ppid}),{mode:0o600});
    ${mode === 'exit' ? `${complete}cli.unref();process.exit(0);` :
      mode === 'overflow' ? `process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000);` : 'setInterval(()=>{},1000);'}
  `);
  return { directory, lockDirectory, scriptPath, ready, guardianReady, opts: { db, logDir: directory, remoteSampleIntervalSeconds: 900 } };
}
function invoke(kind, f, timeoutMs = 700) {
  const deps = { scriptPath: f.scriptPath, timeoutMs,
    spawnSync: (command, args, options) => spawnSync(command, traceGuardianArgs(args, f.guardianReady), options) };
  return kind === 'manual_cache' ? runManualRemoteSample(f.opts, deps) : runReadOnlyRemoteSample(f.opts.db, {}, deps);
}
function assertReleased(f) {
  const lease = tryAcquireLarkApiLease({ role: 'probe' }, { directory: f.lockDirectory });
  try { assert.equal(lease.state, 'acquired', 'the timed-out descendant must release its inherited API flock'); }
  finally { lease.release(); }
}

for (const kind of ['manual_cache', 'read_only']) {
  for (const mode of ['blocked', 'exit', 'overflow']) test(`${kind} actual entry cleans descendants and releases flock after ${mode}`, async t => {
    const f = fixture(t, mode); const started = Date.now();
    const result = invoke(kind, f);
    assert.ok(Date.now() - started < 3000, 'the entry must return after bounded group cleanup');
    assert.equal(result.outcome, mode === 'exit' ? 'ok' : 'failed');
    assert.ok(existsSync(f.ready), 'the fake probe must really acquire and inherit the lock');
    const processes = JSON.parse(readFileSync(f.ready, 'utf8'));
    const guardian = recordedGuardian(f);
    assert.notEqual(guardian, processes.anchor, 'outer guardian and group anchor are distinct processes');
    await waitUntil(() => !alive(processes.probe) && !alive(processes.cli) && !alive(processes.anchor) && !alive(guardian));
    assertReleased(f);
    if (mode === 'exit' && kind === 'manual_cache') {
      const cache = JSON.parse(readFileSync(join(f.directory, 'live-probe.json'), 'utf8'));
      assert.ok(parseRemoteSampleCache(cache), 'a successful cache-mode worker must prepare a valid stage for the guardian');
      assert.equal(result.cacheWritten, true);
    }
    assert.doesNotMatch(JSON.stringify(result), /synthetic-processes|invented database|"probe":\d|"cli":\d/);
  });

  // Deferred real-process regressions: exercise worker completion before a
  // watcher could register, without any CLI descendant keeping the group alive.
  // These are defined for future authorized lifecycle verification, not run by
  // the current mock-only diagnostics work.
  for (const code of [0, 7]) test(`${kind} fast worker without descendants preserves exit ${code}`, async t => {
    const f = fixture(t, `fast${code}`); const started = Date.now();
    const result = invoke(kind, f, 2000);
    assert.ok(Date.now() - started < 4000, 'fast completion must not wait for the full process deadline');
    assert.equal(result.outcome, code === 0 ? 'ok' : 'failed');
    assert.ok(existsSync(f.ready), 'the short-lived worker must really start');
    const processes = JSON.parse(readFileSync(f.ready, 'utf8'));
    assert.equal(processes.cli, undefined);
    const guardian = recordedGuardian(f);
    assert.notEqual(guardian, processes.anchor, 'outer guardian and group anchor are distinct processes');
    await waitUntil(() => !alive(processes.probe) && !alive(processes.anchor) && !alive(guardian));
    if (code === 7) assert.equal(result.guardian_diagnostic?.primary?.stage, 'child_exit');
    if (code === 0 && kind === 'manual_cache') {
      assert.equal(result.cacheWritten, true);
      assert.ok(parseRemoteSampleCache(JSON.parse(readFileSync(join(f.directory, 'live-probe.json'), 'utf8'))));
    }
  });

  for (const signal of ['SIGTERM', 'SIGKILL', 'SIGHUP']) test(`${kind} actual entry cleans inherited flock when its caller receives ${signal}`, async t => {
    const f = fixture(t, 'blocked'); const launcher = join(f.directory, 'synthetic-caller.mjs');
    writeFileSync(launcher, `import{runManualRemoteSample}from ${JSON.stringify(SCHEDULER_URL)};
      import{runReadOnlyRemoteSample}from ${JSON.stringify(SAMPLE_URL)};
      import{REMOTE_SAMPLE_GUARDIAN}from ${JSON.stringify(PROCESS_URL)};import{spawnSync}from'node:child_process';
      ${traceGuardianArgs.toString()}
      const options=${JSON.stringify(f.opts)};const deps=${JSON.stringify({ scriptPath: f.scriptPath, timeoutMs: 60_000 })};
      deps.spawnSync=(command,args,options)=>spawnSync(command,traceGuardianArgs(args,${JSON.stringify(f.guardianReady)}),options);
      ${kind === 'manual_cache' ? 'runManualRemoteSample(options,deps)' : 'runReadOnlyRemoteSample(options.db,{},deps)'};\n`);
    const caller = spawn(process.execPath, [launcher], { stdio: 'ignore', detached: true });
    t.after(() => caller.kill('SIGKILL'));
    const closed = once(caller, 'close');
    await waitUntil(() => existsSync(f.ready));
    const processes = JSON.parse(readFileSync(f.ready, 'utf8'));
    const guardian = recordedGuardian(f);
    assert.notEqual(guardian, processes.anchor, 'outer guardian and group anchor are distinct processes');
    if (signal === 'SIGHUP') process.kill(-caller.pid, signal); else caller.kill(signal);
    await closed;
    await waitUntil(() => !alive(processes.probe) && !alive(processes.cli) && !alive(processes.anchor) && !alive(guardian));
    assertReleased(f);
  });
}
