import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { deflateSync } from 'node:zlib';
import { MAX_MEDIA_RESOURCE_BYTES, assessMediaImageBytes, inspectMediaImageBytes, makeMediaResourceBinding,
  publishMediaResource, readMediaResource, resourceStorePath } from '../src/adapters/lark-im/media-resource-store.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const account = hash('synthetic-account-only');
const nowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
function crc(bytes) {
  let c=0xffffffff;
  for (const byte of bytes) { c^=byte; for(let bit=0;bit<8;bit++)c=(c>>>1)^(c&1?0xedb88320:0); }
  return (c^0xffffffff)>>>0;
}
function chunk(type, body) {
  const name=Buffer.from(type), size=Buffer.alloc(4), checksum=Buffer.alloc(4);
  size.writeUInt32BE(body.length);checksum.writeUInt32BE(crc(Buffer.concat([name,body])));
  return Buffer.concat([size,name,body,checksum]);
}
function png({color=23,width=1,height=1,decoded,tail=Buffer.alloc(0)}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const pixels=decoded??Buffer.from([0,color,color,color,255]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('IDAT',Buffer.concat([deflateSync(pixels),tail])),chunk('IEND',Buffer.alloc(0))]);
}
function indexedPng({width=1,height=1,depth=8,palette=1,decoded=Buffer.from([0,0]),interlace=0}={}) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=depth;header[9]=3;header[12]=interlace;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('PLTE',Buffer.alloc(palette*3)),
    chunk('IDAT',deflateSync(decoded)),chunk('IEND',Buffer.alloc(0))]);
}
function gif() {
  // Authored 1x1 indexed image: clear, palette entry 0, end; three 3-bit LZW codes.
  return Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
}
function jpeg(width=1,height=1) {
  const segment=(marker,body)=>{const header=Buffer.from([255,marker,0,0]);header.writeUInt16BE(body.length+2,2);return Buffer.concat([header,body]);};
  const dc=Buffer.alloc(18);dc[1]=1; // One length-1 DC symbol, category 0.
  const ac=Buffer.alloc(18);ac[0]=16;ac[1]=1; // One length-1 AC symbol, EOB.
  const frame=Buffer.from([8,0,1,0,1,1,1,0x11,0]);frame.writeUInt16BE(height,1);frame.writeUInt16BE(width,3);
  return Buffer.concat([Buffer.from([255,216]),segment(0xdb,Buffer.from([0,...Array(64).fill(1)])),
    segment(0xc0,frame),segment(0xc4,Buffer.concat([dc,ac])),
    segment(0xda,Buffer.from([1,1,0,0,63,0])),Buffer.from([0x3f,255,217])]);
}
function webp() {
  // Authored 1x1 lossless image: no transforms/cache, singleton Huffman trees for RGBA 0,0,0,255.
  const bits=[0,0,0];
  for(const symbol of [0,0,0,255,0]) {
    bits.push(1,0,symbol>1?1:0);
    for(let i=0;i<(symbol>1?8:1);i++)bits.push((symbol>>i)&1);
  }
  const coding=Buffer.alloc(Math.ceil(bits.length/8));bits.forEach((bit,i)=>coding[i>>3]|=bit<<(i&7));
  const body=Buffer.concat([Buffer.from([0x2f,0,0,0,0]),coding]), riff=Buffer.alloc(12), header=Buffer.alloc(8);
  riff.write('RIFF');riff.writeUInt32LE(4+8+body.length+(body.length&1),4);riff.write('WEBP',8);
  header.write('VP8L');header.writeUInt32LE(body.length,4);
  return Buffer.concat([riff,header,body,Buffer.alloc(body.length&1)]);
}
function row({native={},fields={}}={}) {
  const raw_json=JSON.stringify({message_id:'om_synthetic_media',chat_id:'oc_synthetic_media',msg_type:'image',
    body:{content:JSON.stringify({image_key:'img_synthetic_media'})},...native});
  return {source_id:'lark.im',record_type:'lark.im.message',external_id:'om_synthetic_media',
    external_version:'synthetic-version-1',content_hash:hash(raw_json),container_id:'oc_synthetic_media',raw_json,...fields};
}
const media={type:'image',resource:{kind:'image_key',key:'img_synthetic_media',state:'reference_only'}};
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'synthetic-media-resource-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const db=join(root,'synthetic.db');writeFileSync(db,'synthetic database placeholder',{mode:0o600});
  const record=row(), binding=makeMediaResourceBinding(db,record,account,media), cache=resourceStorePath(db);
  assert.ok(binding);
  return {root,db,record,binding,cache};
}
function published(t,bytes=png()) {
  const env=setup(t), result=publishMediaResource(env.cache,env.binding,bytes,{nowMs});
  assert.equal(result.status,'available');
  return {...env,result,manifestPath:join(env.cache,`${result.binding_digest}.json`)};
}
const notAvailable = value => assert.notEqual(value.status,'available');

