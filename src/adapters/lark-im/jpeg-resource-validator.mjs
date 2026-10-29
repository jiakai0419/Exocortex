// @ts-check
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';

const defaultHelper=fileURLToPath(new URL('../../../build/native/jpeg-validator',import.meta.url));
const source=fileURLToPath(new URL('../../native/jpeg-validator.c',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs','mode','uid','nlink'].every(key=>a[key]===b[key]);
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=reason=>({reason});
const unchanged=(path,info)=>{const current=lstatSync(path,{bigint:true});return current.isFile()&&!current.isSymbolicLink()&&same(info,current);};
const sameDirectory=(a,b)=>['dev','ino','birthtimeNs','uid','gid','mode'].every(key=>a[key]===b[key]);

/** Current-UID ownership permits chmod; mode and access cover ordinary DAC/ACL
 * write access. This is not a boundary against privileged/special ACL attacks. */
function mayReplaceChildren(path,info) {
  if(info.uid===BigInt(process.getuid?.()??-1)||(info.mode&0o022n)!==0n)return true;
  try {accessSync(path,constants.W_OK);return true;}
  catch(error) {
    if(['EACCES','EPERM','EROFS'].includes(/** @type {NodeJS.ErrnoException} */(error).code??''))return false;
    throw error;
  }
}

function closeDirectories(entries) {
  let closed=true;
  for(const entry of entries)try {closeSync(entry.fd);}catch {closed=false;}
  return closed;
}

/** Hold a bounded canonical chain. Protection is inherited only from an
 * unbroken non-writable prefix; a deeper root-owned directory cannot reset it. */
function captureDirectories(helper) {
  const parent=dirname(helper),root=parse(parent).root,paths=[root];
  for(const part of parent.slice(root.length).split('/').filter(Boolean)) {
    if(paths.length===64)throw new Error('decoder_path_depth');
    paths.push(join(paths[paths.length-1],part));
  }
  const entries=[];let protectedEntry=true;
  try {
    for(const path of paths) {
      const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const entry={path,fd,info:/** @type {import('node:fs').BigIntStats|undefined} */(undefined),protectedEntry};entries.push(entry);
      const info=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
      if(!info.isDirectory()||!named.isDirectory()||named.isSymbolicLink()
        ||!sameDirectory(info,named)||!protectedEntry&&info.ctimeNs!==named.ctimeNs||realpathSync(path)!==path)throw new Error('changed_decoder_path');
      entry.info=info;
      protectedEntry=protectedEntry&&!mayReplaceChildren(path,info);
    }
    return entries;
  } catch(error) {closeDirectories(entries);throw error;}
}

function directoriesUnchanged(entries) {
  return entries.every(({path,fd,info,protectedEntry})=>{
    const opened=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});
    return opened.isDirectory()&&named.isDirectory()&&!named.isSymbolicLink()
      &&sameDirectory(info,opened)&&sameDirectory(info,named)&&realpathSync(path)===path
      &&(protectedEntry||(info.ctimeNs===opened.ctimeNs&&info.ctimeNs===named.ctimeNs));
  });
}

/** Small stable code/receipt reads. No executable or path is supplied by media. */
function readStable(path,maximum,executable=false) {
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd,{bigint:true}),uid=BigInt(process.getuid?.()??-1);
    if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(maximum)
      || ![0n,uid].includes(before.uid)||(before.mode&0o022n)!==0n
      || executable&&(before.mode&0o111n)===0n)throw new Error('unsafe_decoder');
    const buffer=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<buffer.length){const n=readSync(fd,buffer,length,buffer.length-length,length);if(!n)break;length+=n;}
    const after=fstatSync(fd,{bigint:true});
    if(length!==Number(before.size)||!same(before,after)||!unchanged(path,after))throw new Error('changed_decoder');
    return {bytes:buffer.subarray(0,length),info:after};
  } finally {if(fd!==undefined)closeSync(fd);}
}

/** A trusted static native helper supplies decoding authority; the JS layer
 * validates installation/protocol and keeps all source bytes off disk/stdout.
 * @param {Buffer} bytes @param {{width:number,height:number}} [expected]
 * @param {{env?:NodeJS.ProcessEnv,spawnSync?:typeof spawnSync}} [deps] */
