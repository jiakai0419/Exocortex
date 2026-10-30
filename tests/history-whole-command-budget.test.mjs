import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryCommandBudget, HistoryCommandBudgetError } from '../src/maintenance/history-command-budget.mjs';
import { createMaintenanceRequestSession, MaintenanceRequestError } from '../src/maintenance/request-session.mjs';
import { executeLarkImHistory } from '../src/maintenance/history.mjs';

const isReason = reason => error => error instanceof HistoryCommandBudgetError && error.reason === reason;
const args = ['contact', '+search-user', '--user-ids', 'ou_synthetic_budget', '--format', 'json'];

// Clock-controlled boundary cases establish deadline arithmetic, not runtime
// latency. Real SQLite and spawned-process coverage lives in the storage tests.
test('initial caller time and later shortening cannot be refunded by a larger parent remainder', () => {
  let tick = 700, parentLeft = 2300;
  const budget = createHistoryCommandBudget({maxSeconds: 3}, {monotonicClock: () => tick, remainingTimeMs: () => parentLeft});
  assert.equal(budget.timeoutMs(), 1550);
  tick = 1000; parentLeft = 1000; assert.equal(budget.timeoutMs(), 250);
  parentLeft = 10000; assert.equal(budget.timeoutMs(), 250);
  tick = 1250; assert.throws(budget.assertReady, isReason('time_budget'));
  assert.equal(budget.remainingMs(), 750);
  budget.assertOutputReady();
  assert.equal(budget.summary().elapsed_ms, 550);
});

test('normal negative inherited remainder is exhausted time rather than a broken clock', () => {
  const budget = createHistoryCommandBudget({maxSeconds: 1}, {monotonicClock: () => 1000, remainingTimeMs: () => -3});
  assert.throws(budget.assertReady, isReason('time_budget'));
  assert.throws(budget.assertOutputReady, isReason('time_budget'));
});

for (const invalid of [NaN, Infinity, undefined]) test(`nonfinite inherited remainder ${invalid} is never a fresh grant`, () => {
  assert.throws(() => createHistoryCommandBudget({maxSeconds: 1}, {remainingTimeMs: () => invalid}), isReason('clock_unavailable'));
});

test('clock reversal stops work and cannot be cleared by a later valid sample', () => {
  let tick = 20;
  const budget = createHistoryCommandBudget({maxSeconds: 2}, {monotonicClock: () => tick});
  tick = 19; assert.throws(budget.assertReady, isReason('clock_unavailable'));
  tick = 30; assert.throws(budget.assertOutputReady, isReason('clock_unavailable'));
  assert.equal(budget.summary().complete, false);
});

test('cleanup and output consume reservations within the original deadline', () => {
  let tick = 0, cleaned = 0;
  const budget = createHistoryCommandBudget({maxSeconds: 4}, {monotonicClock: () => tick});
  tick = 3100; assert.throws(budget.assertReady, isReason('time_budget'));
  const value = budget.runCleanup(() => { assert.equal(budget.timeoutMs(), 800); cleaned++; tick = 3900; return 'known release'; });
  assert.equal(value, 'known release'); assert.equal(cleaned, 1);
  budget.assertOutputReady(); tick = 4000; assert.throws(budget.assertOutputReady, isReason('time_budget'));
  assert.throws(() => budget.runCleanup(() => cleaned++), isReason('time_budget'));
  assert.equal(cleaned, 1);
});

function sessionFixture() {
  const state = {tick: 0, held: false, releases: 0, requests: [], acquisitions: []};
  const budget = createHistoryCommandBudget({maxSeconds: 4}, {monotonicClock: () => state.tick});
  state.tick = 2000; // Real selectors occurred before the session was constructed.
  const session = createMaintenanceRequestSession({db:'/synthetic/never-opened', maxSeconds:4, maxCliAttempts:4}, {
    commandBudget:budget, monotonicClock: () => state.tick, now: () => 2_000_000_000_000,
    env:{LARK_CLI:'synthetic-never-spawned'}, sleep(ms) { assert.equal(state.held,false); state.tick += ms; },
    tryAcquireLease(options) { state.acquisitions.push(options); state.held=true; return {state:'acquired', release(){state.held=false; state.releases++;}}; },
    readSharedCooldown: () => ({state:'ready'}), writeSharedCooldown: () => true,
    spawnSync(_command, _args, options) { state.requests.push(options); return {status:0,stdout:'{}',stderr:''}; },
  });
  return {state,budget,session};
}

test('session request and lease consume initial selection time and do not start a late fallback', () => {
  const {state,session} = sessionFixture();
  session.runLark(args);
  assert.equal(state.requests[0].timeout, 1000);
  assert.equal(state.acquisitions[0].monotonicDeadlineMs, 3000);
  assert.throws(() => session.runLark(args), error => error instanceof MaintenanceRequestError && error.reason === 'time_budget');
  assert.equal(state.requests.length,1); assert.equal(state.releases,1); assert.equal(state.held,false);
  assert.equal(session.summary().cli_attempts,1); assert.equal(session.summary().elapsed_ms,2000);
});

test('a known committed result survives the work cutoff; no next action is admitted', () => {
  const {state,budget,session} = sessionFixture();
  const result = session.withCommit(() => {state.tick=3500; return {updated:1};});
  assert.deepEqual(result,{updated:1}); assert.equal(state.releases,1);
  assert.throws(() => session.withCommit(() => assert.fail('late write')), error => error instanceof MaintenanceRequestError && error.reason === 'time_budget');
  assert.equal(state.acquisitions.length,1); budget.assertOutputReady();
});

