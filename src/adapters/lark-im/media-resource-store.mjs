// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';

/** @typedef {Record<string,any>} JsonObject */
export const MAX_MEDIA_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 40 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16384;
const HASH = /^[a-f0-9]{64}$/;
const hashValid = value => typeof value === 'string' && HASH.test(value);
const bindingKeys = ['schema','database','source_id','external_id','external_version','content_hash',
  'container_id','account_key','type','key'];
const manifestKeys = ['schema','binding','binding_digest','sha256','size_bytes','mime_type','observed_at'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const finite = (status, reason) => ({ status, reason });
const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs','mode','uid','nlink'].every(key => a[key] === b[key]);
const sameDirectory = (a, b) => ['dev','ino','mode','uid'].every(key => a[key] === b[key]);
const privateOwned = info => typeof process.getuid === 'function' && info.uid === BigInt(process.getuid()) && (info.mode & 0o077n) === 0n;
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
const keyValid = value => text(value) && !/[\s/:\\]/u.test(value);
const errorCode = error => /** @type {NodeJS.ErrnoException} */ (error)?.code;

/** @param {string} db @param {string} [override] */
export function resourceStorePath(db, override) { return override === undefined ? `${resolve(db)}.resources` : resolve(override); }

/** DB growth/checkpoint/mtime is unrelated to source or resource identity. */
function databaseIdentity(db) {
  const path = realpathSync(db), info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid_database');
  return { path, dev: String(info.dev), ino: String(info.ino) };
}

/** @param {string} db @param {JsonObject} row @param {string} accountKey @param {JsonObject} media */
export function makeMediaResourceBinding(db, row, accountKey, media) {
  try {
    if (!object(row) || row.source_id !== 'lark.im' || row.record_type !== 'lark.im.message'
      || !text(row.external_id) || !text(row.container_id) || !hashValid(row.content_hash)
      || !hashValid(accountKey) || !(row.external_version === null || text(row.external_version, 512))
      || typeof row.raw_json !== 'string' || row.raw_json.length > 256 * 1024
      || sha(row.raw_json) !== row.content_hash || media?.type !== 'image'
      || media.resource?.kind !== 'image_key' || media.resource?.state !== 'reference_only'
      || !keyValid(media.resource?.key)) return null;
    validateJsonObjectText(row.raw_json);
    const raw = JSON.parse(row.raw_json);
    if (Object.hasOwn(raw, 'raw_api') && !object(raw.raw_api)) return null;
    const native = Object.hasOwn(raw, 'raw_api') ? raw.raw_api : raw;
    if ((native.msg_type || native.message_type) !== 'image' || native.deleted === true
      || native.message_id !== row.external_id || native.chat_id !== row.container_id) return null;
    for (const value of [raw, native]) {
      if ([value.msg_type, value.message_type].some(type => type != null && type !== 'image')
        || [value.message_id, value.id].some(id => id != null && id !== row.external_id)
        || [value.chat_id, value.chat?.id, value.chat?.chat_id].some(id => id != null && id !== row.container_id)) return null;
    }
    let content = native.body?.content;
    if (typeof content === 'string') { validateJsonObjectText(content); content = JSON.parse(content); }
    if (!object(content) || content.image_key !== media.resource.key) return null;
    return Object.freeze({ schema: 'lark_media_resource_binding/v1', database: Object.freeze(databaseIdentity(db)),
      source_id: 'lark.im', external_id: row.external_id, external_version: row.external_version,
      content_hash: row.content_hash, container_id: row.container_id, account_key: accountKey,
      type: 'image', key: media.resource.key });
  } catch { return null; }
}

function normalizedBinding(binding) {
  if (!exactKeys(binding, bindingKeys) || binding.schema !== 'lark_media_resource_binding/v1'
    || !exactKeys(binding.database, ['path','dev','ino']) || !text(binding.database.path, 8192)
    || typeof binding.database.dev !== 'string' || typeof binding.database.ino !== 'string'
    || !/^[0-9]+$/.test(binding.database.dev) || !/^[0-9]+$/.test(binding.database.ino)
    || binding.source_id !== 'lark.im' || !text(binding.external_id) || !text(binding.container_id)
    || !(binding.external_version === null || text(binding.external_version, 512))
    || !hashValid(binding.content_hash) || !hashValid(binding.account_key)
    || binding.type !== 'image' || !keyValid(binding.key)) throw new Error('invalid_binding');
  const current = databaseIdentity(binding.database.path);
  if (JSON.stringify(current) !== JSON.stringify(binding.database)) throw new Error('database_changed');
  return Object.fromEntries(bindingKeys.map(key => [key, binding[key]]));
}

/** Container validation is not OCR or a semantic/visual interpretation. */
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 65535 || height > 65535 || width * height > MAX_PIXELS) throw new Error('image_dimensions');
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function unsupportedImageControl() {
  throw Object.assign(new Error('format_unsupported'),{code:'MEDIA_FORMAT_UNSUPPORTED'});
}
function png(bytes) {
  let offset = 8, width = 0, height = 0, depth = 0, channels = 0, interlace = 0;
  let ihdr = false, ended = false, imageEnded = false, palette = 0;
  const controls = new Set();
  /** @type {Buffer|null} */ let histogram = null;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('png_truncated');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('png_truncated');
    const type = bytes.toString('latin1', offset + 4, offset + 8), data = bytes.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error('png_crc');
    if (!ihdr && type !== 'IHDR') throw new Error('png_header');
    if (type === 'IHDR') {
      if (ihdr || offset !== 8 || length !== 13) throw new Error('png_header');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); dimensions(width, height);
      depth = data[8]; const color = data[9]; interlace = data[12];
      const validDepths = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
      if (!validDepths[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || interlace > 1) throw new Error('png_header');
      channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color]; ihdr = true;
    } else if (type === 'PLTE') {
      if (compressed.length || palette || controls.size || length < 3 || length > 768 || length % 3
        || [0,4].includes(bytes[25]) || bytes[25] === 3 && length/3 > 2**depth) throw new Error('png_palette');
      palette = length/3;
    } else if (['tRNS','bKGD','hIST'].includes(type)) {
      if (compressed.length || controls.has(type)) throw new Error('png_control_order');
      const color=bytes[25];
      if(type==='tRNS') {
        if([4,6].includes(color) || color===0 && length!==2 || color===2 && length!==6
          || color===3 && (!palette || length>palette)) throw new Error('png_transparency');
      } else if(type==='bKGD') {
        if(color===3 ? !palette || length!==1 || data[0]>=palette : length!==([0,4].includes(color)?2:6))
          throw new Error('png_background');
      } else {
        if(!palette || length!==palette*2) throw new Error('png_histogram');
        histogram=data;
      }
      // PNG decoders mask unused high bits of low-depth tRNS/bKGD samples.
      // Do not reject those legal fields merely for their unused high bits.
      controls.add(type);
    } else if (['acTL','fcTL','fdAT'].includes(type)) {
      // A complete default IDAT is not evidence for declared animation frames.
      unsupportedImageControl();
    } else if (type === 'IDAT') {
      if (imageEnded) throw new Error('png_order');
      compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== bytes.length) throw new Error('png_end');
      ended = true;
    } else {
      if (compressed.length) imageEnded = true;
      if (type[0] === type[0].toUpperCase()) throw new Error('png_unknown_critical');
    }
    offset = end;
  }
  if (!ended || bytes[25] === 3 && !palette) throw new Error('png_incomplete');
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = []; let expected = 0;
  for (const [x,y,dx,dy] of passes) {
    const w = Math.ceil(Math.max(0, width-x)/dx), h = Math.ceil(Math.max(0, height-y)/dy);
    if (!w || !h) continue;
    const size = Math.ceil(w * depth * channels / 8) + 1;
    expected += size * h; rows.push([size,h,w]);
  }
  if (expected > MAX_DECODED_BYTES) throw new Error('image_decoded_limit');
  const encoded = Buffer.concat(compressed);
  // Node's types omit the documented info:true return shape.
  const inflated = /** @type {{buffer:Buffer,engine:{bytesWritten:number}}} */ (/** @type {unknown} */ (
    inflateSync(encoded, { maxOutputLength: expected + 1, info: true })));
  const decoded = inflated.buffer;
  if (inflated.engine.bytesWritten !== encoded.length || decoded.length !== expected) throw new Error('png_pixels');
  let at = 0;
  for (const [size, count, w] of rows) {
    let previous=Buffer.alloc(size-1);
    for (let i=0;i<count;i++) {
      const filter=decoded[at];if(filter>4)throw new Error('png_filter');
      if(bytes[25]===3) {
        const current=Buffer.from(decoded.subarray(at+1,at+size));
        for(let x=0;x<current.length;x++) {
          const a=x?current[x-1]:0,b=previous[x],c=x?previous[x-1]:0;
          const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
          const predictor=filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?(pa<=pb&&pa<=pc?a:pb<=pc?b:c):0;
          current[x]=(current[x]+predictor)&255;
        }
        for(let x=0;x<w;x++) {
          const index=(current[Math.floor(x*depth/8)]>>(8-depth-(x*depth%8)))&((1<<depth)-1);
          if(index>=palette || histogram && histogram.readUInt16BE(index*2)===0)throw new Error('png_palette_index');
        }
        previous=current;
      }
      at+=size;
    }
  }
  return { mime_type: 'image/png', width, height };
}
function gifPixels(bytes, minimum, expected, colors) {
  const clear = 1 << minimum, stop = clear + 1, lengths = new Uint32Array(4096), first = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) { lengths[i] = 1; first[i] = i; }
  let at = 0, width = minimum + 1, next = stop + 1, previous = -1, count = 0, started = false;
  while (at + width <= bytes.length * 8) {
    let code = 0;
    for (let bit = 0; bit < width; bit++, at++) code |= ((bytes[at >> 3] >> (at & 7)) & 1) << bit;
    if (!started && code !== clear) throw new Error('gif_clear');
    started = true;
    if (code === clear) { width = minimum + 1; next = stop + 1; previous = -1; continue; }
    if (code === stop) { if (count !== expected) throw new Error('gif_pixels'); return; }
    if (code > next || code === next && previous < 0 || previous < 0 && code >= clear
      || code < clear && code >= colors) throw new Error('gif_code');
    const length = code === next ? lengths[previous] + 1 : lengths[code];
    const firstPixel = code === next ? first[previous] : first[code];
    if (!length || (count += length) > expected) throw new Error('gif_pixels');
    if (previous >= 0 && next < 4096) {
      lengths[next] = lengths[previous] + 1; first[next] = first[previous]; next++;
      if (next === 1 << width && width < 12) width++;
    }
    // A dictionary entry contains previous + firstPixel. Length and first literal suffice
    // to validate every expansion and bound its pixels without allocating decoded frames.
    if (firstPixel >= colors) throw new Error('gif_palette');
    previous = code;
  }
  throw new Error('gif_missing_stop');
}
function gif(bytes) {
  if (bytes.length < 14) throw new Error('gif_truncated');
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8); dimensions(width, height);
  const globalColors = bytes[10] & 128 ? 2 ** ((bytes[10] & 7) + 1) : 0;
  if(globalColors && bytes[11]>=globalColors)throw new Error('gif_background');
  let at = 13 + 3 * globalColors, images = 0, totalPixels = 0;
  /** @type {{transparent:number|null}|null} */ let control=null;
  const blocks = (collect = false) => {
    const parts = [];
    while (at < bytes.length) {
      const n = bytes[at++]; if (n === 0) return collect ? Buffer.concat(parts) : null;
      if (at + n > bytes.length) throw new Error('gif_truncated');
      if (collect) parts.push(bytes.subarray(at, at+n)); at += n;
    }
    throw new Error('gif_truncated');
  };
  while (at < bytes.length) {
    const tag = bytes[at++];
    if (tag === 0x3b) { if (!images || control || at !== bytes.length) throw new Error('gif_end'); return { mime_type: 'image/gif', width, height }; }
    if (tag === 0x21) {
      if (at >= bytes.length) throw new Error('gif_truncated');
      const label=bytes[at++];
      if(label===0xf9) {
        if(control || at+6>bytes.length || bytes[at]!==4 || bytes[at+5]!==0 || bytes[at+1]&0xe0)
          throw new Error('gif_control');
        const packed=bytes[at+1];
        if((packed>>2&7)>3)unsupportedImageControl();
        control={transparent:packed&1?bytes[at+4]:null};at+=6;
      } else {
        // Unknown rendering/control blocks, including Plain Text, cannot be
        // dropped while treating the file's raster images as complete content.
        if(label<0xfa)unsupportedImageControl();
        if(label===0xff) {
          if(at+12>bytes.length || bytes[at]!==11)throw new Error('gif_application');
          for(let i=at+1;i<at+9;i++)if(bytes[i]<0x20 || bytes[i]>0x7e)throw new Error('gif_application');
          at+=12;
        }
        blocks();
      }
      continue;
    }
    if (tag !== 0x2c || at + 9 > bytes.length) throw new Error('gif_block');
    const x = bytes.readUInt16LE(at), y = bytes.readUInt16LE(at+2), w = bytes.readUInt16LE(at+4), h = bytes.readUInt16LE(at+6);
    dimensions(w,h); if (x+w > width || y+h > height) throw new Error('gif_frame');
    if ((totalPixels += w*h) > MAX_DECODED_BYTES) throw new Error('image_decoded_limit');
    const flags = bytes[at+8], colors = flags & 128 ? 2 ** ((flags & 7) + 1) : globalColors; at += 9;
    if (!colors || flags & 24) throw new Error('gif_palette');
    if(control?.transparent!==null && control?.transparent!==undefined && control.transparent>=colors)
      throw new Error('gif_transparency');
    if (flags & 128) at += 3 * colors;
    if (at >= bytes.length || bytes[at] < 2 || bytes[at] > 8) throw new Error('gif_code_size');
    const minimum = bytes[at++], codes = blocks(true);
    if (!codes?.length) throw new Error('gif_empty');
    gifPixels(codes, minimum, w*h, colors); images++;control=null;
  }
  throw new Error('gif_truncated');
}
function jpeg(bytes) {
  let at = 2, width = 0, height = 0, scans = 0, frame = 0, precision = 0;
  const components = new Set();
  while (at < bytes.length) {
    if (bytes[at++] !== 0xff) throw new Error('jpeg_marker');
    while (at < bytes.length && bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) {
      if (at !== bytes.length || !width || !scans) throw new Error('jpeg_end');
      return { mime_type: 'image/jpeg', width, height, max_decoded_bytes_per_pixel:precision>8?8:4 };
    }
    if ([0,0xd8,0x01].includes(marker) || marker >= 0xd0 && marker <= 0xd7 || at + 2 > bytes.length) throw new Error('jpeg_marker');
    const size = bytes.readUInt16BE(at), end = at + size;
    if (size < 2 || end > bytes.length) throw new Error('jpeg_truncated');
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (size < 8 || width) throw new Error('jpeg_frame');
      height = bytes.readUInt16BE(at+3); width = bytes.readUInt16BE(at+5); dimensions(width,height);
      if (![8,12].includes(bytes[at+2]) || marker === 0xc0 && bytes[at+2] !== 8
        || ![1,3,4].includes(bytes[at+7]) || size !== 8+3*bytes[at+7]) throw new Error('jpeg_frame');
      frame = marker;precision=bytes[at+2];
      for (let i=0;i<bytes[at+7];i++) {
        const id=bytes[at+8+3*i], factors=bytes[at+9+3*i], table=bytes[at+10+3*i];
        if (components.has(id) || !(factors>>4) || factors>>4>4 || !(factors&15) || (factors&15)>4 || table>3) throw new Error('jpeg_component');
        components.add(id);
      }
    }
    if (marker === 0xda) {
      const count = bytes[at+2];
      if (!width || size < 8 || count<1 || count>components.size || size !== 6+2*count) throw new Error('jpeg_scan');
      const selected = new Set();
      for (let i=0;i<count;i++) {
        const id=bytes[at+3+2*i], tables=bytes[at+4+2*i];
        if (!components.has(id) || selected.has(id) || tables>>4>3 || (tables&15)>3) throw new Error('jpeg_scan');
        selected.add(id);
      }
      const low=bytes[end-3], high=bytes[end-2], successive=bytes[end-1];
      if (low>high || high>63 || successive>>4>13 || (successive&15)>13
        || frame!==0xc2 && (low!==0 || high!==63 || successive!==0)
        || frame===0xc2 && (low===0 && high!==0 || low>0 && count!==1)) throw new Error('jpeg_spectral');
      scans++; at = end; let data = 0;
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) { data++; at++; continue; }
        if (at+1 >= bytes.length) throw new Error('jpeg_truncated');
        const next = bytes[at+1];
        if (next === 0 || next >= 0xd0 && next <= 0xd7) { data++; at += 2; continue; }
        if (next === 0xff) { at++; continue; }
        break;
      }
      if (!data) throw new Error('jpeg_empty_scan');
    } else at = end;
  }
  throw new Error('jpeg_truncated');
}
function webp(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length-8) throw new Error('webp_length');
  let at = 12, width = 0, height = 0, image = false;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error('webp_truncated');
    const tag = bytes.toString('latin1',at,at+4), size = bytes.readUInt32LE(at+4), start = at+8, end = start+size;
    if (end+(size&1) > bytes.length || size&1 && bytes[end]!==0) throw new Error('webp_truncated');
    if (tag === 'VP8 ') {
      if (image || size < 11 || (bytes[start] & 1) !== 0 || ((bytes[start]>>1)&7)>3
        || !(bytes[start]&16) || bytes.toString('hex',start+3,start+6) !== '9d012a') throw new Error('webp_vp8');
      const w = bytes.readUInt16LE(start+6)&0x3fff, h = bytes.readUInt16LE(start+8)&0x3fff; dimensions(w,h);
      if (width && (width !== w || height !== h)) throw new Error('webp_dimensions'); width=w; height=h; image=true;
      if ((bytes.readUIntLE(start,3) >>> 5) + 10 > size) throw new Error('webp_partition');
    } else if (tag === 'VP8L') {
      if (image || size < 6 || bytes[start] !== 0x2f || bytes[start+4] >>> 5) throw new Error('webp_vp8l');
      const bits = bytes.readUInt32LE(start+1), w = (bits&0x3fff)+1, h=((bits>>>14)&0x3fff)+1; dimensions(w,h);
      if (width && (width !== w || height !== h)) throw new Error('webp_dimensions'); width=w; height=h; image=true;
    } else if (tag === 'VP8X') {
      if (at !== 12 || size !== 10 || bytes[start] & 0xc3 || bytes[start+1] || bytes[start+2] || bytes[start+3]) throw new Error('webp_extended'); // Animated WebP needs a separate decoder contract.
      width=bytes.readUIntLE(start+4,3)+1; height=bytes.readUIntLE(start+7,3)+1; dimensions(width,height);
    } else if (!['ALPH','ICCP','EXIF','XMP '].includes(tag)) throw new Error('webp_chunk');
    at=end+(size&1);
  }
  if (!image) throw new Error('webp_missing_image');
  return { mime_type:'image/webp',width,height };
}

