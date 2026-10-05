import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runManualRemoteSample } from '../src/runtime/worker/remote-sample-scheduler.mjs';
import { runReadOnlyRemoteSample } from '../src/diagnostics/remote-sample.mjs';
import { tryAcquireLarkApiLease } from '../src/runtime/lark-api-lease.mjs';

const LEASE_URL = new URL('../src/runtime/lark-api-lease.mjs', import.meta.url).href;
const SCHEDULER_URL = new URL('../src/runtime/worker/remote-sample-scheduler.mjs', import.meta.url).href;
const SAMPLE_URL = new URL('../src/diagnostics/remote-sample.mjs', import.meta.url).href;
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
  writeFileSync(scriptPath, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
    import{tryAcquireLarkApiLease}from ${JSON.stringify(LEASE_URL)};
    const lease=tryAcquireLarkApiLease({role:'probe'},{directory:${JSON.stringify(lockDirectory)}});
    if(lease.state!=='acquired')process.exit(2);
    // The fake CLI descendant deliberately retains the API fd and
    // output pipes. No credential, business DB or remote endpoint is accessed.
    const cli=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit',lease.stdio[3]]});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify({probe:process.pid,cli:cli.pid,guardian:process.ppid}),{mode:0o600});
    ${mode === 'exit' ? `process.stdout.write(JSON.stringify({outcome:'ok',reason:'sampled',cacheWritten:false,
      report:{schema_version:3,status:'inconclusive',ok:false}}));cli.unref();process.exit(0);` :
      mode === 'overflow' ? `process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000);` : 'setInterval(()=>{},1000);'}
  `);
  return { directory, lockDirectory, scriptPath, ready, opts: { db, logDir: directory, remoteSampleIntervalSeconds: 900 } };
}
function invoke(kind, f, timeoutMs = 700) {
  const deps = { scriptPath: f.scriptPath, timeoutMs };
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
    await waitUntil(() => !alive(processes.probe) && !alive(processes.cli));
    assertReleased(f);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-processes|invented database|"probe":\d|"cli":\d/);
  });

  for (const signal of ['SIGTERM', 'SIGKILL', 'SIGHUP']) test(`${kind} actual entry cleans inherited flock when its caller receives ${signal}`, async t => {
    const f = fixture(t, 'blocked'); const launcher = join(f.directory, 'synthetic-caller.mjs');
    writeFileSync(launcher, `import{runManualRemoteSample}from ${JSON.stringify(SCHEDULER_URL)};
      import{runReadOnlyRemoteSample}from ${JSON.stringify(SAMPLE_URL)};
      const options=${JSON.stringify(f.opts)};const deps=${JSON.stringify({ scriptPath: f.scriptPath, timeoutMs: 60_000 })};
      ${kind === 'manual_cache' ? 'runManualRemoteSample(options,deps)' : 'runReadOnlyRemoteSample(options.db,{},deps)'};\n`);
    const caller = spawn(process.execPath, [launcher], { stdio: 'ignore', detached: true });
    t.after(() => caller.kill('SIGKILL'));
    const closed = once(caller, 'close');
    await waitUntil(() => existsSync(f.ready));
    const processes = JSON.parse(readFileSync(f.ready, 'utf8'));
    if (signal === 'SIGHUP') process.kill(-caller.pid, signal); else caller.kill(signal);
    await closed;
    await waitUntil(() => !alive(processes.probe) && !alive(processes.cli) && !alive(processes.guardian));
    assertReleased(f);
  });
}