test('default/override paths and exact synthetic source binding',t=>{
  const {db,root,record,binding}=setup(t);
  assert.equal(resourceStorePath(db),`${resolve(db)}.resources`);
  assert.equal(resourceStorePath(db,join(root,'other')),join(root,'other'));
  assert.equal(binding.content_hash,hash(record.raw_json));assert.equal(binding.type,'image');
  assert.equal(binding.database.path,realpathSync(db));assert.ok(Object.isFrozen(binding));
  assert.ok(Object.isFrozen(binding.database));assert.equal(binding.external_version,'synthetic-version-1');
  assert.ok(makeMediaResourceBinding(db,{...record,external_version:null},account,media));
});

test('incomplete, conflicted, stale, wrong-type and duplicate JSON sources fail binding',t=>{
  const {db,record}=setup(t);
  for(const fields of [{source_id:'other'},{record_type:'other'},{external_id:''},{container_id:''},
    {external_version:undefined},{content_hash:'0'.repeat(64)},{raw_json:'{}'},
    {raw_json:'{"message_id":"a","message_id":"b"}'}])
    assert.equal(makeMediaResourceBinding(db,{...record,...fields},account,media),null);
  for(const native of [{chat_id:'oc_other'},{message_id:'om_other'},{msg_type:'sticker'},
    {message_type:'text'},{deleted:true},{chat:{id:'oc_other'}},{body:{content:'{"image_key":"other"}'}},
    {body:{content:'{"image_key":"img_synthetic_media","image_key":"img_synthetic_media"}'}}])
    assert.equal(makeMediaResourceBinding(db,row({native}),account,media),null);
  for(const altered of [{...media,type:'sticker'}, {...media,resource:{...media.resource,key:'../escape'}},
    {...media,resource:{...media.resource,state:'missing_reference'}}])
    assert.equal(makeMediaResourceBinding(db,record,account,altered),null);
  assert.equal(makeMediaResourceBinding(db,record,'not-an-account-hash',media),null);
  assert.equal(makeMediaResourceBinding(join(db,'missing'),record,account,media),null);
});

test('nested raw_api source must agree with native and outer identity',t=>{
  const {db}=setup(t), base=row(), raw=JSON.parse(base.raw_json);
  const wrapped=JSON.stringify({...raw,raw_api:raw});
  assert.ok(makeMediaResourceBinding(db,{...base,raw_json:wrapped,content_hash:hash(wrapped)},account,media));
  for(const invalid of [{...raw,raw_api:{...raw,chat_id:'oc_other'}},{...raw,raw_api:null}]) {
    const raw_json=JSON.stringify(invalid);
    assert.equal(makeMediaResourceBinding(db,{...base,raw_json,content_hash:hash(raw_json)},account,media),null);
  }
});