export function assessMediaImageBytes(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > MAX_MEDIA_RESOURCE_BYTES) throw new Error('image_invalid');
    let image;
    if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) image=png(bytes);
    else if (['GIF87a','GIF89a'].includes(bytes.toString('latin1',0,6))) image=gif(bytes);
    else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      // System decoders may fill missing MCUs and still return success and the
      // declared dimensions. Container checks alone cannot prove JPEG pixels.
      jpeg(bytes);throw Object.assign(new Error('format_unsupported'),{code:'MEDIA_FORMAT_UNSUPPORTED'});
    }
    else if (bytes.toString('latin1',0,4) === 'RIFF' && bytes.toString('latin1',8,12) === 'WEBP') {
      webp(bytes);throw Object.assign(new Error('format_unsupported'),{code:'MEDIA_FORMAT_UNSUPPORTED'});
    }
    else throw new Error('image_invalid');
    return {image:{mime_type:image.mime_type,width:image.width,height:image.height}};
  } catch(error) {return {reason:errorCode(error)==='MEDIA_FORMAT_UNSUPPORTED'?'resource_format_unsupported':'resource_image_invalid'};}
}
/** @param {Buffer} bytes */
export function inspectMediaImageBytes(bytes) {return assessMediaImageBytes(bytes).image ?? null;}