export function validateJpegResource(bytes,expected=undefined,deps={}) {
  if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>16*1024*1024)return failure('resource_image_invalid');
  if(expected&&(!Number.isSafeInteger(expected.width)||!Number.isSafeInteger(expected.height)||expected.width<1||expected.height<1
    ||expected.width>65535||expected.height>65535
    ||expected.width*expected.height*4>64*1024*1024))return failure('resource_validation_limit');
  const env=deps.env||process.env,configured=env.EXOCORTEX_JPEG_VALIDATOR??defaultHelper;
  let helper,receipt,installed,receiptFile;let directories=[];
  try {
    if(!isAbsolute(configured)||configured.length>8192||/[\x00-\x1f\x7f]/.test(configured))throw new Error('invalid_decoder_path');
    helper=realpathSync(configured);directories=captureDirectories(helper);installed=readStable(helper,32*1024*1024,true);
    receiptFile=readStable(`${helper}.json`,8192);const receiptJson=receiptFile.bytes.toString('utf8');validateJsonObjectText(receiptJson);receipt=JSON.parse(receiptJson);
    const receiptKeys=['version','protocol','platform','arch','source_sha256','binary_sha256','decoder','decoder_version','archive_sha256','headers_sha256'];
    if(!object(receipt)||Object.keys(receipt).length!==receiptKeys.length||receiptKeys.some(key=>!Object.hasOwn(receipt,key))
      ||receipt.version!==1||receipt.protocol!=='exocortex_jpeg_validator/v1'||receipt.platform!==process.platform||receipt.arch!==process.arch
      ||receipt.decoder!=='libjpeg-turbo'||typeof receipt.decoder_version!=='string'||!/^\d+(?:\.\d+){2,3}$/.test(receipt.decoder_version)
      ||!['source_sha256','binary_sha256','archive_sha256','headers_sha256'].every(key=>digest(receipt[key]))
      ||receipt.binary_sha256!==sha(installed.bytes)||receipt.source_sha256!==sha(readStable(source,128*1024).bytes))throw new Error('invalid_decoder_receipt');
    if(!directoriesUnchanged(directories))throw new Error('changed_decoder_path');
    const result=(deps.spawnSync||spawnSync)(helper,[],{input:bytes,encoding:'utf8',timeout:5000,killSignal:'SIGKILL',
      maxBuffer:8192,env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC'}});
    if(!directoriesUnchanged(directories)||!unchanged(helper,installed.info)||!unchanged(`${helper}.json`,receiptFile.info))return failure('resource_decoder_unavailable');
    if(result.error||result.signal)return failure(/** @type {NodeJS.ErrnoException|undefined} */(result.error)?.code==='ETIMEDOUT'||result.signal==='SIGXCPU'
      ?'resource_validation_limit':'resource_decoder_unavailable');
    if(result.stderr)return failure('resource_decoder_unavailable');
    const json=String(result.stdout);validateJsonObjectText(json);const response=JSON.parse(json);
    if(!object(response)||response.version!==1)return failure('resource_decoder_unavailable');
    if(response.status!=='valid') {
      const reasons={invalid:[10,'resource_image_invalid'],unsupported:[11,'resource_format_unsupported'],
        limit:[12,'resource_validation_limit'],internal:[13,'resource_decoder_unavailable']};
      const match=reasons[response.status];
      return Object.keys(response).length===2&&match&&result.status===match[0]
        ?failure(match[1]):failure('resource_decoder_unavailable');
    }
    const keys=['version','status','width','height','scans','decoder','decoder_version'];
    if(result.status!==0||Object.keys(response).length!==keys.length||keys.some(key=>!Object.hasOwn(response,key))
      ||!Number.isSafeInteger(response.width)||!Number.isSafeInteger(response.height)||response.width<1||response.height<1
      ||response.width>65535||response.height>65535
      ||response.width*response.height*4>64*1024*1024
      ||expected&&(response.width!==expected.width||response.height!==expected.height)||!Number.isSafeInteger(response.scans)||response.scans<1||response.scans>100
      ||response.decoder!=='libjpeg-turbo'||response.decoder_version!==receipt.decoder_version)return failure('resource_decoder_unavailable');
    return {image:{mime_type:'image/jpeg',width:response.width,height:response.height}};
  } catch {return failure('resource_decoder_unavailable');}
  finally {if(!closeDirectories(directories))return failure('resource_decoder_unavailable');}
}
