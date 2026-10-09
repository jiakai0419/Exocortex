import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { publicStatusReport } from '../src/diagnostics/status-report.mjs';
import { renderStatusText } from '../src/terminal/status-view.mjs';
import { plain } from '../dist/terminal/index.js';
import { rawStatusScreenFixture, STATUS_SCREEN_NOW } from './helpers/status-screen-fixture.mjs';
import { fixture, options } from './helpers/check-fixture.mjs';
import { collectCheckReport } from '../src/diagnostics/check-report.mjs';
import { runReadOnlyRemoteSample } from '../src/diagnostics/remote-sample.mjs';

const stream=Object.assign(new Writable({write(_c,_e,done){done()}}),{isTTY:false});
function freshness(overrides={}) { return {scope:'discovered_chats_rotating',status:'sampled',result:'healthy',auth_identity:'verified_at_check',
  sample_count:40,chat_count:3,checked_at:new Date(STATUS_SCREEN_NOW-2000).toISOString(),expires_at:new Date(STATUS_SCREEN_NOW+1800000).toISOString(),
  window:{start:new Date(STATUS_SCREEN_NOW-87000000).toISOString(),end:new Date(STATUS_SCREEN_NOW-600000).toISOString()},
  sample:{hot_chats:2,fair_chats:1,eligible_chats:20,truncated_chats:1},binding:{state:'verified',evidence:'single_sent_actor'},
  findings:{missing:0,pending_sync:0,suspected_missing:0,confirmed_missing:0,stale_version:0,content_mismatch:0,content_equal:30,content_unverified:10,unresolved_prior:0},...overrides}; }
function report(f) { const raw=rawStatusScreenFixture('healthy'); raw.overview.freshness=f;return publicStatusReport({report:raw,service:raw.probe,installed:{status:'installed'},observedAt:STATUS_SCREEN_NOW},{detail:true}); }

test('remote sample row states actual evidence/time; details disclose bounded content/identity without leaking hashes',()=>{
  const value=report(freshness({account_key:'private-hash',raw:'synthetic private payload'}));
  assert.equal(value.freshness.auth_identity,'verified_at_check');assert.equal(value.freshness.chat_count,3);assert.equal(JSON.stringify(value).includes('private-hash'),false);
  for(const columns of [48,96]){
    const rendered=plain(renderStatusText(value,{columns,stream}));assert.match(rendered.replace(/\s+/g,' '),/Sample matched.*40 messages \/ 3 discovered chats.*checked/);
    for(const line of rendered.split('\n'))assert.ok([...line].length<=columns);
  }
  const detailed=plain(renderStatusText(value,{columns:96,stream,detail:true}));assert.match(detailed,/30 static bodies matched/);assert.match(detailed,/stored sent identity/);
});

test('suspected, confirmed, pending, unavailable and expired remain distinct on the sample line',()=>{
  for(const [f,expected] of [
    [freshness({status:'behind',result:'delayed',findings:{suspected_missing:2}}),/2 suspected missing/],
    [freshness({status:'behind',result:'needs_attention',findings:{confirmed_missing:1}}),/1 confirmed missing/],
    [freshness({status:'behind',result:'delayed',findings:{pending_sync:3}}),/3 awaiting sync/],
    [freshness({status:'unknown',result:'unavailable'}),/Not verified/],
    [freshness({status:'unknown',reason:'expired'}),/Expired/],
  ])assert.match(plain(renderStatusText(report(f),{columns:120,stream})),expected);
});

test('status separates current samples from bounded historical targets and rejects private historical fields', () => {
  const end = Date.parse(freshness().window.start) - 1000;
  const history = { requested: 1, chats_checked: 1, pages: 1, messages_checked: 1, unsupported_chats: 0,
    truncated_chats: 0, unroutable: 0, window: { start: new Date(end - 3000).toISOString(), end: new Date(end).toISOString() } };
  const projected = report(freshness({ history, sample_count: 5, chat_count: 4 }));
  assert.deepEqual(projected.freshness.history, history);
  for (const columns of [48, 96]) {
    const rendered = plain(renderStatusText(projected, { columns, stream, detail: true }));
    assert.match(rendered.replace(/\s+/g, ' '), /4 current messages \/ 4 chats \+ 1 historical target/);
    assert.match(rendered.replace(/\s+/g, ' '), /Historical revisit 1 target observed/);
    assert.match(rendered.replace(/\s+/g, ' '), /History window/);
    for (const line of rendered.split('\n')) assert.ok([...line].length <= columns);
  }
  for (const invalid of [{ ...history, body: 'SYNTHETIC_PRIVATE_BODY' }, { ...history, messages_checked: 2 },
    { ...history, window: { start: new Date(STATUS_SCREEN_NOW).toISOString(), end: new Date(STATUS_SCREEN_NOW + 3000).toISOString() } }]) {
    const value = report(freshness({ history: invalid }));
    assert.equal(value.freshness.status, 'unknown'); assert.equal(value.freshness.result, 'unavailable');
    assert.equal(value.freshness.history, undefined);
    assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_PRIVATE_BODY/);
    assert.doesNotMatch(plain(renderStatusText(value, { columns: 96, stream })), /Sample matched/);
  }
});

test('manual cache-writing check shares scheduler and respects not_due without directly invoking collector',async()=>{
  const f=fixture();let scheduler=0;
  f.deps.runManualRemoteSample=(opts,deps)=>{scheduler++;assert.equal(opts.db,'/tmp/invented.sqlite');assert.ok(deps.collectorOptions.endMs);return{outcome:'not_due',reason:'not_due'}};
  f.deps.collectRemoteSample=()=>assert.fail('bypassed shared scheduler');
  const result=await collectCheckReport(options({live:true,writeLiveCache:true}),f.context,f.deps);
  assert.equal(scheduler,1);assert.equal(result.exit_code,2);assert.equal(result.cache.status,'skipped');assert.equal(result.checks.live.evidence.reason,'not_due');
});

test('one-shot no-cache checks include every local and remote phase in the 60 second child bound',()=>{
  let call;
  const result=runReadOnlyRemoteSample('/synthetic/db',{}, {now:()=>STATUS_SCREEN_NOW,spawnSync:(bin,args,opts)=>{call={args,opts};return{status:null,signal:'SIGKILL'}}});
  assert.equal(call.args[3],'60000');assert.equal(call.opts.timeout,62000);assert.equal(call.opts.killSignal,'SIGTERM');assert.equal(JSON.parse(call.opts.input).mode,'read_only');
  assert.equal(result.outcome,'failed');assert.equal(result.report.reason,'sample_process_failed');
});