function directory(cacheDir, create) {
  const requested = resolve(cacheDir), root = join(realpathSync(dirname(requested)), basename(requested));
  if (create) { try { mkdirSync(root,{mode:0o700}); } catch(error) { if(errorCode(error)!=='EEXIST') throw error; } }
  const info = lstatSync(root,{bigint:true});
  if (!info.isDirectory() || info.isSymbolicLink() || !privateOwned(info)) throw new Error('unsafe_store');
  return { root, info };
}
function directoryUnchanged(dir) {
  const now=lstatSync(dir.root,{bigint:true});
  if (!now.isDirectory() || now.isSymbolicLink() || !sameDirectory(dir.info,now)) throw new Error('store_changed');
}
function readPrivateBytes(path, maximum, afterRead) {
  let fd;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd,{bigint:true});
    if (!before.isFile() || before.nlink!==1n || !privateOwned(before) || before.size<1n || before.size>BigInt(maximum)) throw new Error('unsafe_file');
    const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
    while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,length);if(!n)break;length+=n;}
    afterRead?.();
    const after=fstatSync(fd,{bigint:true}), current=lstatSync(path,{bigint:true});
    if(length!==Number(before.size)||!current.isFile()||current.isSymbolicLink()||!same(before,after)||!same(after,current))throw new Error('file_changed');
    return {bytes:bytes.subarray(0,length),info:after};
  } finally { if(fd!==undefined)closeSync(fd); }
}
function fileUnchanged(path,info) {
  const now=lstatSync(path,{bigint:true});
  if(!now.isFile()||now.isSymbolicLink()||!same(info,now))throw new Error('file_changed');
}