test('generated PNG/GIF decode while JPEG and WebP remain unsupported on every platform',()=>{
  for(const [bytes,mime] of [[png(),'image/png'],[gif(),'image/gif'],[jpeg(),'image/jpeg'],[webp(),'image/webp']]) {
    assert.deepEqual(inspectMediaImageBytes(bytes),['image/webp','image/jpeg'].includes(mime)
      ?null:{mime_type:mime,width:1,height:1});
    for(const length of [0,8,bytes.length-1])assert.equal(inspectMediaImageBytes(bytes.subarray(0,length)),null);
    assert.equal(inspectMediaImageBytes(Buffer.concat([bytes,Buffer.from([0])])),null);
  }
  assert.equal(inspectMediaImageBytes(Buffer.from('<html>not an image</html>')),null);
  assert.equal(inspectMediaImageBytes(Buffer.from('{"image":"not bytes"}')),null);
  assert.equal(inspectMediaImageBytes(new Uint8Array(png())),null);
  assert.equal(inspectMediaImageBytes(Buffer.alloc(MAX_MEDIA_RESOURCE_BYTES+1)),null);
});

test('incomplete JPEG entropy and WebP containers cannot become available',async t=>{
  const containers=[
    Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9','hex'),
    Buffer.from('5249464612000000574542505650384c060000002f0000000000','hex')];
  for(let i=0;i<containers.length;i++)await t.test(`container ${i}`,t=>{
    const e=setup(t), bytes=containers[i];
    assert.equal(inspectMediaImageBytes(bytes),null);
    const reason='resource_format_unsupported';
    assert.deepEqual(assessMediaImageBytes(bytes),{reason});
    assert.deepEqual(publishMediaResource(e.cache,e.binding,bytes,{nowMs}),{status:'invalid',reason});
    assert.equal(existsSync(e.cache),false);
    const result=publishMediaResource(e.cache,e.binding,png(),{nowMs});assert.equal(result.status,'available');
    const manifestPath=join(e.cache,`${result.binding_digest}.json`), manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    const sha256=hash(bytes);writeFileSync(join(e.cache,`${sha256}.blob`),bytes,{mode:0o600});
    writeFileSync(manifestPath,JSON.stringify({...manifest,sha256,size_bytes:bytes.length,mime_type:i===0?'image/jpeg':'image/webp'}));
    assert.deepEqual(readMediaResource(e.cache,e.binding),{status:'invalid',reason});
  });
});

test('JPEG single-block controls and missing-MCU variants cannot publish or reuse old available evidence',async t=>{
  // One DC0/EOB block is sufficient for 1x1 or 8x8, but not for larger frames.
  // A tolerant OS decoder fills missing blocks; none proves a strict JPEG path.
  for(const [width,height] of [[1,1],[8,8],[16,16],[32,32],[16,8]])await t.test(`${width}x${height}`,t=>{
    const bytes=jpeg(width,height),e=setup(t);
    assert.deepEqual(assessMediaImageBytes(bytes),{reason:'resource_format_unsupported'});
    assert.deepEqual(publishMediaResource(e.cache,e.binding,bytes,{nowMs}),{status:'invalid',reason:'resource_format_unsupported'});
    assert.equal(existsSync(e.cache),false);
    const good=publishMediaResource(e.cache,e.binding,png(),{nowMs});assert.equal(good.status,'available');
    const path=join(e.cache,`${good.binding_digest}.json`), manifest=JSON.parse(readFileSync(path,'utf8')),sha256=hash(bytes);
    writeFileSync(join(e.cache,`${sha256}.blob`),bytes,{mode:0o600});
    writeFileSync(path,JSON.stringify({...manifest,sha256,size_bytes:bytes.length,mime_type:'image/jpeg'}));
    assert.deepEqual(readMediaResource(e.cache,e.binding),{status:'invalid',reason:'resource_format_unsupported'});
  });
});

test('unsupported JPEG/WebP assessments cannot write temporary files or spawn tolerant decoders',()=>{
  const fields=[[fs,'mkdtempSync'],[fs,'mkdirSync'],[fs,'writeFileSync'],[childProcess,'spawnSync'],[childProcess,'spawn'],[childProcess,'execFileSync']];
  const saved=fields.map(([api,key])=>[api,key,api[key]]);let attempts=0;
  try {
    for(const [api,key] of fields)api[key]=()=>{attempts++;throw new Error('unexpected decoder side effect');};
    syncBuiltinESMExports();
    for(const bytes of [jpeg(),jpeg(16,16),webp()])
      assert.deepEqual(assessMediaImageBytes(bytes),{reason:'resource_format_unsupported'});
    assert.equal(attempts,0);
  } finally {
    for(const [api,key,value] of saved)api[key]=value;
    syncBuiltinESMExports();
  }
});

