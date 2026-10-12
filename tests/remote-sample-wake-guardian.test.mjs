import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/diagnostics/remote-sample-core.mjs';
import { createRemoteSamplePublication, REMOTE_SAMPLE_CACHE_GATE } from '../src/runtime/worker/remote-sample-cache-gate.mjs';

const NOW = 1_900_000_000_000;
const KEY = 'a'.repeat(64), ACCOUNT = 'b'.repeat(64), OBS = 'c'.repeat(64);
const hash = state => createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
const state = (changes = {}) => ({ kind: 'lark_im_remote_sample_schedule/v1', database_key: KEY, account_key: ACCOUNT,
  written_at: NOW - 60_000, next_due: NOW + 840_000, failures: 0, rotation: 0,
  observations: { [OBS]: { first_seen: NOW - 120_000, last_seen: NOW - 60_000, run_finished: NOW - 60_000,
    target: NOW - 86400_000, kind: 'content', debts: { body: NOW - 86400_000, deleted: NOW - 86400_000 }, scope_hash: 'd'.repeat(64) } },
  last_outcome: 'ok', cooldowns: {}, blocked_reason: null, ...changes });
const hint = value => ({ state_hash: hash(value), not_before: NOW });

// Only this synthetic interpreter starts. The helper sees a real private temp
// directory and a real held flock. No JS child, database or API is executed.
const HARNESS = String.raw`
import json,os,sys,fcntl,hashlib,types
payload=json.load(sys.stdin)
contract=payload['contract']
os.environ['EXOCORTEX_REMOTE_SAMPLE_PUBLICATION']=json.dumps(contract)
os.environ['EXOCORTEX_REMOTE_SAMPLE_LOCK_FD']='200'
os.environ.pop('EXOCORTEX_REMOTE_SAMPLE_WAKE',None)
if payload['wake'] is not None: os.environ['EXOCORTEX_REMOTE_SAMPLE_WAKE']=payload['wake']
fd=os.open(contract['lockPath'],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
held=fcntl.fcntl(fd,fcntl.F_DUPFD,200)
os.close(fd)
assert held==200
with open(contract['cachePath'],'rb') as f: cache_before=f.read()
with open(contract['statePath'],'rb') as f: state_before=f.read()
namespace={}
exec(payload['code'],namespace)
namespace['time']=types.SimpleNamespace(time=lambda: payload['now']/1000)
calls=[]
race_done=False
def read(fd,maximum):
    global race_done
    data=os.read(fd,maximum)
    if payload.get('race') and not race_done:
        race_done=True
        replacement=contract['statePath']+'.replacement'
        out=os.open(replacement,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        os.write(out,payload['race'].encode());os.close(out)
        os.replace(replacement,contract['statePath'])
    return data
def write(fd,data): calls.append('write');return os.write(fd,data)
def rename(*args,**kwargs): calls.append('rename');return os.rename(*args,**kwargs)
namespace['os']=types.SimpleNamespace(**{**vars(os),'read':read,'write':write,'rename':rename})
result=error=None
try: result=namespace['prepare_remote_sample_cache']()
except Exception as caught: error=type(caught).__name__
with open(contract['cachePath'],'rb') as f: cache_after=f.read()
with open(contract['statePath'],'rb') as f: state_after=f.read()
print(json.dumps({'result':result,'error':error,'calls':calls,'cache_unchanged':cache_before==cache_after,
 'state_unchanged':state_before==state_after,'state_is_race':bool(payload.get('race')) and state_after==payload['race'].encode(),
 'marker':b'lark_im_live_probe_cache/pending' in cache_after,'lock_still_open':os.fstat(held).st_ino==os.stat(contract['lockPath']).st_ino}))
os.close(held)
`;

function run(t, value, wake, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-guardian-wake-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'remote-sample'), { mode: 0o700 });
  const contract = createRemoteSamplePublication(root, KEY, '11111111-1111-4111-8111-111111111111');
  writeFileSync(contract.statePath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  writeFileSync(contract.cachePath, '{"synthetic_healthy_cache":true,"expires_at":1900000900000}\n', { mode: 0o600 });
  const result = spawnSync('python3', ['-B', '-c', HARNESS], { encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    input: JSON.stringify({ code: REMOTE_SAMPLE_CACHE_GATE, contract, wake: wake === undefined ? null :
      typeof wake === 'string' ? wake : JSON.stringify(wake), now: options.now ?? NOW, race: options.race }) });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function unchanged(output, due = NOW + 840_000) {
  assert.equal(output.error, null);
  assert.deepEqual(output.result, { outcome: 'not_due', reason: 'not_due', next_due: due, cooldownsByOperation: {}, cachePrepared: false });
  assert.equal(output.cache_unchanged, true); assert.equal(output.state_unchanged, true);
  assert.deepEqual(output.calls, []); assert.equal(output.lock_still_open, true);
}
function admitted(output) {
  assert.equal(output.error, null); assert.equal(output.result, null);
  assert.equal(output.state_unchanged, true); assert.equal(output.marker, true); assert.equal(output.cache_unchanged, false);
  assert.equal(output.lock_still_open, true);
}

test('matching wake at 60s invalidates old cache before inner JS; admission is not a successful sample', t => {
  // Root's separate inner-JS test checks an expired DB ticket never calls the
  // collector. This gate has already installed unavailable in that case;
  // neither cache preservation after admission nor sample success is promised.
  const value = state(); admitted(run(t, value, hint(value)));
});

test('canonical full-state hash ignores key order, whitespace and equivalent ASCII escapes', t => {
  const value = state({ cooldowns: { self_profile: NOW - 1, message_history_bundle: NOW - 2 }, observation_overflow: false });
  const reverse = v => v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k,x]) => [k,reverse(x)])) : v;
  const raw = JSON.stringify(reverse(value), null, 2).replace('"ok"', '"\\u006f\\u006b"');
  admitted(run(t, raw, hint(value)));
});

