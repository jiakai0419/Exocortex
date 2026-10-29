import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { liveProbeContext } from '../src/diagnostics/live-probe-cache.mjs';
import { readNameRecoveryReview, validateNameRecoveryReview } from '../src/adapters/lark-im/name-recovery-review.mjs';
import { prepareSidecarFixture } from './helpers/sidecar-fixture.mjs';

// Every path, identity, decision and clock is authored here; no user DB is read.
const ACCOUNT = 'a'.repeat(64), FOREIGN = 'b'.repeat(64), DAY = 86400000;
const NOW = Date.parse('2025-07-08T09:10:11.000Z');
const ALLOW = 'synthetic-reviewed-app', HOLD = 'synthetic-held-app';
const task = (actor_id = ALLOW, changes = {}) => ({ source_id: 'lark.im', account_key: ACCOUNT,
  kind: 'sender', namespace: 'app_id', actor_id, chat_id: 'oc_synthetic_review_chat', ...changes });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'exocortex-synthetic-name-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'synthetic.sqlite'), sidecar = `${db}.name-recovery-review.json`;
  writeFileSync(db, 'Invented file for inode binding; no SQLite query is performed.');
  const databaseKey = liveProbeContext(db).database_key;
  const value = { kind: 'lark_name_recovery_review/v1', context: {
    source_id: 'lark.im', database_key: databaseKey, account_key: ACCOUNT },
  review_kind: 'local_evidence_review', reviewed_at: new Date(NOW).toISOString(), entries: [
    { namespace: 'app_id', actor_id: ALLOW, decision: 'retry_unknown' },
    { namespace: 'app_id', actor_id: HOLD, decision: 'hold' },
  ] };
  const save = (input = value) => {
    writeFileSync(sidecar, typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input), { mode: 0o600 });
    prepareSidecarFixture(sidecar);
  };
  return { directory, db, sidecar, databaseKey, value, save,
    read: (at = NOW, account = ACCOUNT) => readNameRecoveryReview(db, account, at) };
}
function safeThrow(action, f, code) {
  assert.throws(action, error => {
    if (code) assert.equal(error.code, `name_recovery_review_${code}`);
    assert.match(error.code, /^name_recovery_review_/);
    for (const secret of [f.directory, ALLOW, HOLD, ACCOUNT]) assert(!error.message.includes(secret));
    return true;
  });
}

test('missing review grants nothing and reading creates no file or database mutation', t => {
  const f = fixture(t), before = readFileSync(f.db);
  assert.equal(f.read(), null); assert.deepEqual(readFileSync(f.db), before);
  assert.throws(() => statSync(f.sidecar), { code: 'ENOENT' });
});

test('only explicitly reviewed exact typed app targets accelerate, while holds apply across chats', t => {
  const f = fixture(t); f.save(); const review = f.read(), before = readFileSync(f.sidecar);
  assert.deepEqual(review.retryUnknownActors, [ALLOW]); assert.deepEqual(review.heldActors, [HOLD]);
  assert(Object.isFrozen(review.retryUnknownActors)); assert(Object.isFrozen(review.heldActors));
  assert.throws(() => review.retryUnknownActors.push('synthetic-other'), TypeError);
  assert.throws(() => { review.heldActors = []; }, TypeError);
  assert.equal(review.canAccelerate(task(), NOW), true);
  assert.equal(review.isHeld(task(), NOW), false);
  assert.equal(review.isHeld(task(HOLD), NOW), true);
  assert.equal(review.isHeld(task(HOLD, { chat_id: 'oc_synthetic_other_chat' }), NOW), true);
  assert.equal(review.canAccelerate(task(HOLD), NOW), false);
  for (const target of [null, {}, task('synthetic-unlisted-app'), task(ALLOW, { kind: 'chat' }),
    task(ALLOW, { namespace: 'open_id' }), task(ALLOW, { source_id: 'other' }), task(ALLOW, { account_key: FOREIGN })]) {
    assert.equal(review.canAccelerate(target, NOW), false); assert.equal(review.isHeld(target, NOW), false);
  }
  assert.deepEqual(readFileSync(f.sidecar), before);
});