test('indexed PNG validates unpacked palette samples after every filter and Adam7 pass',()=>{
  for(const depth of [1,2,4,8]) {
    assert.ok(inspectMediaImageBytes(indexedPng({depth})));
    assert.equal(inspectMediaImageBytes(indexedPng({depth,decoded:Buffer.from([0,1<<(8-depth)])})),null);
  }
  assert.ok(inspectMediaImageBytes(indexedPng({interlace:1})));
  assert.equal(inspectMediaImageBytes(indexedPng({interlace:1,decoded:Buffer.from([0,255])})),null);
  for(const [filter,valid,invalid] of [[0,[1,1],[1,2]],[1,[1,0],[1,1]],[2,[1,0],[1,1]],[3,[1,0],[1,1]],[4,[1,0],[1,1]]]) {
    const options={width:2,height:2,palette:2};
    assert.ok(inspectMediaImageBytes(indexedPng({...options,decoded:Buffer.from([0,0,1,filter,...valid])})),`valid filter ${filter}`);
    assert.equal(inspectMediaImageBytes(indexedPng({...options,decoded:Buffer.from([0,0,1,filter,...invalid])})),null,`invalid filter ${filter}`);
  }
});

test('PNG rejects wrong CRC, pixel count/filter, trailing deflate data and decoded budgets',()=>{
  const bad=png();bad[bad.length-1]^=1;assert.equal(inspectMediaImageBytes(bad),null);
  for(const bytes of [png({decoded:Buffer.from([0,1])}),png({decoded:Buffer.from([5,1,1,1,255])}),
    png({tail:Buffer.from('junk')}),png({width:4096,height:4096}),png({width:65536}),png({width:7000,height:7000})])
    assert.equal(inspectMediaImageBytes(bytes),null);
});

test('high-bit bytes cannot alias PNG chunk names or GIF signatures into available resources',async t=>{
  const invalid=[];
  const original=png();
  for(let offset=8;offset<original.length;offset+=original.readUInt32BE(offset)+12) {
    const length=original.readUInt32BE(offset);
    for(let byte=0;byte<4;byte++) {
      const image=Buffer.from(original);image[offset+4+byte]|=0x80;
      image.writeUInt32BE(crc(image.subarray(offset+4,offset+8+length)),offset+8+length);
      invalid.push(image);
    }
  }
  for(let byte=0;byte<6;byte++){const image=gif();image[byte]|=0x80;invalid.push(image);}
  for(const [index,bytes] of invalid.entries())await t.test(`high-bit alias ${index}`,t=>{
    const e=setup(t);assert.equal(inspectMediaImageBytes(bytes),null);
    assert.equal(publishMediaResource(e.cache,e.binding,bytes,{nowMs}).status,'invalid');
    const result=publishMediaResource(e.cache,e.binding,png(),{nowMs});assert.equal(result.status,'available');
    const path=join(e.cache,`${result.binding_digest}.json`), manifest=JSON.parse(readFileSync(path,'utf8')),sha256=hash(bytes);
    writeFileSync(join(e.cache,`${sha256}.blob`),bytes,{mode:0o600});
    writeFileSync(path,JSON.stringify({...manifest,sha256,size_bytes:bytes.length,mime_type:index<12?'image/png':'image/gif'}));
    assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');
  });
});

test('GIF validates LZW clear/stop, output count, palette and blocks',()=>{
  const noClear=gif();noClear[30]=0x40;assert.equal(inspectMediaImageBytes(noClear),null);
  const noStop=gif();noStop[31]=0;assert.equal(inspectMediaImageBytes(noStop),null);
  const wrongCount=gif();wrongCount.writeUInt16LE(2,6);wrongCount.writeUInt16LE(2,24);
  assert.equal(inspectMediaImageBytes(wrongCount),null);
  const noPalette=gif();noPalette[10]=0;assert.equal(inspectMediaImageBytes(noPalette),null);
  const missingColor=gif();missingColor[30]=0x54;assert.equal(inspectMediaImageBytes(missingColor),null);
});