test('integer decimal/exponent forms and negative zero hash as JS safe integer values', t => {
  const value = state();
  const raw = JSON.stringify(value).replace(`"written_at":${value.written_at}`, `"written_at":${value.written_at}.0`)
    .replace(`"next_due":${value.next_due}`, `"next_due":${value.next_due}e0`).replace('"rotation":0', '"rotation":-0.0');
  admitted(run(t, raw, hint(JSON.parse(raw))));
});

test('no hint and invalid hints retain original not_due and all cache/state bytes', t => {
  const value = state();
  for (const wake of [undefined, '', '{', 'null', '[]', {}, { ...hint(value), extra: 1 },
    { ...hint(value), state_hash: 'f'.repeat(63) }, { ...hint(value), state_hash: hash(value).toUpperCase() },
    { ...hint(value), not_before: false }, { ...hint(value), not_before: -1 }, { ...hint(value), not_before: NOW + 0.5 },
    { ...hint(value), not_before: Number.MAX_SAFE_INTEGER + 1 }, ' '.repeat(513),
    `{"state_hash":"${hash(value)}","not_before":NaN}`]) unchanged(run(t, value, wake));
});

test('hash mismatch and extra root fields never promote an early schedule', t => {
  const value = state(), extra = { ...value, unexpected: 1 };
  unchanged(run(t, { ...value, rotation: 1 }, hint(value)));
  unchanged(run(t, extra, hint(value)));
  unchanged(run(t, extra, hint(extra)));
  const nested = structuredClone(value); nested.observations[OBS].debts.body += 1;
  unchanged(run(t, nested, hint(value)));
});

test('health fields retain type checks even with a matching state hash', t => {
  for (const change of [{ last_outcome: 'attempting' }, { last_outcome: 'busy' }, { last_outcome: 'failed' },
    { failures: 1 }, { failures: false }, { failures: '0' }, { account_key: null }, { account_key: 'bad' },
    { blocked_reason: 'cooldown_invalid' }, { blocked_reason: false }, { observation_overflow: 0 }, { rotation: false }]) {
    const value = state(change); unchanged(run(t, value, hint(value)));
  }
});

test('written-age, not_before and every cooldown are independent lower bounds', t => {
  const value = state();
  unchanged(run(t, value, { ...hint(value), not_before: NOW - 1 }));
  unchanged(run(t, value, { ...hint(value), not_before: NOW + 1 }));
  const young = state({ written_at: NOW - 59_999 }); unchanged(run(t, young, hint(young)));
  const cooling = state({ cooldowns: { self_profile: NOW + 1, message_history_bundle: NOW - 1 } });
  unchanged(run(t, cooling, hint(cooling)));
  const ready = state({ cooldowns: { self_profile: NOW, message_history_bundle: NOW - 1 } });
  admitted(run(t, ready, hint(ready)));
});

test('noninteger, nonfinite, unsafe and non-ASCII nested values cannot obtain canonical wake', t => {
  for (const rotation of [0.5, Number.MAX_SAFE_INTEGER + 1, '非ASCII']) {
    const value = state({ rotation }); unchanged(run(t, value, hint(value)));
  }
  const value = state();
  const nonfinite = JSON.stringify(value).replace('"rotation":0', '"rotation":NaN');
  unchanged(run(t, nonfinite, hint(value)));
});

test('a state replaced during stable reading rejects wake before any marker or cache mutation', t => {
  const value = state(), replacement = JSON.stringify(state({ rotation: 1 }));
  const output = run(t, value, hint(value), { race: replacement });
  assert.equal(output.error, 'ValueError'); assert.equal(output.cache_unchanged, true);
  assert.equal(output.state_is_race, true); assert.deepEqual(output.calls, []); assert.equal(output.lock_still_open, true);
});

test('bad hints do not block a naturally due schedule', t => {
  const value = state({ next_due: NOW });
  admitted(run(t, value, '{invalid'));
});
