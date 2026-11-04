import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiMessage, renderApiMessageContent } from '../src/adapters/lark-im/raw-message.mjs';
import { createImageSlot, createImageContext, attestVerifiedImageRead, createVerifiedImageResolution } from '../src/adapters/lark-im/media-image-slot.mjs';

// Every input below is authored fiction, independent of private message data.
const text = value => ({ tag: 'text', text: value });
const img = (key = 'img_invented_mountain') => ({ tag: 'img', image_key: key, width: 24, height: 12 });
const native = payload => ({ message_id: 'om_invented_post_semantics', msg_type: 'post',
  create_time: '1700000000000', update_time: '1700000000001', chat_id: 'oc_invented_post_semantics',
  sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_invented_post_author' },
  body: { content: JSON.stringify(payload) }, mentions: [] });

test('post preserves both image/text orders and exposes only ordered image references', () => {
  for (const elements of [[img(), text('Fiction after')], [text('Fiction before'), img()]]) {
    const rendered = renderApiMessageContent(native({ content: [elements] }));
    assert.equal(rendered.status, 'partial');
    assert.equal(rendered.version, 2);
    assert.equal(rendered.media_slots.length, 1);
    assert.equal(rendered.media_slots[0].slot_id, `/content/0/${elements[0].tag === 'img' ? 0 : 1}`);
    assert.equal(rendered.media_slots[0].message_type, 'post');
    assert.equal(rendered.media_slots[0].reference_kind, 'image_key');
    assert.equal(rendered.media_slots[0].key, 'img_invented_mountain');
    assert.equal(rendered.text.includes('img_invented_mountain'), false);
    assert.equal(rendered.text.includes('原始内容'), false);
    const marker = rendered.text.indexOf('[图片');
    assert.ok(marker >= 0);
    assert.equal(elements[0].tag === 'img' ? marker < rendered.text.indexOf('Fiction after')
      : marker > rendered.text.indexOf('Fiction before'), true);
  }
});

test('post selected locale and branch determine stable pointers without duplicate fallback', () => {
  const rendered = renderApiMessageContent(native({ en_us: { content_v2: [[img('img_invented_primary')]],
    content: [[img('img_invented_fallback')]] } }));
  assert.equal(rendered.media_slots.length, 1);
  assert.equal(rendered.media_slots[0].slot_id, '/en_us/content_v2/0/0');
  assert.equal(rendered.media_slots[0].key, 'img_invented_primary');
});

test('a repeated real occurrence retains each position while resource identity may deduplicate later', () => {
  const rendered = renderApiMessageContent(native({ content: [[img(), text('Fiction middle'), img()]] }));
  assert.deepEqual(rendered.media_slots.map(slot => [slot.slot_id, slot.order]),
    [['/content/0/0', 0], ['/content/0/2', 1]]);
  assert.equal(rendered.media_slots[0].key, rendered.media_slots[1].key);
});

test('an invalid declared primary cannot be disguised by a complete fallback', () => {
  for (const content_v2 of [null, 17, 'invalid', { content: 'invalid' }]) {
    const rendered = renderApiMessageContent(native({ content_v2, content: [[text('Fiction fallback')]] }));
    assert.notEqual(rendered.status, 'rendered');
  }
});

test('a valid empty primary preserves the established content fallback', () => {
  const rendered = renderApiMessageContent(native({ content_v2: [], content: [[text('Fiction fallback')]] }));
  assert.deepEqual(rendered, { text: 'Fiction fallback', status: 'rendered', reason: null, version: 1 });
});

test('image occurrence budget is 64 and overflow cannot become complete', () => {
  const rendered = renderApiMessageContent(native({ content: [Array.from({ length: 65 }, (_, i) => img(`img_invented_${i}`))] }));
  assert.equal(rendered.media_slots.length, 64);
  assert.equal(rendered.status, 'partial');
  assert.equal(rendered.reason, 'media_slot_limit');
});

test('locale JSON pointer segments are escaped', () => {
  const rendered = renderApiMessageContent(native({ 'x/y~z': { content: [[img()]] } }));
  assert.equal(rendered.media_slots[0].slot_id, '/x~1y~0z/content/0/0');
});