test('positive review expires at a fixed 24 hours across repeated reads; hold never expires', t => {
  const f = fixture(t); f.save(); const review = f.read();
  assert.equal(review.canAccelerate(task(), NOW + DAY - 1), true);
  assert.equal(review.canAccelerate(task(), NOW + DAY), false);
  assert.equal(f.read(NOW + DAY).canAccelerate(task(), NOW + DAY), false);
  assert.equal(review.isHeld(task(HOLD), NOW + 100 * DAY), true);
  assert.equal(f.read(NOW + 100 * DAY).isHeld(task(HOLD), NOW + 100 * DAY), true);
  safeThrow(() => review.assertCurrent(NOW + DAY), f, 'invalid_clock');
});

test('read and later authorization reject invalid, future and backwards clocks', t => {
  const f = fixture(t); f.save();
  for (const at of [-1, NaN, Infinity, NOW + 0.5]) safeThrow(() => f.read(at), f);
  safeThrow(() => f.read(NOW - 1), f, 'invalid_clock');
  const review = f.read(); review.assertCurrent(NOW + 10);
  safeThrow(() => review.canAccelerate(task(), NOW + 9), f, 'invalid_clock');
  safeThrow(() => review.isHeld(task(HOLD), NOW), f, 'invalid_clock');
});

test('strict schema rejects unknown fields, duplicate entries, namespaces, dates and bindings', t => {
  const f = fixture(t);
  const cases = [
    value => { value.extra = true; }, value => { value.context.extra = true; },
    value => { value.entries[0].extra = true; }, value => { value.kind = 'other'; },
    value => { value.review_kind = 'automatic_guess'; }, value => { delete value.review_kind; },
    value => { value.context.source_id = 'other'; }, value => { value.context.database_key = 'b'.repeat(64); },
    value => { value.context.account_key = FOREIGN; }, value => { value.reviewed_at = '2025-07-08'; },
    value => { value.reviewed_at = new Date(NOW + 1).toISOString(); }, value => { value.entries = {}; },
    value => { value.entries.push({ ...value.entries[0], decision: 'hold' }); },
    value => { value.entries[0].namespace = 'open_id'; }, value => { delete value.entries[0].namespace; },
    value => { value.entries[0].decision = 'allow'; }, value => { value.entries[0].actor_id = ''; },
    value => { value.entries[0].actor_id = ' padded '; }, value => { value.entries[0].actor_id = 'hidden\u0000actor'; },
    value => { value.entries[0].actor_id = 'x'.repeat(513); },
    value => { value.entries = Array.from({ length: 129 }, (_, i) => ({ namespace: 'app_id', actor_id: `synthetic-${i}`, decision: 'hold' })); },
  ];
  for (const change of cases) { const value = structuredClone(f.value); change(value); f.save(value); safeThrow(() => f.read(), f); }
  f.save(); safeThrow(() => f.read(NOW, FOREIGN), f, 'account_mismatch');
  for (const account of ['', 'invalid', null]) safeThrow(() => f.read(NOW, account), f, 'invalid_context');
  const empty = structuredClone(f.value); empty.entries = []; f.save(empty);
  assert.equal(f.read().canAccelerate(task(), NOW), false);
  const max = structuredClone(f.value); max.entries = Array.from({ length: 128 }, (_, i) => ({ namespace: 'app_id', actor_id: `synthetic-${i}`, decision: 'hold' }));
  assert.equal(validateNameRecoveryReview(max, f.databaseKey, ACCOUNT, NOW).entries.size, 128);
});

