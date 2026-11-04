import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCardContent } from '../src/adapters/lark-im/card-content.mjs';
import { createImageContext, createVerifiedImageResolution, attestVerifiedImageRead } from '../src/adapters/lark-im/media-image-slot.mjs';

// Freshly invented controls and text. No captured or transformed source data.
const text = content => ({ tag: 'plain_text', content });
const card = (...elements) => ({ elements });
const form = (...elements) => ({ tag: 'form', elements });
const input = fields => ({ tag: 'input', label: text('Invented answer'), ...fields });
const option = (value, label) => ({ value, text: text(label) });
const select = fields => ({ tag: 'select_static', label: text('Invented route'),
  options: [option('north', 'Northern path'), option('south', 'Southern path')], ...fields });
const render = source => renderCardContent(source, [], { includePartialNotice: false });
const complete = source => {
  const result = render(source);
  assert.equal(result.status, 'rendered', JSON.stringify(result));
  assert.equal(result.reason, null);
  assert.equal(result.version, 4);
  return result;
};

test('existing ordinary cards retain their exact result shape and projection version', () => {
  assert.deepEqual(render(card(text('Ordinary unchanged paragraph'))), {
    text: 'Ordinary unchanged paragraph', status: 'rendered', reason: null, version: 3,
  });
});

test('collapsed panels retain source title/body/sibling order without claiming workflow progress', () => {
  const source = card(text('Before panel'), { tag: 'collapsible_panel', expanded: false,
    header: { title: text('Invented details'), subtitle: text('Static subtitle') },
    elements: [text('First detail'), text('Second detail')] }, text('After panel'));
  const before = JSON.stringify(source);
  assert.equal(complete(source).text, 'Before panel\nInvented details\nStatic subtitle\nFirst detail\nSecond detail\nAfter panel');
  assert.equal(JSON.stringify(source), before);
});

test('native property panels keep known mentions and sanitized navigation behavior', () => {
  const result = renderCardContent(card({ tag: 'collapsible_panel', property: {
    expanded: true, header: text('Panel title'), elements: [
      { tag: 'at', property: { userID: 'invented-person' } },
      { tag: 'a', text: text('Read'), href: 'https://example.invalid/record?token=HIDDEN_SYNTHETIC_TOKEN' },
    ],
  } }), [{ id: 'invented-person', name: 'Invented reader' }]);
  assert.equal(result.status, 'rendered');
  assert.match(result.text, /@Invented reader/);
  assert.match(result.text, /https:\/\/example.invalid\/record/);
  assert.doesNotMatch(result.text, /HIDDEN_SYNTHETIC_TOKEN|token=/);
});

test('empty required input is a complete static control; placeholder is visibly a hint', () => {
  const result = complete(card(form(input({ required: true, disabled: false, placeholder: text('Invented example only') }))));
  assert.match(result.text, /输入框：Invented answer \[必填\] \[可用\]/);
  assert.match(result.text, /提示：Invented example only/);
  assert.match(result.text, /源未提供输入值/);
  assert.doesNotMatch(result.text, /源输入值：Invented example only/);
});

test('explicit empty source input differs from an omitted value and is not replaced by a hint', () => {
  const result = complete(card(form(input({ value: '', placeholder: text('Not an answer') }))));
  assert.match(result.text, /源输入值：/);
  assert.doesNotMatch(result.text, /源未提供输入值/);
});

test('explicit input strings use normal terminal and URL protection', () => {
  const result = complete(card(form(input({ default_value: 'Invented answer https://example.invalid/a?key=HIDDEN_VALUE' }))));
  assert.match(result.text, /源输入值：Invented answer https:\/\/example.invalid\/a/);
  assert.doesNotMatch(result.text, /\u001b|HIDDEN_VALUE|key=/);
});

test('a control adjoining a URL retains the existing conservative link diagnosis', () => {
  const result = render(card(form(input({ value: '\u001b[31mInvented answer https://example.invalid/a?key=HIDDEN_VALUE\u001b[0m' }))));
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'unsupported_card_link');
  assert.doesNotMatch(result.text, /\u001b|HIDDEN_VALUE|key=/);
});

test('input aliases cannot disagree or manufacture a value from a non-string', () => {
  for (const fields of [{ value: 'first', default_value: 'second' }, { value: 7 }, { defaultValue: { content: 'HIDDEN' } }]) {
    const result = render(card(form(input(fields))));
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, 'unsupported_card_structure');
    assert.doesNotMatch(result.text, /源输入值：|HIDDEN/);
  }
});

