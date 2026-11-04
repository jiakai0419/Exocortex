import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { projectPostContent, readPostProjectionEvidence } from '../src/adapters/lark-im/message-post-projection.mjs';
import { renderApiMessageContent } from '../src/adapters/lark-im/raw-message.mjs';

// Every message, identity and body in this file is independently invented.
const prose = { title: 'Synthetic paper boat', content: [[{ tag: 'text', text: 'A fictional harbor note.' }]] };
const picture = { content: [[{ tag: 'text', text: 'Invented front ' },
  { tag: 'img', image_key: 'synthetic_embedded_post_key' }, { tag: 'text', text: ' invented tail' }]] };
function fixture(payload = prose) {
  const raw = { message_id: 'om_invented_post_proof', chat_id: 'oc_invented_post_proof', msg_type: 'post',
    body: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } };
  const canonical = { message_id: raw.message_id, chat_id: raw.chat_id, msg_type: 'post',
    content_rendering: { version: 900, status: 'rendered', reason: null } };
  const row = { id: 41, source_id: 'lark.im', record_type: 'lark.im.message', external_id: raw.message_id,
    container_id: raw.chat_id, external_version: '7', body: renderApiMessageContent(raw).text };
  const refresh = () => {
    row.raw_json = JSON.stringify(raw); row.canonical_json = JSON.stringify(canonical);
    row.content_hash = createHash('sha256').update(row.raw_json).digest('hex');
  };
  refresh();
  return { row, canonical, raw, refresh };
}
const project = f => projectPostContent(f.row, f.canonical, f.raw);
const state = (f, p) => readPostProjectionEvidence(f.row, f.canonical, f.raw, p).state;

test('current complete post is proved from raw and the exact stored body', () => {
  const f = fixture();
  f.canonical.content_rendering = { version: 1, status: 'structured_fallback', reason: 'old_parser_limit' }; f.refresh();
  const before = JSON.stringify(f), result = project(f);
  assert.equal(result.status, 'rendered'); assert.equal(state(f,result),'complete');
  assert.equal(JSON.stringify(f),before,'read-time projection cannot rewrite source or metadata');
});

test('exact old image-post fallback is recognized without treating its image as available', () => {
  const f = fixture(picture);
  f.row.body = renderApiMessageContent(f.raw,{legacyPostImages:true}).text;
  const result=project(f);
  assert.equal(result.media_slots.length,1); assert.equal(result.status,'partial');
  assert.equal(result.reason,'media_resource_unavailable'); assert.equal(state(f,result),'partial');
  assert.notEqual(result.text,f.row.body,'only the display projection is rebuilt');
});

test('a fabricated rendered flag cannot promote malformed post JSON', () => {
  const f=fixture('{invalid synthetic payload'); f.row.body='An invented plausible fallback.';
  const result=project(f);
  assert.equal(state(f,result),'invalid'); assert.equal(result.reason,'post_source_invalid');
});

test('unrelated readable stored prose is not accepted as a renderer upgrade', () => {
  for(const payload of [prose,picture]) {
    const f=fixture(payload); f.row.body='A different synthetic document.';
    const result=project(f);
    assert.equal(state(f,result),'invalid'); assert.equal(result.reason,'stored_post_projection_mismatch');
  }
});

test('legacy canonical-only type remains narrow and cannot repair an API wrapper missing its type', () => {
  const f=fixture(); delete f.raw.msg_type; f.refresh();
  assert.equal(state(f,project(f)),'complete');
  f.raw.source_api='im.v1.messages'; f.refresh();
  assert.equal(state(f,project(f)),'invalid');
});

test('wrong message identity and duplicate source JSON cannot borrow an otherwise complete post', () => {
  const f=fixture(); f.canonical.message_id='om_another_invented_message'; f.refresh();
  assert.equal(state(f,project(f)),'invalid');
  const g=fixture(); g.row.raw_json=g.row.raw_json.replace('"msg_type":"post"','"msg_type":"post","msg_type":"post"');
  assert.equal(state(g,project(g)),'invalid');
});

test('serialized proofs and a later source/body change cannot reuse a read-time result', () => {
  const f=fixture(), result=project(f);
  assert.equal(state(f,JSON.parse(JSON.stringify(result))),'invalid');
  f.row.body='Changed synthetic body'; assert.equal(state(f,result),'invalid');
  const g=fixture(), next=project(g);
  g.raw.body.content=JSON.stringify({content:[[{tag:'text',text:'Other invented content'}]]});
  assert.equal(state(g,next),'invalid');
});

test('validated display output cannot be rewritten while retaining a complete proof', () => {
  const f=fixture(), result=project(f);
  assert(Object.isFrozen(result));
  assert.throws(()=>{result.text='Injected invented text outside the raw source';},TypeError);
  assert.equal(state(f,result),'complete');
  const image=project(fixture(picture));
  assert(Object.isFrozen(image.media_slots));
  assert.throws(()=>image.media_slots.push({state:'available'}),TypeError);
});

test('a different in-memory raw or canonical object cannot borrow the stored source encoding', () => {
  const f=fixture();
  f.raw.body.content=JSON.stringify({content:[[{tag:'text',text:'A second fictional source.'}]]});
  f.row.body=renderApiMessageContent(f.raw).text;
  assert.equal(state(f,project(f)),'invalid');
  const g=fixture();g.canonical.content='A synthetic canonical field absent from its stored JSON';
  assert.equal(state(g,project(g)),'invalid');
});

test('a bare available object cannot supply image authority', () => {
  const f=fixture(picture);
  const result=projectPostContent(f.row,f.canonical,f.raw,{resolveImage:()=>({status:'available',verified:true})});
  assert.equal(state(f,result),'partial'); assert.equal(result.status,'partial');
});

test('an unbound resolver is not called and cannot supply this row image evidence', () => {
  const f=fixture(picture);let calls=0;
  const result=projectPostContent(f.row,f.canonical,f.raw,{resolveImage(){calls++;throw new Error('Untrusted callback');}});
  assert.equal(calls,0);assert.equal(state(f,result),'partial');
});
