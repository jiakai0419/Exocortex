import assert from 'node:assert/strict';
import test from 'node:test';
import { isSourceTombstone, SOURCE_TOMBSTONE_TEXT } from '../src/adapters/lark-im/source-tombstone.mjs';

test('neutral marker does not claim that upstream lost retained original content', () => {
  assert.equal(SOURCE_TOMBSTONE_TEXT, '[已撤回/已删除]');
});

test('each explicit own boolean source independently proves a retained tombstone', () => {
  for (const [canonical, raw] of [[{ deleted: true }, {}], [{}, { deleted: true }], [{}, { raw_api: { deleted: true } }],
    [{ deleted: true }, { raw_api: [] }], [Object.assign(Object.create(null), { deleted: true }), {}]]) {
    assert.equal(isSourceTombstone(canonical, raw), true);
  }
});

for (const value of ['true', 1, false, null, [], {}, undefined]) {
  test(`strict deleted flag rejects ${JSON.stringify(value)}`, () => {
    assert.equal(isSourceTombstone({ deleted: value }, {}), false);
    assert.equal(isSourceTombstone({}, { deleted: value }), false);
    assert.equal(isSourceTombstone({}, { raw_api: { deleted: value } }), false);
  });
}

test('arrays, scalars and inherited flags/wrappers are not native object evidence', () => {
  const array = Object.assign([], { deleted: true });
  const inherited = Object.create({ deleted: true });
  for (const value of [array, 'true', 1, true, false, null, undefined, inherited]) {
    assert.equal(isSourceTombstone(value, {}), false);
    assert.equal(isSourceTombstone({}, value), false);
    assert.equal(isSourceTombstone({}, { raw_api: value }), false);
  }
  assert.equal(isSourceTombstone({}, Object.create({ raw_api: { deleted: true } })), false);
});

test('accessors are never invoked to acquire a deleted flag or native wrapper', () => {
  let reads = 0;
  const flag = {};
  Object.defineProperty(flag, 'deleted', { get() { reads++; return true; } });
  const wrapper = {};
  Object.defineProperty(wrapper, 'raw_api', { get() { reads++; return { deleted: true }; } });
  assert.equal(isSourceTombstone(flag, {}), false);
  assert.equal(isSourceTombstone({}, flag), false);
  assert.equal(isSourceTombstone({}, { raw_api: flag }), false);
  assert.equal(isSourceTombstone({}, wrapper), false);
  assert.equal(reads, 0);
});