test('unknown input types are not treated as visible text values', () => {
  const result = render(card(form(input({ inputType: 'invented_protected_type', value: 'HIDDEN_PROTECTED_INPUT' }))));
  assert.equal(result.status, 'partial');
  assert.doesNotMatch(result.text, /HIDDEN_PROTECTED_INPUT/);
});

for (const initial of [{}, { initialOption: 'south' }, { initial_option: 'south' }, { initialIndex: 1 },
  { initialOption: 'south', initialIndex: 1 }]) {
  test(`selection preserves an explicit supported source state ${JSON.stringify(initial)}`, () => {
    const result = complete(card(form(select({ required: true, ...initial }))));
    assert.match(result.text, /Northern path[\s\S]*Southern path/);
    if (Object.keys(initial).length) assert.match(result.text, /\[源初选\] Southern path/);
    else assert.match(result.text, /源未提供初选/);
    assert.doesNotMatch(result.text, /已选择|已提交|已完成/);
  });
}

for (const initial of [{ initialOption: 'missing' }, { initialOption: 'north', initialIndex: 1 },
  { initialOption: 'south', initial_option: 'north' }, { initialIndex: -1 }, { initialIndex: 2 },
  { initialIndex: 0.5 }, { initialIndex: '1' }, { initialOption: '' }]) {
  test(`unknown or contradictory initial selection remains partial ${JSON.stringify(initial)}`, () => {
    const result = render(card(form(select(initial))));
    assert.equal(result.status, 'partial');
    assert.equal(result.reason, 'unsupported_card_structure');
    assert.match(result.text, /初选声明无法确认/);
    assert.doesNotMatch(result.text, /\[源初选\]/);
  });
}

test('duplicate option identities cannot establish a unique initial choice', () => {
  const result = render(card(form(select({ initialOption: 'same', options: [option('same', 'First'), option('same', 'Second')] }))));
  assert.equal(result.status, 'partial');
  assert.doesNotMatch(result.text, /\[源初选\]/);
});

test('form submit definitions are inert and their source label is not a completion receipt', () => {
  let touched = 0;
  const action = { type: 'action_request' };
  Object.defineProperty(action, 'payload', { get() { touched += 1; throw new Error('must stay opaque'); } });
  const result = complete(card(form({ tag: 'button', actionType: 'form_submit', disabled: false,
    text: text('Invented submit label'), actions: [action], value: { secret: 'HIDDEN_CALLBACK' } })));
  assert.equal(touched, 0);
  assert.equal(result.omitted_actions, 1);
  assert.match(result.text, /提交操作：Invented submit label/);
  assert.match(result.text, /未在文本视图执行/);
  assert.doesNotMatch(result.text, /HIDDEN_CALLBACK|已提交|已完成/);
});

test('unknown control actions or unknown widgets cannot disappear into a ready form', () => {
  for (const element of [input({ actions: [{ type: 'future_action', payload: 'HIDDEN' }] }),
    { tag: 'future_widget', value: 'HIDDEN' }, { tag: 'button', actionType: 'future_submit', text: text('Known') },
    { tag: 'button', actionType: 'future_submit', text: text('Known'), url: 'https://example.invalid/known' }]) {
    const result = render(card(form(element), text('Following sibling')));
    assert.equal(result.status, 'partial');
    assert.match(result.text, /Following sibling/);
    assert.doesNotMatch(result.text, /HIDDEN/);
  }
});

test('markdown_v1 selects primary elements once and never appends fallback text', () => {
  const result = complete(card({ tag: 'markdown_v1', property: { elements: [text('Primary first'),
    { tag: 'list', property: { items: [{ type: 'ul', elements: [text('Primary nested')] }] } }] },
  fallback: { tag: 'markdown', content: 'HIDDEN_DUPLICATE_FALLBACK' } }));
  assert.match(result.text, /Primary first[\s\S]*Primary nested/);
  assert.doesNotMatch(result.text, /HIDDEN_DUPLICATE_FALLBACK/);
});

test('an explicit fallback is selected only when primary representation is absent', () => {
  assert.equal(complete(card({ tag: 'markdown_v1', fallback: text('Explicit supported fallback') })).text,
    'Explicit supported fallback');
  for (const property of [{}, { elements: null }, { elements: [{ tag: 'future' }] }, null]) {
    const result = render(card(text('Before'), { tag: 'markdown_v1', property,
      fallback: text('HIDDEN_CONVENIENT_FALLBACK') }, text('After')));
    assert.equal(result.status, 'partial');
    assert.doesNotMatch(result.text, /HIDDEN_CONVENIENT_FALLBACK/);
  }
});

