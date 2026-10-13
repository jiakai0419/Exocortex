import assert from 'node:assert/strict';
import test from 'node:test';
import { createLarkImAdapter } from '../src/adapters/lark-im/adapter.mjs';

// Invented identities and injected transport only; these anomalous responses
// are defensive counterexamples, not claims about actual upstream behavior.
const START = Date.parse('2026-10-01T00:00:00Z'), END = START + 60_000;
const SELF = 'ou_synthetic_scope_self', FOREIGN = 'ou_synthetic_scope_foreign';
const CHAT = 'oc_synthetic_scope_a', OTHER_CHAT = 'oc_synthetic_scope_b';
const PATH = '/open-apis/im/v1/messages';
const OPTS = { pageSize: 50, maxPages: 5, chatPageSize: 100, chatTypes: 'group', retries: 0, retryDelayMs: 0 };
const raw = (id, overrides = {}) => ({ message_id: `om_synthetic_scope_${id}`, chat_id: CHAT,
  create_time: String(START + 1000), update_time: String(START + 2000), msg_type: 'text',
  sender: { id: SELF, id_type: 'open_id', sender_type: 'user' },
  body: { content: '{"text":"invented private payload"}' }, ...overrides });
const root = (id, overrides = {}) => raw(id, { msg_type: 'merge_forward', ...overrides });
const page = (items, has_more = false, page_token = '') => ({ ok: true, data: { items, has_more, page_token } });
const badSenders = [
  ['foreign open ID', { id: FOREIGN, id_type: 'open_id' }],
  ['missing sender', undefined], ['empty sender', {}],
  ['untyped generic ID', { id: SELF }], ['untyped string ID', { sender_id: SELF }],
  ['unknown namespace', { id: SELF, id_type: 'unknown' }],
  ['user namespace', { id: SELF, id_type: 'user_id' }],
  ['union namespace', { id: SELF, id_type: 'union_id' }],
  ['app namespace', { id: SELF, id_type: 'app_id' }],
  ['conflicting open IDs', { id: SELF, id_type: 'open_id', open_id: FOREIGN }],
  ['conflicting nested ID', { id: SELF, id_type: 'open_id', sender_id: { open_id: FOREIGN } }],
  ['ambiguous namespace', { id: SELF, open_id: SELF, user_id: SELF }],
  ['malformed namespace', { id: SELF, id_type: {} }],
  ['contradictory actor kind', { id: SELF, id_type: 'open_id', sender_type: 'app' }],
  ['contradictory legacy kind', { open_id: SELF, type: 'app' }],
  ['unknown actor kind', { id: SELF, id_type: 'open_id', sender_type: 'unknown' }],
  ['unknown legacy kind', { open_id: SELF, type: 'unknown' }],
  ['conflicting actor kinds', { open_id: SELF, sender_type: 'user', type: 'app' }],
  ['masked unknown kind', { open_id: SELF, sender_type: 'user', type: 'unknown' }],
  ['reverse conflicting kinds', { open_id: SELF, sender_type: 'app', type: 'user' }],
  ['malformed kind', { open_id: SELF, sender_type: null }],
];

function harness(pages, refresh = item => item) {
  const calls = [];
  const adapter = createLarkImAdapter({ run(args) {
    const path = args[2], params = JSON.parse(args[args.indexOf('--params') + 1]);
    calls.push(path);
    if (path === `${PATH}/search`) {
      assert.deepEqual(JSON.parse(args[args.indexOf('--data') + 1]).filter.from_ids, [SELF]);
    } else if (path === PATH) assert.equal(params.container_id, CHAT);
    if (path === `${PATH}/mget`) {
      return page(params.message_ids.map(id => pages.flat().find(item => item.message_id === id)));
    }
    if (path !== PATH && path !== `${PATH}/search`) {
      const item = pages.flat().find(item => `${PATH}/${item.message_id}` === path);
      assert.ok(item, 'unexpected injected detail request');
      // Forwarded children can legitimately have another chat and sender.
      return page([refresh(item), raw('child', { chat_id: OTHER_CHAT,
        sender: { id: FOREIGN, id_type: 'open_id' }, upper_message_id: item.message_id })]);
    }
    const index = params.page_token ? Number(params.page_token) : 0;
    const items = path === PATH ? pages[index]
      : pages[index].map(item => ({ meta_data: { message_id: item.message_id } }));
    return page(items, index + 1 < pages.length, index + 1 < pages.length ? String(index + 1) : '');
  } });
  return { adapter, calls };
}
const fetch = (adapter, mode, list) => mode === 'sent'
  ? adapter[list ? 'fetchSentMessageList' : 'fetchSentMessages'](SELF, START, END, OPTS)
  : adapter[list ? 'fetchChatMessageList' : 'fetchChatMessages'](CHAT, START, END, OPTS);
