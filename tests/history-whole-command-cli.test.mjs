import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../bin/exocortex.mjs';
import * as command from '../src/cli/maintenance-command.mjs';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGuardedWorkerStep } from '../src/runtime/worker/step-process.mjs';
import { runStep } from '../src/runtime/worker/worker.mjs';

function harness({ loadMs = 0, execute, writeMs = 0 } = {}) {
  let clock = 0, stdout = '', stderr = '', invoked = 0;
  return {
    get stdout() { return stdout; }, get stderr() { return stderr; }, get invoked() { return invoked; },
    run: () => runCli(['maintenance','history','--db','synthetic-unused.sqlite','--max-seconds','3','--format','json'], {
      monotonicNow: () => clock,
      loadCommand: async () => { clock += loadMs; return command; },
      stdout: { write: text => { stdout += text; clock += writeMs; } },
      stderr: { write: text => { stderr += text; } },
      deps: { executeLarkImHistory: (_options, deps) => {
        invoked++;
        const controls = { advance: ms => { clock += ms; }, budget: deps.historyCommandBudget };
        if (execute) return execute(controls);
        deps.historyCommandBudget.assertReady();
        return { ok: true, outcome: 'no_target', request_budget: { cli_attempts: 0 } };
      } },
    }),
  };
}

test('public history parser includes route import time in its bounded local work', async () => {
  let timeout;
  const f = harness({ loadMs: 750, execute: ({ budget }) => {
    timeout = budget.timeoutMs(); return { ok: true, outcome: 'no_target' };
  } });
  assert.equal(await f.run(), 0);
  assert.equal(timeout, 1500); // 3000 - 750 import - 750 contained cleanup reserve.
  assert.equal(JSON.parse(f.stdout).ok, true); assert.equal(f.stderr, '');
});

test('public history never starts local work after startup exhausts the command grant', async () => {
  const f = harness({ loadMs: 3100 });
  assert.equal(await f.run(), 1); assert.equal(JSON.parse(f.stdout).ok, false);
});

test('history serialization that exhausts the grant cannot publish a success document', async () => {
  const f = harness({ execute: ({ advance }) => ({ toJSON() { advance(3100); return { ok: true }; } }) });
  assert.equal(await f.run(), 1); assert.equal(JSON.parse(f.stdout).ok, false);
  assert.equal(f.stdout.trim().split('\n').length, 1);
});

test('late stdout completion leaves one document but a failed process and explicit diagnostic', async () => {
  const f = harness({ writeMs: 3100 });
  assert.equal(await f.run(), 1); assert.equal(JSON.parse(f.stdout).ok, true);
  assert.equal(f.invoked, 1); assert.match(f.stderr, /deadline/);
  assert.equal(f.stdout.match(/"ok"/g).length, 1);
});

test('each embedded CLI invocation starts a new grant instead of charging host uptime', async () => {
  const f = harness({ writeMs: 500 });
  assert.equal(await f.run(), 0); assert.equal(await f.run(), 0);
  assert.equal(f.invoked, 2); assert.equal(f.stderr, '');
});

test('actual guarded CLI charges startup and exits before any SQLite or API child', t => {
  const dir=mkdtempSync(join(tmpdir(),'synthetic-history-startup-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const preload=join(dir,'startup.mjs'), marker=join(dir,'unexpected-child');
  writeFileSync(preload,'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);\n');
  for(const name of ['sqlite3','lark']) writeFileSync(join(dir,name),`#!/bin/sh\nprintf called > '${marker.replaceAll("'", "'\\''")}'\nexit 97\n`,{mode:0o700});
  const child=runGuardedWorkerStep(process.execPath,['--import',preload,resolve('bin/exocortex.mjs'),
    'maintenance','history','--db',join(dir,'not-created.sqlite'),'--max-seconds','1','--format','json'],{
      cwd:dir,env:{...process.env,PATH:dir+':'+process.env.PATH,LARK_CLI:join(dir,'lark')},timeout:4000,
    });
  assert.equal(child.guardian_diagnostic,undefined,JSON.stringify(child));
  assert.equal(child.status,1);assert.equal(JSON.parse(child.stdout).ok,false);
  assert.equal(existsSync(marker),false);assert.equal(existsSync(join(dir,'not-created.sqlite')),false);
});

test('late outer preparation shrinks the actual history argument along with its guardian', () => {
  const args=['history','--max-seconds','22','--format','json'];let launched;
  const result=runStep('history',args,{command:'maintenance',timeoutMs:23000,remainingTimeMs:()=>10000,
    runProcess(_command,argv,options){launched={argv,options};return {status:0,stdout:'{"ok":true}',stderr:''};}});
  assert.equal(result.ok,true);assert.equal(launched.options.timeout,8000);
  assert.equal(launched.argv[launched.argv.indexOf('--max-seconds')+1],'7');
  assert.equal(args[args.indexOf('--max-seconds')+1],'22','scheduler input is not mutated');
});

test('late outer preparation leaving no complete history second starts no process', () => {
  const result=runStep('history',['history','--max-seconds','22'],{command:'maintenance',timeoutMs:23000,
    remainingTimeMs:()=>3500,runProcess(){assert.fail('no child after handoff reservation');}});
  assert.equal(result.ok,false);assert.match(result.stderr,/deadline/);
});