/** Revalidate each read. Missing evidence cannot become an implicit download.
 * @param {string} cacheDir @param {JsonObject|null} binding
 * @param {{afterBlobRead?:()=>void}} [deps] */
export function readMediaResource(cacheDir,binding,deps={}) {
  try {
    const normalized=normalizedBinding(binding), digest=sha(JSON.stringify(normalized));
    const dir=directory(cacheDir,false), file=join(dir.root,`${digest}.json`);
    const manifestFile=readPrivateBytes(file,MAX_MANIFEST_BYTES,undefined);
    const json=manifestFile.bytes.toString('utf8');validateJsonObjectText(json);const manifest=JSON.parse(json);
    if(!exactKeys(manifest,manifestKeys)||manifest.schema!=='lark_media_resource/v1'
      ||JSON.stringify(manifest.binding)!==JSON.stringify(normalized)||manifest.binding_digest!==digest
      ||!hashValid(manifest.sha256)||!Number.isSafeInteger(manifest.size_bytes)||manifest.size_bytes<1||manifest.size_bytes>MAX_MEDIA_RESOURCE_BYTES
      ||typeof manifest.observed_at!=='string'||!Number.isFinite(Date.parse(manifest.observed_at))||Date.parse(manifest.observed_at)<0
      ||new Date(manifest.observed_at).toISOString()!==manifest.observed_at)throw new Error('invalid_manifest');
    const path=join(dir.root,`${manifest.sha256}.blob`), blobFile=readPrivateBytes(path,MAX_MEDIA_RESOURCE_BYTES,deps.afterBlobRead), asset=blobFile.bytes;
    if(asset.length!==manifest.size_bytes||sha(asset)!==manifest.sha256)throw new Error('asset_changed');
    const inspected=assessMediaImageBytes(asset), image=inspected.image;
    if(!image)return finite('invalid',inspected.reason);
    if(image.mime_type!==manifest.mime_type)throw new Error('invalid_image');
    fileUnchanged(file,manifestFile.info);fileUnchanged(path,blobFile.info);
    directoryUnchanged(dir);normalizedBinding(binding);
    return {status:'available',path,sha256:manifest.sha256,size_bytes:asset.length,mime_type:image.mime_type,
      binding_digest:digest,observed_at:manifest.observed_at};
  } catch(error) {
    if(errorCode(error)==='ENOENT')return finite('missing','resource_not_cached');
    return finite('invalid','resource_verification_failed');
  }
}