test('JPEG rejects zero/missing scan components and WebP rejects reserved header/padding',()=>{
  const valid=jpeg(), start=valid.indexOf(Buffer.from([255,218]));
  const zero=Buffer.concat([valid.subarray(0,start),Buffer.from([255,218,0,6,0,0,63,0,0x3f,255,217])]);
  assert.equal(inspectMediaImageBytes(zero),null);
  const missing=Buffer.from(valid);missing[start+5]=2;assert.equal(inspectMediaImageBytes(missing),null);
  const pad=webp();pad[pad.length-1]=1;assert.equal(inspectMediaImageBytes(pad),null);
  const extended=Buffer.alloc(18);extended.write('VP8X');extended.writeUInt32LE(10,4);extended[8]=0x80;
  const original=webp(), reserved=Buffer.concat([original.subarray(0,12),extended,original.subarray(12)]);
  reserved.writeUInt32LE(reserved.length-8,4);assert.equal(inspectMediaImageBytes(reserved),null);
});

test('publication returns verified private local bytes and reading changes no records or files',t=>{
  const {cache,db,record,binding,result,manifestPath}=published(t), beforeRecord=JSON.stringify(record);
  const database=readFileSync(db), beforeDb=lstatSync(db,{bigint:true}), beforeBlob=lstatSync(result.path,{bigint:true});
  const beforeManifest=lstatSync(manifestPath,{bigint:true});
  assert.deepEqual(readMediaResource(cache,binding),result);
  assert.equal(result.sha256,hash(png()));assert.equal(result.size_bytes,png().length);
  assert.equal(result.observed_at,'2026-01-02T03:04:05.000Z');assert.equal(result.mime_type,'image/png');
  assert.equal(Number(lstatSync(cache).mode&0o777),0o700);
  for(const path of [result.path,manifestPath])assert.equal(Number(lstatSync(path).mode&0o777),0o600);
  assert.equal(lstatSync(result.path).nlink,1);assert.deepEqual(readFileSync(result.path),png());
  assert.equal(JSON.stringify(record),beforeRecord);assert.deepEqual(readFileSync(db),database);
  assert.equal(lstatSync(db,{bigint:true}).mtimeNs,beforeDb.mtimeNs);
  assert.equal(lstatSync(result.path,{bigint:true}).mtimeNs,beforeBlob.mtimeNs);
  assert.equal(lstatSync(manifestPath,{bigint:true}).mtimeNs,beforeManifest.mtimeNs);
});

test('missing reads are bounded, finite and never create a cache',t=>{
  const {cache,binding}=setup(t);
  assert.deepEqual(readMediaResource(cache,binding),{status:'missing',reason:'resource_not_cached'});
  assert.equal(existsSync(cache),false);
  assert.deepEqual(readMediaResource(cache,null),{status:'invalid',reason:'resource_verification_failed'});
  assert.deepEqual(publishMediaResource(cache,binding,Buffer.from('wrong image')),{status:'invalid',reason:'resource_image_invalid'});
  assert.deepEqual(publishMediaResource(cache,binding,png(),null),{status:'invalid',reason:'resource_publish_failed'});
  assert.equal(existsSync(cache),false);
});

test('account/source/message/key/version/cross-database binding never reuses evidence',t=>{
  const {cache,db,root,record,binding,result,manifestPath}=published(t);
  for(const change of [{account_key:hash('other-account')},{external_id:'om_other'},{container_id:'oc_other'},
    {external_version:null},{content_hash:hash('other-content')},{key:'img_other'}]) {
    const altered={...binding,...change};assert.equal(readMediaResource(cache,altered).status,'missing');
    const destination=join(cache,`${hash(JSON.stringify(altered))}.json`);writeFileSync(destination,readFileSync(manifestPath),{mode:0o600});
    assert.equal(readMediaResource(cache,altered).status,'invalid');
  }
  assert.equal(readMediaResource(cache,{...binding,source_id:'other'}).status,'invalid');
  const other=join(root,'other.db');writeFileSync(other,readFileSync(db));
  const cross=makeMediaResourceBinding(other,record,account,media);assert.ok(cross);
  assert.equal(readMediaResource(cache,cross).status,'missing');
  assert.equal(readMediaResource(cache,binding).sha256,result.sha256);
});