test('missing or invalid image references stay incomplete and retain their positions', () => {
  for (const image_key of [undefined, null, 9, '', ' \n ']) {
    const rendered = renderApiMessageContent(native({ content: [[text('Fiction left'), { tag: 'img', image_key }, text('Fiction right')]] }));
    assert.equal(rendered.status, 'partial');
    assert.equal(rendered.media_slots.length, 1);
    assert.equal(rendered.media_slots[0].key, null);
    assert.match(rendered.text, /^Fiction left\[图片.*Fiction right$/s);
  }
});

test('ordinary available-shaped data cannot establish image completeness', () => {
  const rendered = renderApiMessageContent(native({ content: [[img()]] }), {
    resolveImage: () => ({ available: true, status: 'available', verified: true }),
  });
  assert.equal(rendered.status, 'partial');
});

test('embedded normalization preserves exact raw evidence and does not mutate input', () => {
  const original = native({ title: 'Invented title', content: [[img(), text('Invented narrative')]] });
  const bytes = JSON.stringify(original);
  const normalized = normalizeApiMessage(original);
  assert.equal(JSON.stringify(original), bytes);
  assert.deepEqual(normalized.raw_api, original);
  assert.equal(normalized.content_rendering.media_slots.length, 1);
  assert.equal(normalized.content_rendering.version, 2);
});

test('unknown post elements keep the complete structural fallback independently of image references', () => {
  const original = native({ content: [[img(), { tag: 'invented_future', value: 'Invented opaque payload' }]] });
  const rendered = renderApiMessageContent(original);
  assert.equal(rendered.status, 'partial');
  assert.equal(rendered.reason, 'unsupported_post_element');
  assert.equal(rendered.text.endsWith(original.body.content), true);
  assert.equal(rendered.media_slots.length, 1);
});

test('internal legacy verification retains the exact original post image fallback and version', () => {
  const original = native({ title: 'Invented historic title', content: [[text('Fiction before'), img(), text('Fiction after')]] });
  const rendered = renderApiMessageContent(original, { legacyPostImages: true,
    resolveImage: () => { throw new Error('Legacy verification cannot consume resource evidence'); } });
  assert.deepEqual(rendered, { text: `Invented historic title\nFiction beforeFiction after\n[富文本未完整渲染，以下为完整原始内容]\n${original.body.content}`,
    status: 'partial', reason: 'unsupported_post_element', version: 1 });
  const oldBranch = native({ content_v2: null, content: [[text('Fiction legacy fallback')]] });
  assert.deepEqual(renderApiMessageContent(oldBranch, { legacyPostImages: true }),
    { text: 'Fiction legacy fallback', status: 'rendered', reason: null, version: 1 });
});

test('resolver errors propagate so image rendering cannot consume a budget stop', () => {
  const sentinel = new Error('Invented exhausted request budget');
  assert.throws(() => renderApiMessageContent(native({ content: [[img()]] }), {
    resolveImage: () => { throw sentinel; },
  }), error => error === sentinel);
});

// Unit-level stand-in for the store boundary. Actual byte/file verification and
// durable worker enrollment are tested by the resource integration owner.
function syntheticVerifiedProjection(item, account = 'invented_account_alpha') {
  const initial = renderApiMessageContent(item);
  const entries = initial.media_slots.map(slot => ({ slot,
    binding: { type: 'image', key: slot.key, source_id: 'invented_source',
      account, message: item.message_id, source_version: 'invented_version' } }));
  const imageContext = createImageContext(entries);
  const reads = entries.map(({ binding }) => attestVerifiedImageRead(binding, { status: 'available' }));
  const resolveImage = slot => {
    const index = entries.findIndex(entry => entry.slot.slot_id === slot.slot_id);
    return index < 0 ? null : createVerifiedImageResolution(slot, entries[index].binding, reads[index], imageContext);
  };
  return { imageContext, resolveImage, entries };
}

test('post consumes a matching internal verification context while retaining original image positions', () => {
  const item = native({ content: [[text('Invented first'), img(), text('Invented last')]] });
  const options = syntheticVerifiedProjection(item);
  const rendered = renderApiMessageContent(item, options);
  assert.equal(rendered.status, 'rendered');
  assert.equal(rendered.reason, null);
  assert.match(rendered.text, /^Invented first\[图片\].*本地资源已验证.*Invented last$/);
  assert.equal(rendered.text.includes('img_invented_mountain'), false);
});

test('a same-pointer same-key receipt from another account context cannot complete the post', () => {
  const item = native({ content: [[img()]] });
  const own = syntheticVerifiedProjection(item);
  const other = syntheticVerifiedProjection(item, 'invented_account_beta');
  const otherSlot = createImageSlot(other.entries[0].slot, { imageContext: other.imageContext });
  const otherReceipt = other.resolveImage(otherSlot);
  const rendered = renderApiMessageContent(item, { imageContext: own.imageContext, resolveImage: () => otherReceipt });
  assert.equal(rendered.status, 'partial');
  assert.equal(rendered.reason, 'media_resource_unavailable');
});

test('verified images do not erase an unresolved mention or unknown structural debt', () => {
  const mention = native({ content: [[img(), { tag: 'at', user_id: 'ou_invented_unknown' }]] });
  const renderedMention = renderApiMessageContent(mention, syntheticVerifiedProjection(mention));
  assert.equal(renderedMention.status, 'partial');
  assert.equal(renderedMention.reason, 'unresolved_message_mention');
  const unknown = native({ content: [[img(), { tag: 'invented_future_kind' }]] });
  const renderedUnknown = renderApiMessageContent(unknown, syntheticVerifiedProjection(unknown));
  assert.equal(renderedUnknown.status, 'partial');
  assert.equal(renderedUnknown.reason, 'unsupported_post_element');
});
