import assert from 'node:assert/strict';
import test from 'node:test';
import { patchJsonText, patchTopLevelJsonMemberText, mergeJsonObjectText, validateJsonObjectText } from '../dist/core/json-text-patch.js';
import { retainSourceRepresentation } from '../dist/core/lark-observation.js';

const tokenValues = ['9007199254740993', '18446744073709551617', '0.12345678901234567890123456789', '1e400', '-0'];
test('one owned root member preserves every original byte through append, refresh and removal', () => {
  for (const original of ['{}', ' { \n }\n', '{"a":1}', '{\n  "a": [1, {"x": -0}],\n  "opaque": 9007199254740993\n}\n']) {
    const added = patchTopLevelJsonMemberText(original, 'owned', '{"name":"synthetic"}');
    assert.deepEqual(JSON.parse(added).owned, { name: 'synthetic' });
    const refreshed = patchTopLevelJsonMemberText(added, 'owned', '{"name":"new"}');
    assert.equal(patchTopLevelJsonMemberText(refreshed, 'owned'), original);
    assert.equal(patchTopLevelJsonMemberText(original, 'absent'), original);
  }
  for (const key of ['a', 'b', 'c']) {
    const original = ' { "a" : 1, "b" : 2, "c" : 3 }\n';
    const changed = patchTopLevelJsonMemberText(original, key, '9007199254740993');
    assert.equal(changed, original.replace(`"${key}" : ${{ a: 1, b: 2, c: 3 }[key]}`, `"${key}" : 9007199254740993`));
    const deleted = JSON.parse(patchTopLevelJsonMemberText(original, key));
    assert.equal(Object.hasOwn(deleted, key), false);
    assert.equal(Object.keys(deleted).length, 2);
  }
  for (const invalid of ['[]', '{"a":1,"a":2}', '{bad}', '{"a":1}x']) assert.throws(() => patchTopLevelJsonMemberText(invalid, 'owned', '1'));
  assert.throws(() => patchTopLevelJsonMemberText('{}', 'owned', 'not-json'));
});
for (const token of tokenValues) test(`owned field edit preserves unknown numeric token ${token}`, () => {
  const nested = `{ "arr" : [${token},null,{"inner":${token}}] }`;
  const before = `{ "unknown" : ${nested}, "owned" : "old" }`;
  const after = patchJsonText(before, [{ path: ['owned'], value: '"new"' }], [['owned']]);
  assert.ok(after.includes(`"unknown" : ${nested}`));
  assert.equal(JSON.parse(after).owned, 'new');
  assert.equal(patchJsonText(before, [], []), before);
});

test('nested fixed paths retain unknown partner fields and explicit deletion differs from null', () => {
  const before = '{"partner":{"unknown":18446744073709551617,"name":"Old","state":"clear"},"unknown":-0}';
  const after = patchJsonText(before, [{ path: ['partner', 'name'], value: 'null' }, { path: ['partner', 'state'] }],
    [['partner', 'name'], ['partner', 'state']]);
  assert.equal(after, '{"partner":{"unknown":18446744073709551617,"name":null},"unknown":-0}');
  assert.equal(patchJsonText('{"unknown":1e400}', [{ path: ['absent', 'name'] }], [['absent', 'name']]), '{"unknown":1e400}');
  assert.equal(patchJsonText('{}', [{ path: ['new', 'name'], value: '"New"' }], [['new', 'name']]), '{"new":{"name":"New"}}');
  assert.throws(() => patchJsonText('{"partner":null}', [{ path: ['partner', 'name'], value: '"X"' }], [['partner', 'name']]), /object_required/);
});

test('every nested duplicate (including escaped names) and malformed/over-budget input fails closed', () => {
  for (const text of ['{"a":1,"a":2}', '{"array":[{"a":1,"\\u0061":2}]}', '{"a":{"b":1,"b":2}}',
    '{"a":01}', '{"a":NaN}', '{"a":1,}', '{"a":[1,]}', '{"a":truex}', '{"a":"bad\nstring"}', 'null', '[]']) {
    assert.throws(() => validateJsonObjectText(text), /json_patch/);
  }
  assert.throws(() => patchJsonText('{}', [{ path: ['a'], value: '{"duplicate":1,"duplicate":2}' }], [['a']]), /duplicate_key/);
  assert.throws(() => validateJsonObjectText('{"huge":"' + 'x'.repeat(1024 * 1024) + '"}'), /limit/);
  assert.throws(() => validateJsonObjectText('{"deep":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'), /limit/);
  assert.throws(() => validateJsonObjectText('{"nodes":[' + '0,'.repeat(20000) + '0]}'), /limit/);
});

test('unowned, repeated and overlapping paths cannot mutate the document', () => {
  assert.throws(() => patchJsonText('{}', [{ path: ['unknown'], value: '0' }], [['owned']]), /unowned_path/);
  assert.throws(() => patchJsonText('{}', [{ path: ['a'], value: '{}' }, { path: ['a', 'b'], value: '0' }], [['a'], ['a', 'b']]), /overlapping/);
  assert.throws(() => patchJsonText('{}', [{ path: ['a'], value: '0' }, { path: ['a'], value: '1' }], [['a']]), /overlapping/);
});

test('canonical merge retains old-only unknowns, overwrites present unknowns as whole raw values, and deletes only listed missing fields', () => {
  const old = '{"old_only":1e400,"same":{"old":9007199254740993},"mentions":["old"],"create_time":"old","derived":"old","keep_null":null}';
  const next = '{"same":{"new":18446744073709551617},"new_only":-0,"mentions":["new"],"create_time":"new","keep_null":null}';
  const result = mergeJsonObjectText(old, next, { retain: ['mentions', 'create_time'], deleteMissing: ['derived'] });
  assert.equal(result, '{"old_only":1e400,"same":{"new":18446744073709551617},"mentions":["old"],"create_time":"old","keep_null":null,"new_only":-0}');
  const before = { raw_json: 'retained raw', content_hash: 'retained hash', canonical_json: old };
  const incoming = { raw_json: 'incoming raw', content_hash: 'incoming hash', canonical_json: next };
  const retained = retainSourceRepresentation(before, incoming);
  assert.equal(retained.raw_json, before.raw_json); assert.equal(retained.content_hash, before.content_hash);
  assert.match(retained.canonical_json, /"old_only":1e400/); assert.match(retained.canonical_json, /"new":18446744073709551617/);
  assert.throws(() => mergeJsonObjectText('{"a":1,"a":2}', '{}', { retain: [], deleteMissing: [] }), /duplicate_key/);
  assert.throws(() => mergeJsonObjectText('{}', '{"nested":{"a":1,"a":2}}', { retain: [], deleteMissing: [] }), /duplicate_key/);
});