function publishFile(dir,name,bytes) {
  const temporary=join(dir.root,`.${randomUUID()}.tmp`), target=join(dir.root,name);let fd;
  try {
    directoryUnchanged(dir);fd=openSync(temporary,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;
    directoryUnchanged(dir);
    try {linkSync(temporary,target);}catch(error){if(errorCode(error)!=='EEXIST')throw error;}
  } finally {if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}}
  directoryUnchanged(dir);return target;
}

/** No replacement of an existing manifest; caller owns source/account admission.
 * @param {string} cacheDir @param {JsonObject|null} binding @param {Buffer} bytes
 * @param {{nowMs?:number}} [options] @param {{beforeManifest?:()=>void}} [deps] */
export function publishMediaResource(cacheDir,binding,bytes,options={},deps={}) {
  try {
    const {nowMs=Date.now()}=options;
    const normalized=normalizedBinding(binding), digest=sha(JSON.stringify(normalized)), inspected=assessMediaImageBytes(bytes), image=inspected.image;
    if(!image)return finite('invalid',inspected.reason);
    if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isFinite(new Date(nowMs).getTime()))return finite('invalid','resource_time_invalid');
    const existing=readMediaResource(cacheDir,binding);
    if(existing.status==='available')return existing;
    if(existing.status==='invalid')return existing;
    const dir=directory(cacheDir,true), hash=sha(bytes), blob=publishFile(dir,`${hash}.blob`,bytes);
    const checked=readPrivateBytes(blob,MAX_MEDIA_RESOURCE_BYTES,undefined);
    if(!checked.bytes.equals(bytes))return finite('invalid','resource_verification_failed');
    deps.beforeManifest?.();normalizedBinding(binding);
    const manifest={schema:'lark_media_resource/v1',binding:normalized,binding_digest:digest,sha256:hash,
      size_bytes:bytes.length,mime_type:image.mime_type,observed_at:new Date(nowMs).toISOString()};
    publishFile(dir,`${digest}.json`,Buffer.from(JSON.stringify(manifest)+'\n'));
    return readMediaResource(cacheDir,binding);
  }catch{return finite('invalid','resource_publish_failed');}
}