test('new finite nodes share depth, node, output and cycle bounds', () => {
  let deep = text('HIDDEN_DEEP');
  for (let index = 0; index < 30; index++) deep = { tag: 'collapsible_panel', elements: [deep] };
  assert.equal(render(card(deep)).reason, 'card_depth_limit');
  const wide = render(card(form(select({ options: Array.from({ length: 3000 }, (_, i) => option(`v${i}`, `Choice ${i}`)) }))));
  assert.equal(wide.reason, 'card_node_limit');
  const large = render(card(form(input({ value: 'X'.repeat(20_000) }))));
  assert.equal(large.reason, 'card_output_limit');
  assert.ok(large.text.length <= 16_000);
  const cycle = { tag: 'collapsible_panel', elements: [] };
  cycle.elements.push(cycle);
  assert.equal(render(card(cycle)).reason, 'card_cycle');
});

test('new element accessors never execute or hide a missing semantic branch', () => {
  let reads = 0;
  const control = input({});
  Object.defineProperty(control, 'value', { get() { reads++; return 'HIDDEN_GETTER_VALUE'; } });
  const result = render(card(form(control)));
  assert.equal(reads, 0);
  assert.equal(result.status, 'partial');
  assert.doesNotMatch(result.text, /HIDDEN_GETTER_VALUE/);
});

const image = key => ({ tag: 'img', img_key: key });
const wrapped = (elements, images) => ({ json_attachment: { images }, json_card: { body: { elements } } });

test('image slots follow selected source occurrence order without leaking their keys', () => {
  const repeated = image('invented_shared_key');
  const source = card(text('First'), repeated, text('Middle'), repeated, text('Last'));
  const before = JSON.stringify(source);
  const result = render(source);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'media_resource_unavailable');
  assert.equal(result.version, 4);
  assert.deepEqual(result.media_slots.map(s => [s.slot_id, s.order, s.reference_state]), [
    ['/elements/1', 0, 'reference_only'], ['/elements/3', 1, 'reference_only'],
  ]);
  assert.equal(result.text, 'First\n[图片] 资源尚未验证\nMiddle\n[图片] 资源尚未验证\nLast');
  assert.doesNotMatch(result.text, /invented_shared_key|\/elements\//);
  assert.equal(JSON.stringify(source), before);
});

test('locale, panel and list slots preserve the exact chosen pointer', () => {
  const source = card({ tag: 'collapsible_panel', property: { header: text('Panel'), elements: [
    { tag: 'markdown', property: { i18nElements: { en_us: [image('invented_chosen')], ja_jp: [image('invented_unselected')] } } },
    { tag: 'list', property: { items: [{ type: 'ul', elements: [image('invented_list')] }] } },
  ] } });
  const result = render(source);
  assert.deepEqual(result.media_slots.map(s => s.slot_id), [
    '/elements/0/property/elements/0/property/i18nElements/en_us/0',
    '/elements/0/property/elements/1/property/items/0/elements/0',
  ]);
  assert.deepEqual(result.media_slots.map(s => s.key), ['invented_chosen', 'invented_list']);
});

test('native attachment image aliases retain a distinct unverified reference kind', () => {
  const result = render(wrapped([{ tag: 'img', property: { imageID: 'a' } }], { a: { origin_key: 'invented_origin' } }));
  assert.equal(result.reason, 'media_resource_unavailable');
  assert.deepEqual(result.media_slots.map(s => [s.slot_id, s.reference_kind, s.key, s.alias]), [
    ['/json_card/body/elements/0', 'attachment_origin_key', 'invented_origin', 'a'],
  ]);
  assert.doesNotMatch(result.text, /invented_origin/);
});

test('nearest attachment scope shadows outer aliases instead of borrowing missing inner entries', () => {
  const source = { json_attachment: { images: { a: { origin_key: 'invented_outer' } } },
    json_card: wrapped([{ tag: 'img', property: { imageID: 'a' } }], {}) };
  const result = render(source);
  assert.equal(result.media_slots[0].reference_state, 'missing_reference');
  assert.equal(result.media_slots[0].key, null);
  assert.equal(result.reason, 'media_reference_missing');
});

for (const [name, node, state] of [
  ['missing', { tag: 'img' }, 'missing_reference'],
  ['url', image('https://example.invalid/not-a-key'), 'invalid_reference'],
  ['direct conflict', { tag: 'img', img_key: 'invented_a', image_key: 'invented_b' }, 'conflicting_reference'],
  ['alias and direct', { tag: 'img', img_key: 'invented_a', imageID: 'alias' }, 'conflicting_reference'],
  ['invalid alias', { tag: 'img', imageID: '../bad' }, 'invalid_reference'],
]) {
  test(`image reference ${name} cannot become available from a raw status object`, () => {
    const result = renderCardContent(card(node), [], { resolveImage: () => ({ status: 'available', available: true }) });
    assert.equal(result.status, 'partial');
    assert.equal(result.media_slots[0].reference_state, state);
    assert.notEqual(result.reason, null);
  });
}