test('strict source JSON rejects duplicate and escaped duplicate keys, invalid UTF-8 and oversize', t => {
  const f = fixture(t), text = JSON.stringify(f.value);
  for (const input of [text.replace('"kind":', '"kind":"wrong","kind":'),
    text.replace('"decision":', '"decisi\\u006fn":"hold","decision":'),
    text.replace('"account_key":', '"account_key":"bad","account_key":'), '{',
    Buffer.from([0xff, 0xfe]), ' '.repeat(65537)]) { f.save(input); safeThrow(() => f.read(), f); }
});

test('review files require 0600, current owner, one link and a regular nonsymlink file', t => {
  const f = fixture(t); f.save();
  for (const mode of [0o644, 0o400, 0o660, 0o700]) { chmodSync(f.sidecar, mode); safeThrow(() => f.read(), f, 'unsafe_file'); }
  chmodSync(f.sidecar, 0o600);
  const getuid = process.getuid;
  try { process.getuid = () => getuid() + 1; safeThrow(() => f.read(), f, 'unsafe_file'); }
  finally { process.getuid = getuid; }
  linkSync(f.sidecar, join(f.directory, 'hardlink')); safeThrow(() => f.read(), f, 'unsafe_file');
  unlinkSync(join(f.directory, 'hardlink'));
  renameSync(f.sidecar, `${f.sidecar}.real`); symlinkSync(`${f.sidecar}.real`, f.sidecar); safeThrow(() => f.read(), f, 'unsafe_file');
  unlinkSync(f.sidecar); mkdirSync(f.sidecar); safeThrow(() => f.read(), f, 'unsafe_file');
});

test('FIFO cannot block the reader', t => {
  const f = fixture(t); assert.equal(spawnSync('mkfifo', [f.sidecar]).status, 0);
  const module = new URL('../src/adapters/lark-im/name-recovery-review.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {readNameRecoveryReview} from ${JSON.stringify(module)};try{readNameRecoveryReview(process.argv[1],process.argv[2],Number(process.argv[3]));process.exitCode=2}catch(e){process.stdout.write(e.code)}`,
    f.db, ACCOUNT, String(NOW)], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0);
  assert.equal(child.stdout, 'name_recovery_review_unsafe_file');
});

test('replaced, removed, edited and permission-roundtripped review snapshots cannot authorize later work', t => {
  for (const mutate of [
    f => { renameSync(f.sidecar, `${f.sidecar}.old`); f.save(); },
    f => { unlinkSync(f.sidecar); },
    f => { const before = statSync(f.sidecar); const text = readFileSync(f.sidecar, 'utf8').replace(ALLOW, 'synthetic-reviewed-apq');
      writeFileSync(f.sidecar, text); utimesSync(f.sidecar, before.atime, before.mtime); },
    f => { chmodSync(f.sidecar, 0o644); chmodSync(f.sidecar, 0o600); },
  ]) { const f = fixture(t); f.save(); const review = f.read(); mutate(f); safeThrow(() => review.assertCurrent(NOW), f); }
});

test('database replacement, a copied database or retargeted requested path cannot reuse review authority', t => {
  const f = fixture(t); f.save(); const review = f.read();
  const copied = join(f.directory, 'copied.sqlite'); copyFileSync(f.db, copied); copyFileSync(f.sidecar, `${copied}.name-recovery-review.json`);
  safeThrow(() => readNameRecoveryReview(copied, ACCOUNT, NOW), f, 'database_mismatch');
  renameSync(f.db, `${f.db}.old`); writeFileSync(f.db, 'replacement synthetic inode');
  safeThrow(() => review.assertCurrent(NOW), f, 'database_mismatch');
  const g = fixture(t); g.save(); const alias = join(g.directory, 'requested.sqlite'); symlinkSync(g.db, alias);
  const aliased = readNameRecoveryReview(alias, ACCOUNT, NOW); assert.equal(aliased.canAccelerate(task(), NOW), true);
  unlinkSync(alias); symlinkSync(copied, alias); safeThrow(() => aliased.assertCurrent(NOW), g, 'database_mismatch');
});