// Explicit maintenance continuation only. The normal reader above never opens
// this namespace; pending evidence cannot supply an available manifest.
export const MEDIA_PENDING_TTL_MS = 60 * 60 * 1000;
export const MAX_PENDING_MEDIA_RESOURCES = 20;
export const MEDIA_RESOURCE_SOURCE_FIELDS = Object.freeze(['id','source_id','record_type','external_id','external_version','content_hash',
  'raw_json','canonical_json','actor_id','container_id','direction','occurred_at','occurred_at_ms','body']);
const pendingKeys = ['schema','generation','binding','source_fence','sha256','size_bytes','mime_type',
  'opening_at_ms','original_closing_at_ms','created_at_ms','expires_at_ms','stop_reason'];
const claimKeys = ['schema','generation','created_at_ms'];
const resumableStops = new Set(['sync_busy','cli_budget','self_budget','time_budget']);
const validTime = n => Number.isSafeInteger(n) && n >= 0 && Number.isFinite(new Date(n).getTime());
const validGeneration = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const slots = Array.from({length:MAX_PENDING_MEDIA_RESOURCES},(_,i)=>`slot-${String(i).padStart(2,'0')}`);

export function makeMediaPendingSourceFence(row) {
  if (!object(row) || !Number.isSafeInteger(row.id) || row.id < 1 || MEDIA_RESOURCE_SOURCE_FIELDS.some(key=>
    !Object.hasOwn(row,key) || !(row[key]===null || typeof row[key]==='string' || typeof row[key]==='number' && Number.isFinite(row[key])))) return null;
  return sha(JSON.stringify(MEDIA_RESOURCE_SOURCE_FIELDS.map(key=>[key,row[key]])));
}
function pendingDirectory(cache,create) {
  const outer=directory(cache,create), dir=directory(join(outer.root,'pending-v1'),create);
  directoryUnchanged(outer);return dir;
}
function readPendingJson(dir,name,keys) {
  const file=readPrivateBytes(join(dir.root,name),MAX_MANIFEST_BYTES,undefined),json=file.bytes.toString('utf8');
  validateJsonObjectText(json);const value=JSON.parse(json);
  if(!exactKeys(value,keys))throw new Error('pending_manifest_invalid');
  return {value,info:file.info};
}
function pendingClaim(dir) {
  const claim=readPendingJson(dir,'claim.json',claimKeys);
  if(claim.value.schema!=='lark_media_pending_claim/v1'||!validGeneration(claim.value.generation)||!validTime(claim.value.created_at_ms))
    throw new Error('pending_claim_invalid');
  return claim;
}
function pendingManifest(dir) {
  const claim=pendingClaim(dir), file=readPendingJson(dir,'manifest.json',pendingKeys),m=file.value;
  if(m.schema!=='lark_media_pending/v1'||m.generation!==claim.value.generation||m.created_at_ms!==claim.value.created_at_ms
    ||!hashValid(m.source_fence)||!hashValid(m.sha256)||!Number.isSafeInteger(m.size_bytes)||m.size_bytes<1||m.size_bytes>MAX_MEDIA_RESOURCE_BYTES
    ||!validTime(m.opening_at_ms)||m.opening_at_ms>m.created_at_ms||!validTime(m.expires_at_ms)||m.expires_at_ms-m.created_at_ms!==MEDIA_PENDING_TTL_MS
    ||!(m.original_closing_at_ms===null||validTime(m.original_closing_at_ms)&&m.original_closing_at_ms>=m.opening_at_ms&&m.original_closing_at_ms<=m.created_at_ms)
    ||!resumableStops.has(m.stop_reason))throw new Error('pending_manifest_invalid');
  fileUnchanged(join(dir.root,'claim.json'),claim.info);directoryUnchanged(dir);
  return {...file,claim};
}
// A private, nonblocking file lock serializes only local slot mutation/GC.
// flock is on the inherited open-file description, retained by this Node fd;
// process death releases it. This is unrelated to the API admission lease.
function withPendingMutation(cache,callback) {
  let fd;
  try {
    const dir=pendingDirectory(cache,true),path=join(dir.root,'.mutation.lock');
    fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    const info=fstatSync(fd,{bigint:true});
    if(!info.isFile()||info.nlink!==1n||!privateOwned(info)||info.size!==0n)throw new Error('pending_lock_invalid');
    const lock=spawnSync('python3',['-B','-c','import fcntl,sys\ntry: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)'],
      {stdio:['ignore','ignore','ignore',fd],timeout:1000});
    if(lock.status===73)return finite('blocked','resource_pending_busy');
    if(lock.status!==0||lock.error)throw new Error('pending_lock_failed');
    fileUnchanged(path,info);directoryUnchanged(dir);
    const result=callback(dir);
    fileUnchanged(path,info);directoryUnchanged(dir);return result;
  }catch{return finite('invalid','resource_pending_invalid');}
  finally{if(fd!==undefined)closeSync(fd);}
}
const pendingStatKeys=['dev','ino','size','mtimeNs','ctimeNs','mode','uid','nlink'];
const pendingStat=info=>Object.fromEntries(pendingStatKeys.map(key=>[key,String(info[key])]));
function capturePendingSlot(parent,slot) {
  const dir=directory(join(parent.root,slot),false),names=readdirSync(dir.root).sort();
  /** @type {JsonObject[]} */ const files=names.map(name=>{
    if(!['claim.json','manifest.json','payload.blob'].includes(name))throw new Error('pending_unknown_file');
    const info=lstatSync(join(dir.root,name),{bigint:true});
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||!privateOwned(info)||info.size>BigInt(MAX_MEDIA_RESOURCE_BYTES))throw new Error('pending_unsafe_file');
    return {name,...pendingStat(info)};
  });
  directoryUnchanged(dir);
  return {dir,receipt:{slot,dev:String(dir.info.dev),ino:String(dir.info.ino),files}};
}
function removePendingSlot(parent,expected) {
  const current=capturePendingSlot(parent,expected.slot),dir=current.dir;
  if(JSON.stringify(current.receipt)!==JSON.stringify(expected))throw new Error('pending_replaced');
  for(const file of expected.files){
    const path=join(dir.root,file.name),info=lstatSync(path,{bigint:true});
    if(JSON.stringify({name:file.name,...pendingStat(info)})!==JSON.stringify(file))throw new Error('pending_replaced');
    directoryUnchanged(dir);unlinkSync(path);
  }
  directoryUnchanged(dir);rmdirSync(dir.root);directoryUnchanged(parent);
}
// No link/unlink publication window: an interrupted exclusive write is merely
// incomplete pending data. Never used for available-resource publication.
function writePendingFile(dir,name,bytes) {
  let fd;const path=join(dir.root,name);
  try{directoryUnchanged(dir);fd=openSync(path,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}
  finally{if(fd!==undefined)closeSync(fd);}
  directoryUnchanged(dir);
}
function reclaimExpiredPending(parent,nowMs,deps={}) {
  for(const slot of slots) {
    let captured;
    try{captured=capturePendingSlot(parent,slot);}catch(error){if(errorCode(error)==='ENOENT')continue;throw error;}
    const {dir,receipt}=captured;let created;
    try{
      const claim=pendingClaim(dir);created=claim.value.created_at_ms;
      if(JSON.stringify({name:'claim.json',...pendingStat(claim.info)})!==JSON.stringify(receipt.files.find(file=>file.name==='claim.json')))
        throw new Error('pending_replaced');
    }catch(error){
      if(error instanceof Error&&error.message==='pending_replaced'||receipt.files.some(file=>['payload.blob','manifest.json'].includes(file.name)))throw error;
      // An incomplete first claim has no trustworthy logical time. Its entire
      // known private file set must age for an hour by filesystem timestamps.
      created=Math.max(Number(dir.info.birthtimeMs),...receipt.files.flatMap(file=>[Number(file.mtimeNs)/1e6,Number(file.ctimeNs)/1e6]));
    }
    if(!Number.isFinite(created)||created<0||created>nowMs)throw new Error('pending_clock_invalid');
    if(nowMs-created>=MEDIA_PENDING_TTL_MS){deps.beforeReclaim?.();removePendingSlot(parent,receipt);}
  }
}
/** Explicit apply only. Reads/messages never initialize or prune this cache. */
export function reclaimPendingMediaResources(cache,options={},deps={}) {
  const nowMs=options.nowMs??Date.now();if(!validTime(nowMs))return finite('invalid','resource_pending_invalid');
  try{pendingDirectory(cache,false);}catch(error){return errorCode(error)==='ENOENT'?finite('ready',null):finite('invalid','resource_pending_invalid');}
  return withPendingMutation(cache,parent=>{reclaimExpiredPending(parent,nowMs,deps);return finite('ready',null);});
}

/** Read-only; exact original binding and source fence, including row ID. */
export function readPendingMediaResource(cache,binding,sourceFence,options={},deps={}) {
  try {
    const nowMs=options.nowMs??Date.now(),normalized=normalizedBinding(binding);
    if(!validTime(nowMs)||!hashValid(sourceFence))throw new Error('pending_context_invalid');
    let parent;
    try{parent=pendingDirectory(cache,false);}catch(error){if(errorCode(error)==='ENOENT')return finite('missing','resource_pending_missing');throw error;}
    let found=null;
    for(const slot of slots) {
      let dir,document;
      try{dir=directory(join(parent.root,slot),false);document=pendingManifest(dir);}
      catch(error){
        if(errorCode(error)==='ENOENT'){
          if(dir && readdirSync(dir.root).includes('manifest.json'))throw new Error('pending_incomplete_manifest');
          continue;
        }throw error;
      }
      const m=document.value;
      if(m.created_at_ms>nowMs)throw new Error('pending_clock_invalid');
      if(m.expires_at_ms<=nowMs||m.source_fence!==sourceFence||JSON.stringify(m.binding)!==JSON.stringify(normalized))continue;
      const file=readPrivateBytes(join(dir.root,'payload.blob'),MAX_MEDIA_RESOURCE_BYTES,deps.afterBlobRead),image=assessMediaImageBytes(file.bytes).image;
      if(file.bytes.length!==m.size_bytes||sha(file.bytes)!==m.sha256||!image||image.mime_type!==m.mime_type)throw new Error('pending_payload_invalid');
      fileUnchanged(join(dir.root,'manifest.json'),document.info);fileUnchanged(join(dir.root,'payload.blob'),file.info);
      directoryUnchanged(dir);directoryUnchanged(parent);normalizedBinding(binding);
      const captured=capturePendingSlot(parent,slot);
      if(!sameDirectory(dir.info,captured.dir.info)||[["claim.json",document.claim.info],["manifest.json",document.info],["payload.blob",file.info]].some(([name,info])=>
        JSON.stringify({name,...pendingStat(info)})!==JSON.stringify(captured.receipt.files.find(entry=>entry.name===name))))throw new Error('pending_replaced');
      const current={status:m.original_closing_at_ms===null?'quarantined':'pending',reason:m.original_closing_at_ms===null?'resource_pending_account_unverified':null,
        bytes:file.bytes,opening_at_ms:m.opening_at_ms,original_closing_at_ms:m.original_closing_at_ms,created_at_ms:m.created_at_ms,
        read_observed_at_ms:nowMs,expires_at_ms:m.expires_at_ms,
        receipt:{...captured.receipt,generation:m.generation,manifest_sha256:sha(JSON.stringify(m))}};
      if(found && (!found.bytes.equals(current.bytes)||found.original_closing_at_ms!==current.original_closing_at_ms))throw new Error('pending_conflict');
      if(!found||current.expires_at_ms<found.expires_at_ms)found=current;
    }
    return found??finite('missing','resource_pending_missing');
  }catch{return finite('invalid','resource_pending_invalid');}
}

/** Persist validated bytes without any available-resource publication. */
export function retainPendingMediaResource(cache,binding,sourceFence,bytes,options,deps={}) {
  try {
    const normalized=normalizedBinding(binding),image=assessMediaImageBytes(bytes).image;
    const {nowMs=Date.now(),openingAtMs,originalClosingAtMs=null,stopReason,freshDownload=false}=options;
    if(!image||!hashValid(sourceFence)||!validTime(nowMs)||!validTime(openingAtMs)||openingAtMs>nowMs
      ||!(originalClosingAtMs===null||validTime(originalClosingAtMs)&&originalClosingAtMs>=openingAtMs&&originalClosingAtMs<=nowMs)
      ||!resumableStops.has(stopReason)||!validTime(nowMs+MEDIA_PENDING_TTL_MS))return finite('invalid','resource_pending_invalid');
    return withPendingMutation(cache,parent=>{
      reclaimExpiredPending(parent,nowMs,deps);
      const existing=readPendingMediaResource(cache,binding,sourceFence,{nowMs});
      if(['pending','quarantined'].includes(existing.status)) {
        if(!existing.bytes.equals(bytes))return finite('invalid','resource_pending_conflict');
        if(!(existing.status==='quarantined'&&freshDownload===true&&originalClosingAtMs!==null))return existing;
        // This is a newly downloaded operation with its own closing proof,
        // never an upgrade from a later profile over the old quarantined bytes.
        const {slot,dev,ino,files}=existing.receipt;deps.beforeReplace?.();
        removePendingSlot(parent,{slot,dev,ino,files});
      } else if(existing.status!=='missing')return existing;
      const slot=slots.find(name=>{try{lstatSync(join(parent.root,name));return false;}catch(error){if(errorCode(error)==='ENOENT')return true;throw error;}});
      if(!slot)return finite('blocked','resource_pending_capacity');
      mkdirSync(join(parent.root,slot),{mode:0o700});const dir=directory(join(parent.root,slot),false),generation=randomUUID();
      writePendingFile(dir,'claim.json',Buffer.from(JSON.stringify({schema:'lark_media_pending_claim/v1',generation,created_at_ms:nowMs})+'\n'));
      writePendingFile(dir,'payload.blob',bytes);normalizedBinding(binding);
      const manifest={schema:'lark_media_pending/v1',generation,binding:normalized,source_fence:sourceFence,sha256:sha(bytes),size_bytes:bytes.length,
        mime_type:image.mime_type,opening_at_ms:openingAtMs,original_closing_at_ms:originalClosingAtMs,created_at_ms:nowMs,
        expires_at_ms:nowMs+MEDIA_PENDING_TTL_MS,stop_reason:stopReason};
      writePendingFile(dir,'manifest.json',Buffer.from(JSON.stringify(manifest)+'\n'));
      return readPendingMediaResource(cache,binding,sourceFence,{nowMs});
    });
  }catch{return finite('invalid','resource_pending_invalid');}
}
/** Delete only a consumed exact generation; no replacement or arbitrary path. */
export function discardPendingMediaResource(cache,receipt) {
  if(!exactKeys(receipt,['slot','dev','ino','files','generation','manifest_sha256'])||!slots.includes(receipt.slot)||!validGeneration(receipt.generation)||!hashValid(receipt.manifest_sha256))
    return finite('invalid','resource_pending_invalid');
  return withPendingMutation(cache,parent=>{
    const dir=directory(join(parent.root,receipt.slot),false),document=pendingManifest(dir);
    if(document.value.generation!==receipt.generation||sha(JSON.stringify(document.value))!==receipt.manifest_sha256)throw new Error('pending_replaced');
    const {slot,dev,ino,files}=receipt;removePendingSlot(parent,{slot,dev,ino,files});return finite('removed',null);
  });
}