test('image alias metadata accessors stay unexecuted and are diagnosed', () => {
  let reads = 0;
  const entry = {};
  Object.defineProperty(entry, 'origin_key', { get() { reads++; return 'invented_hidden_key'; } });
  const result = render(wrapped([{ tag: 'img', imageID: 'alias' }], { alias: entry }));
  assert.equal(reads, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'unsupported_card_structure');
  assert.equal(result.media_slots[0].key, null);
});

test('markdown_v1 chooses only one image-bearing representation', () => {
  const source = card({ tag: 'markdown_v1', property: { elements: [text('Chosen '), image('invented_primary')] },
    fallback: { tag: 'markdown', elements: [text('HIDDEN_FALLBACK'), image('invented_fallback')] } });
  const result = render(source);
  assert.equal(result.media_slots.length, 1);
  assert.equal(result.media_slots[0].slot_id, '/elements/0/property/elements/1');
  assert.equal(result.media_slots[0].representation, 'markdown_v1');
  assert.equal(result.media_slots[0].key, 'invented_primary');
  assert.doesNotMatch(result.text, /HIDDEN_FALLBACK/);
  const fallback = render(card({ tag: 'markdown_v1', fallback: image('invented_only_fallback') }));
  assert.equal(fallback.media_slots[0].slot_id, '/elements/0/fallback');
});

test('image slot overflow remains incomplete even when output is short', () => {
  const result = render(card(...Array.from({ length: 65 }, (_, index) => image(`invented_${index}`))));
  assert.equal(result.media_slots.length, 64);
  assert.equal(result.status, 'partial');
  assert.equal(result.reason, 'media_slot_limit');
  assert.match(result.text, /图片数量超过解析上限/);
});

test('resolver exceptions, including budget termination, escape the malformed-source guard unchanged', () => {
  const error = Object.freeze({ kind: 'invented_budget_stop' });
  assert.throws(() => renderCardContent(card(image('invented_key')), [], { resolveImage() { throw error; } }), value => value === error);
  let thrown = false;
  try { renderCardContent(card(image('invented_key')), [], { resolveImage() { throw undefined; } }); }
  catch (value) { thrown = true; assert.equal(value, undefined); }
  assert.equal(thrown, true);
});

// Synthetic store-boundary receipts exercise only renderer credential handling.
// Real filesystem/byte verification belongs to resource integration tests.
function resolutionFor(source, account) {
  const sourceSlots = render(source).media_slots;
  const entries = sourceSlots.map(slot => ({ slot, binding: { type: 'image', key: slot.key, account, version: 'invented_version' } }));
  const imageContext = createImageContext(entries);
  const resolveImage = slot => {
    const binding = entries.find(entry => entry.slot.slot_id === slot.slot_id).binding;
    const read = attestVerifiedImageRead(binding, { status: 'available' });
    return createVerifiedImageResolution(slot, binding, read, imageContext);
  };
  return { imageContext, resolveImage };
}

test('only a same-context branded receipt clears an image occurrence debt', () => {
  const source = card(text('Keep this'), image('invented_key'));
  const result = renderCardContent(source, [], resolutionFor(source, 'invented_account_a'));
  assert.equal(result.status, 'rendered');
  assert.equal(result.reason, null);
  assert.match(result.text, /本地资源已验证（未生成文字描述）/);
  let held;
  const first = resolutionFor(source, 'invented_account_a');
  renderCardContent(source, [], { ...first, resolveImage(slot) { held = first.resolveImage(slot); return held; } });
  const other = resolutionFor(source, 'invented_account_b');
  const borrowed = renderCardContent(source, [], { ...other, resolveImage: () => held });
  assert.equal(borrowed.reason, 'media_resource_unavailable');
  const copied = renderCardContent(source, [], { ...first, resolveImage: () => JSON.parse(JSON.stringify(held)) });
  assert.equal(copied.reason, 'media_resource_unavailable');
});

test('verified images cannot erase an unrelated unknown structure or missing mention', () => {
  for (const other of [{ tag: 'invented_unknown' }, { tag: 'at', user_id: 'invented_missing' }]) {
    const source = card(image('invented_key'), other);
    const result = renderCardContent(source, [], resolutionFor(source, 'invented_account'));
    assert.equal(result.status, 'partial');
    assert.notEqual(result.reason, 'media_resource_unavailable');
  }
});