function rejectsScope(work) {
  let returned;
  assert.throws(() => { returned = work(); }, error => {
    assert.equal(error.name, 'MessageScopeError');
    assert.match(error.message, /requested scope/);
    assert.doesNotMatch(error.message, /synthetic|invented|ou_|oc_|om_/);
    assert.equal(error.messages, undefined, 'scope failures must not carry partial records');
    return true;
  });
  assert.equal(returned, undefined);
}

for (const list of [false, true]) {
  for (const merged of [false, true]) {
    const label = `${list ? 'list' : 'strict'} ${merged ? 'merge root' : 'ordinary'}`;
    test(`${label}: chat mismatch or missing identity rejects the whole page before time clipping`, () => {
      for (const chat_id of [OTHER_CHAT, undefined, '', 42]) {
        for (const create_time of [String(START + 1000), String(START - 1)]) {
          const bad = (merged ? root : raw)('wrong_chat', { chat_id, create_time });
          const h = harness([[raw('valid'), bad]]);
          rejectsScope(() => fetch(h.adapter, 'received', list));
          assert.deepEqual(h.calls, [PATH], 'no mismatched root detail acquisition');
        }
      }
    });
    test(`${label}: sent requires unambiguous typed self for every item`, () => {
      for (const [, sender] of badSenders) {
        const bad = (merged ? root : raw)('wrong_actor', { sender });
        const h = harness([[raw('valid'), bad]]);
        rejectsScope(() => fetch(h.adapter, 'sent', list));
        assert.deepEqual(h.calls, [`${PATH}/search`, `${PATH}/mget`]);
      }
      const h = harness([[(merged ? root : raw)('outside', {
        create_time: String(START - 1), sender: { id: FOREIGN, id_type: 'open_id' },
        raw_api: { sender: { id: SELF, id_type: 'open_id' } },
      })]]);
      rejectsScope(() => fetch(h.adapter, 'sent', list));
    });
  }
  for (const mode of ['received', 'sent']) {
    test(`${mode} ${list ? 'list' : 'strict'} rejects later mismatches without exposing earlier roots or records`, () => {
      const bad = mode === 'sent' ? { sender: { id: FOREIGN, id_type: 'open_id' } } : { chat_id: OTHER_CHAT };
      const h = harness([[raw('first'), root('first_root')], [raw('second', bad)]]);
      rejectsScope(() => fetch(h.adapter, mode, list));
    });
  }
}

test('sent compatibility shapes preserve native identity evidence in successful lists and expanded roots', () => {
  for (const sender of [{ id: SELF, id_type: 'open_id' }, { open_id: SELF }, { sender_id: { open_id: SELF } },
    { id: SELF, id_type: 'open_id', user_id: 'synthetic_user_alias', sender_id: { union_id: 'synthetic_union_alias' } }]) {
    for (const list of [false, true]) {
      const items = [raw('valid', { sender }), root('valid_root', { sender })], before = structuredClone(items);
      const h = harness([items]), result = fetch(h.adapter, 'sent', list);
      assert.deepEqual(result.messages[0].raw_api, items[0]);
      if (list) assert.deepEqual(result.detailRoots, [items[1]]);
      else {
        assert.deepEqual(result.messages[1].raw_api, items[1]);
        assert.equal(result.messages[1].raw_api_expansions.merge_forward.items[1].sender.id, FOREIGN);
      }
      assert.deepEqual(items, before);
    }
  }
});

for (const mode of ['received', 'sent']) {
  test(`${mode}: refreshed strict merge root scope failures do not become partial detail errors`, () => {
    const h = harness([[raw('valid'), root('valid_root')]], item => ({ ...item,
      update_time: String(START + 3000), ...(mode === 'sent'
        ? { sender: { id: FOREIGN, id_type: 'open_id' } } : { chat_id: OTHER_CHAT }) }));
    rejectsScope(() => fetch(h.adapter, mode, false));
  });
}

test('deferred detail scope validation rejects unknown typed senders even on newer or conflict-capture roots', () => {
  for (const [, sender] of badSenders) {
    const queued = root('queued');
    for (const captureSameVersionConflict of [false, true]) {
      const adapter = createLarkImAdapter({ run: () => page([
        { ...queued, sender, update_time: String(START + 3000) }, raw('child')]) });
      assert.throws(() => adapter.fetchMessageDetails(queued, {
        expectedScope: { kind: 'sent', identity: SELF }, captureSameVersionConflict,
      }), error => error.name === 'MessageDetailError' && error.detailReason === 'source_scope_mismatch');
    }
  }
});