test('initial selector uses a bounded timeout and reports its own exhausted cost before any session', () => {
  let tick = 0, reads = 0;
  const budget = createHistoryCommandBudget({maxSeconds:2}, {monotonicClock: () => tick});
  const result = executeLarkImHistory({db:'/synthetic/never-opened',maxSeconds:2}, {
    historyCommandBudget:budget,
    sqliteJson(_db,_sql,_label,settings) { reads++; assert.equal(settings.timeoutMs,1500); tick=1600; return []; },
    createRequestSession() { assert.fail('no late session'); },
  });
  assert.equal(reads,1); assert.equal(result.outcome,'batch_deferred');
  assert.equal(result.request_budget.cli_attempts,0); assert.equal(result.request_budget.elapsed_ms,1600);
  assert.equal(result.request_budget.stop_reason,'time_budget');
});

test('a no-target read retains whole-command cost and an already expired command starts no SQLite child', () => {
  let tick=0;
  const result=executeLarkImHistory({db:'/synthetic/never-opened',maxSeconds:2}, {
    monotonicClock:()=>tick, sqliteJson(){tick=20;return [];}, createRequestSession(){assert.fail('no session');},
  });
  assert.equal(result.outcome,'no_eligible_known_record'); assert.equal(result.request_budget.elapsed_ms,20);
  const budget=createHistoryCommandBudget({maxSeconds:2},{monotonicClock:()=>tick}); tick=1600;
  const deferred=executeLarkImHistory({db:'/synthetic/never-opened',maxSeconds:2},{historyCommandBudget:budget,
    sqliteJson(){assert.fail('late query');}, createRequestSession(){assert.fail('late session');}});
  assert.equal(deferred.outcome,'batch_deferred'); assert.equal(deferred.request_budget.cli_attempts,0);
});

test('an expired domain receipt is inspectable but is not eligible for CLI publication', () => {
  let tick=0;
  const budget=createHistoryCommandBudget({maxSeconds:2},{monotonicClock:()=>tick});
  const result=executeLarkImHistory({db:'/synthetic/never-opened',maxSeconds:2},{historyCommandBudget:budget,
    sqliteJson(){tick=2100;return [];},createRequestSession(){assert.fail('no session after cutoff');}});
  assert.equal(result.outcome,'batch_deferred');assert.equal(result.request_budget.cli_attempts,0);
  assert.equal(result.request_budget.stop_reason,'time_budget');assert.equal(result.command_budget.elapsed_ms,2100);
  assert.throws(budget.assertOutputReady,isReason('time_budget'),'the CLI publication boundary must reject this receipt');
});

test('a failing read at the work cutoff is time exhaustion; an earlier error keeps its actual identity', () => {
  for(const exhausted of [false,true]) {
    let tick=0;
    const original=new Error('synthetic read failure');
    const budget=createHistoryCommandBudget({maxSeconds:2},{monotonicClock:()=>tick});
    const call=()=>executeLarkImHistory({db:'/synthetic/never-opened',maxSeconds:2},{historyCommandBudget:budget,
      sqliteJson(){tick=exhausted?1600:10;throw original;},createRequestSession(){assert.fail('no session');}});
    if(exhausted){const result=call();assert.equal(result.request_budget.stop_reason,'time_budget');assert.equal(result.processed,0);}
    else assert.throws(call,error=>error===original);
  }
});

test('a trusted context cannot accidentally enlarge this history invocation grant', () => {
  const budget=createHistoryCommandBudget({maxSeconds:3});
  assert.throws(()=>executeLarkImHistory({db:'/synthetic/never-opened',maxSeconds:2},{historyCommandBudget:budget,
    sqliteJson(){assert.fail('no expanded local read');}}),/invalid internal history command budget/);
});

test('commit lease deadline cannot grow during a delayed session clock read', () => {
  let tick=0, advance=false, leaseDeadline;
  const budget=createHistoryCommandBudget({maxSeconds:4},{monotonicClock:()=>tick});
  const session=createMaintenanceRequestSession({maxSeconds:4},{commandBudget:budget,
    monotonicClock:()=>{if(advance)tick+=100;return tick;},
    tryAcquireLease(options){leaseDeadline=options.monotonicDeadlineMs;return {state:'acquired',release(){}};},
    readSharedCooldown:()=>({state:'ready'}),writeSharedCooldown:()=>true,
    spawnSync(){assert.fail('no remote request');},sleep(){assert.fail('no waiting');},
  });
  tick=2000;advance=true;
  assert.equal(session.withCommit(()=>7),7);
  assert.equal(leaseDeadline,3000,'work deadline remains original grant minus its contained completion reserve');
});

test('an earlier same-process invocation origin includes actual startup in elapsed and deadline', () => {
  let tick=700;
  const budget=createHistoryCommandBudget({maxSeconds:3},{startedMonotonicMs:0,monotonicClock:()=>tick,
    remainingTimeMs:()=>3000-tick});
  assert.equal(budget.summary().elapsed_ms,700);assert.equal(budget.timeoutMs(),1550);
  tick=2200;assert.equal(budget.timeoutMs(),50);assert.equal(budget.summary().elapsed_ms,2200);
  tick=2250;assert.throws(budget.assertReady,isReason('time_budget'));budget.assertOutputReady();
});

for(const start of [null,'0',NaN,Infinity,101]) test(`invalid invocation clock origin ${start} cannot grant more work`, () => {
  assert.throws(()=>createHistoryCommandBudget({maxSeconds:3},{startedMonotonicMs:start,monotonicClock:()=>100}),isReason('clock_unavailable'));
});