test('database growth preserves evidence, replacement invalidates its inode binding',t=>{
  const {cache,db,binding,result}=published(t);
  appendFileSync(db,'more synthetic database content');assert.deepEqual(readMediaResource(cache,binding),result);
  renameSync(db,`${db}.old`);writeFileSync(db,'replacement');
  assert.equal(readMediaResource(cache,binding).status,'invalid');
});

test('tampered or missing blob cannot be available',async t=>{
  await t.test('tampered',t=>{const e=published(t);const bytes=readFileSync(e.result.path);bytes[bytes.length-1]^=1;writeFileSync(e.result.path,bytes);assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');});
  await t.test('missing',t=>{const e=published(t);unlinkSync(e.result.path);assert.equal(readMediaResource(e.cache,e.binding).status,'missing');});
  await t.test('oversize',t=>{const e=published(t);truncateSync(e.result.path,MAX_MEDIA_RESOURCE_BYTES+1);assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');});
});

test('manifest cannot supply outside paths, alter binding, MIME, size, time or JSON meaning',async t=>{
  const mutations=[
    m=>({...m,path:'/outside/private-file'}),m=>({...m,binding:{...m.binding,key:'img_other'}}),
    m=>({...m,sha256:'../outside'}),m=>({...m,mime_type:'image/jpeg'}),m=>({...m,size_bytes:m.size_bytes+1}),
    m=>({...m,observed_at:'2026-01-02'}),m=>({...m,observed_at:'1960-01-01T00:00:00.000Z'}),
    m=>({...m,binding_digest:'0'.repeat(64)})];
  for(let i=0;i<mutations.length;i++)await t.test(`mutation ${i}`,t=>{
    const e=published(t), manifest=JSON.parse(readFileSync(e.manifestPath,'utf8'));
    writeFileSync(e.manifestPath,JSON.stringify(mutations[i](manifest)));
    assert.deepEqual(readMediaResource(e.cache,e.binding),{status:'invalid',reason:'resource_verification_failed'});
  });
  await t.test('duplicate keys',t=>{const e=published(t), json=readFileSync(e.manifestPath,'utf8');writeFileSync(e.manifestPath,json.replace('{','{"schema":"lark_media_resource/v1",'));assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');});
  await t.test('size bound',t=>{const e=published(t);writeFileSync(e.manifestPath,' '.repeat(16385));assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');});
});

test('public directory/files, symlinks, hardlinks and FIFO are rejected without following them',async t=>{
  for(const target of ['cache','manifest','blob'])await t.test(`private ${target}`,t=>{
    const e=published(t), path=target==='cache'?e.cache:target==='manifest'?e.manifestPath:e.result.path;
    chmodSync(path,target==='cache'?0o750:0o640);assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');
  });
  for(const target of ['cache','manifest','blob'])await t.test(`symlink ${target}`,t=>{
    const e=published(t), path=target==='cache'?e.cache:target==='manifest'?e.manifestPath:e.result.path;
    renameSync(path,`${path}.real`);symlinkSync(`${path}.real`,path);
    assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');
  });
  for(const target of ['manifest','blob'])await t.test(`hardlink ${target}`,t=>{
    const e=published(t), path=target==='manifest'?e.manifestPath:e.result.path;
    linkSync(path,`${path}.alias`);assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');
  });
  await t.test('FIFO',t=>{
    if(process.platform==='win32'){t.skip('POSIX only');return;}
    const e=published(t);unlinkSync(e.manifestPath);
    const made=spawnSync('mkfifo',['-m','600',e.manifestPath],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
    assert.equal(readMediaResource(e.cache,e.binding).status,'invalid');
  });
});

test('file replacement or mutation during read is detected despite unchanged byte hash',async t=>{
  await t.test('replacement',t=>{
    const e=published(t), bytes=readFileSync(e.result.path);
    const result=readMediaResource(e.cache,e.binding,{afterBlobRead:()=>{renameSync(e.result.path,`${e.result.path}.old`);writeFileSync(e.result.path,bytes,{mode:0o600});}});
    assert.equal(result.status,'invalid');
  });
  await t.test('mode mutation',t=>{
    const e=published(t);assert.equal(readMediaResource(e.cache,e.binding,{afterBlobRead:()=>chmodSync(e.result.path,0o640)}).status,'invalid');
  });
  await t.test('manifest replacement after its read',t=>{
    const e=published(t), bytes=readFileSync(e.manifestPath);
    const result=readMediaResource(e.cache,e.binding,{afterBlobRead:()=>{renameSync(e.manifestPath,`${e.manifestPath}.old`);writeFileSync(e.manifestPath,bytes,{mode:0o600});}});
    assert.equal(result.status,'invalid');
  });
  await t.test('cache replacement',t=>{
    const e=published(t);notAvailable(readMediaResource(e.cache,e.binding,{afterBlobRead:()=>{renameSync(e.cache,`${e.cache}.old`);mkdirSync(e.cache,{mode:0o700});}}));
  });
});

test('failed publication leaves no available manifest or temporary files',t=>{
  const e=setup(t);
  assert.deepEqual(publishMediaResource(e.cache,e.binding,png(),{nowMs},{beforeManifest:()=>{throw new Error('synthetic private failure');}}),
    {status:'invalid',reason:'resource_publish_failed'});
  assert.equal(readMediaResource(e.cache,e.binding).status,'missing');
  assert.ok(readdirSync(e.cache).every(name=>name.endsWith('.blob')));
  const fixed=publishMediaResource(e.cache,e.binding,png(),{nowMs});assert.equal(fixed.status,'available');
});

test('concurrent competitors never overwrite a complete valid binding and reuse identical blobs',t=>{
  const e=setup(t);let competing;
  const result=publishMediaResource(e.cache,e.binding,png({color:1}),{nowMs},{beforeManifest:()=>{
    competing=publishMediaResource(e.cache,e.binding,png({color:2}),{nowMs:nowMs+1});
  }});
  assert.equal(result.status,'available');assert.deepEqual(result,competing);
  assert.equal(result.sha256,hash(png({color:2})));
  assert.deepEqual(publishMediaResource(e.cache,e.binding,png({color:3}),{nowMs:nowMs+2}),result);
  assert.equal(readdirSync(e.cache).filter(name=>name.endsWith('.json')).length,1);
  assert.equal(readdirSync(e.cache).filter(name=>name.endsWith('.tmp')).length,0);
  const another={...e.binding,external_id:'om_other'};
  assert.equal(publishMediaResource(e.cache,another,png({color:2}),{nowMs}).status,'available');
  assert.equal(readdirSync(e.cache).filter(name=>name.endsWith('.blob')).length,2);
});

test('preexisting invalid files and invalid timestamps cannot be made ready',async t=>{
  await t.test('malicious blob',t=>{
    const e=setup(t);mkdirSync(e.cache,{mode:0o700});const blob=join(e.cache,`${hash(png())}.blob`);
    writeFileSync(blob,'wrong bytes',{mode:0o600});assert.equal(publishMediaResource(e.cache,e.binding,png(),{nowMs}).status,'invalid');
    assert.equal(readFileSync(blob,'utf8'),'wrong bytes');assert.equal(readdirSync(e.cache).length,1);
  });
  await t.test('time',t=>{
    const e=setup(t);
    for(const invalid of [-1,Infinity,NaN,1.2,Number.MAX_SAFE_INTEGER])
      assert.deepEqual(publishMediaResource(e.cache,e.binding,png(),{nowMs:invalid}),{status:'invalid',reason:'resource_time_invalid'});
    assert.equal(existsSync(e.cache),false);
  });
});
