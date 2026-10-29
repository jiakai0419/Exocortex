import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, accessSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Every input is authored here or encoded from authored PGM/PPM pixels. No real
// message, image, account, source resource, network or production file is read.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredPrefix = process.env.EXOCORTEX_LIBJPEG_PREFIX;
const prefixes = configuredPrefix ? [configuredPrefix] : [
  '/opt/homebrew/opt/jpeg-turbo', '/usr/local/opt/jpeg-turbo', '/usr/local', '/usr',
];
const prefix = prefixes.find(candidate => ['cjpeg', 'jpegtran'].every(name => existsSync(join(candidate, 'bin', name))));
const helper = process.env.EXOCORTEX_JPEG_VALIDATOR ?? join(repository, 'build', 'native', 'jpeg-validator');
const exitCodes = { valid: 0, invalid: 10, unsupported: 11, limit: 12, internal: 13 };
const inputLimit = 16 * 1024 * 1024;

function dependencyCheck() {
  assert.ok(prefix, 'Strict JPEG integration requires cjpeg/jpegtran: set EXOCORTEX_LIBJPEG_PREFIX to one installed libjpeg-turbo prefix.');
  assert.ok(isAbsolute(helper), 'EXOCORTEX_JPEG_VALIDATOR must be an absolute path.');
  assert.ok(existsSync(helper), 'Strict JPEG helper is missing: build build/native/jpeg-validator with the documented libjpeg prefix before running the complete test gate.');
  accessSync(helper, constants.X_OK);
  for (const name of ['cjpeg', 'jpegtran']) accessSync(join(prefix, 'bin', name), constants.X_OK);
}

function authoredPixels({ width = 64, height = 64, gray = false, phase = 0 } = {}) {
  const channels = gray ? 1 : 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * channels;
    pixels[at] = (x * 17 + y * 31 + phase) & 255;
    if (!gray) { pixels[at + 1] = (x * 67 + y * 13 + phase * 3) & 255; pixels[at + 2] = (x * 7 + y * 97 + phase * 5) & 255; }
  }
  return Buffer.concat([Buffer.from(`${gray ? 'P5' : 'P6'}\n${width} ${height}\n255\n`), pixels]);
}

function tool(name, args, input) {
  const result = spawnSync(join(prefix, 'bin', name), args, { input, maxBuffer: inputLimit, timeout: 10000, killSignal: 'SIGKILL' });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${name} did not finish normally`);
  assert.equal(result.status, 0, `${name} failed while generating synthetic data: ${result.stderr.toString('utf8')}`);
  return result.stdout;
}

function encode(options = {}, args = []) {
  return tool('cjpeg', ['-quality', '81', ...(options.gray ? ['-grayscale'] : []), ...args], authoredPixels(options));
}

function validate(bytes, expected, dimensions) {
  const result = spawnSync(helper, [], { input: bytes, encoding: 'utf8', maxBuffer: 4096, timeout: 6000, killSignal: 'SIGKILL' });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'validator must return its finite protocol before the outer timeout');
  assert.equal(result.status, exitCodes[expected], `unexpected validator exit for ${expected}: ${result.stdout}`);
  assert.equal(result.stderr, '', 'native validator must not leak raw decoder diagnostics');
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch { assert.fail('native validator must emit exactly one JSON receipt'); }
  if (expected !== 'valid') {
    assert.deepEqual(receipt, { version: 1, status: expected });
  } else {
    assert.deepEqual(Object.keys(receipt).sort(), ['version', 'status', 'width', 'height', 'scans', 'decoder', 'decoder_version'].sort());
    assert.equal(receipt.version, 1); assert.equal(receipt.status, 'valid'); assert.equal(receipt.decoder, 'libjpeg-turbo');
    assert.match(receipt.decoder_version, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
    assert.equal(receipt.width, dimensions.width); assert.equal(receipt.height, dimensions.height);
    assert.ok(Number.isInteger(receipt.scans) && receipt.scans > 0 && receipt.scans <= 100);
    if (dimensions.scans !== undefined) assert.equal(receipt.scans, dimensions.scans);
  }
  return receipt;
}

// Parse only markers in our encoder-generated fixtures to target controlled
// mutations. This is not a second decoder and does not decide input validity.
function structure(bytes) {
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  const segments = [], scans = [], restarts = [];
  let at = 2;
  while (at < bytes.length) {
    assert.equal(bytes[at], 0xff, 'synthetic marker boundary');
    const start = at++;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xd9) { segments.push({ marker, start, end: at }); break; }
    const size = bytes.readUInt16BE(at), end = at + size;
    assert.ok(size >= 2 && end <= bytes.length);
    const segment = { marker, start, payload: at + 2, end };
    segments.push(segment); at = end;
    if (marker !== 0xda) continue;
    const scan = { ...segment, entropyStart: at, entropyEnd: at };
    while (at < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const next = bytes[at + 1];
      if (next === 0x00) { at += 2; continue; }
      if (next >= 0xd0 && next <= 0xd7) { restarts.push(at); at += 2; continue; }
      if (next === 0xff) { at++; continue; }
      break;
    }
    scan.entropyEnd = at; scans.push(scan);
  }
  return { segments, scans, restarts, frame: segments.find(item => [0xc0, 0xc1, 0xc2, 0xc3, 0xc9].includes(item.marker)) };
}

function omitSegments(bytes, marker) {
  const discarded = structure(bytes).segments.filter(item => item.marker === marker);
  assert.ok(discarded.length > 0, 'controlled mutation must remove a real segment');
  const parts = []; let at = 0;
  for (const segment of discarded) { parts.push(bytes.subarray(at, segment.start)); at = segment.end; }
  parts.push(bytes.subarray(at)); return Buffer.concat(parts);
}

function individualTables(bytes, marker) {
  const tables = [];
  for (const segment of structure(bytes).segments.filter(item => item.marker === marker)) {
    let at = segment.payload;
    while (at < segment.end) {
      const start = at, identifier = bytes[at++];
      if (marker === 0xc4) {
        let symbols = 0; for (let i = 0; i < 16; i++) symbols += bytes[at++];
        at += symbols;
      } else { assert.equal(marker, 0xdb); at += 64 * ((identifier >> 4) + 1); }
      assert.ok(at <= segment.end, 'encoder-generated table bounds');
      tables.push({ segment, start, end: at, identifier });
    }
  }
  return tables;
}

function omitTable(bytes, table) {
  const { segment } = table;
  const body = Buffer.concat([bytes.subarray(segment.payload, table.start), bytes.subarray(table.end, segment.end)]);
  if (!body.length) return Buffer.concat([bytes.subarray(0, segment.start), bytes.subarray(segment.end)]);
  const marker = Buffer.from([0xff, segment.marker, 0, 0]); marker.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([bytes.subarray(0, segment.start), marker, body, bytes.subarray(segment.end)]);
}

function atBoundary(bytes, scan) { return Buffer.concat([bytes.subarray(0, scan.entropyEnd), Buffer.from([0xff, 0xd9])]); }

test('strict libjpeg helper integration: synthetic complete inputs and adversarial boundaries', async t => {
  dependencyCheck();
  const root = mkdtempSync(join(tmpdir(), 'synthetic-jpeg-validator-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gray = encode({ gray: true }), rgb = encode({}, ['-rgb', '-sample', '1x1,1x1,1x1']);
  const progressive = encode({ width: 63, height: 47 }, ['-progressive']);
  const grayLayout = structure(gray), progressiveLayout = structure(progressive);
  assert.equal(grayLayout.scans.length, 1); assert.ok(progressiveLayout.scans.length > 1);

  await t.test('complete 8-bit grayscale consumes all output rows', () => validate(gray, 'valid', { width: 64, height: 64, scans: 1 }));
  await t.test('complete direct RGB single scan is supported', () => validate(rgb, 'valid', { width: 64, height: 64, scans: 1 }));
  await t.test('subsampled YCbCr with partial MCU edges is supported', () => {
    validate(encode({ width: 31, height: 27 }, ['-sample', '2x2,1x1,1x1']), 'valid', { width: 31, height: 27, scans: 1 });
  });
  await t.test('complete progressive RGB/YCbCr reaches every final coefficient', () => {
    validate(progressive, 'valid', { width: 63, height: 47, scans: progressiveLayout.scans.length });
    const direct = encode({ width: 19, height: 17 }, ['-rgb', '-progressive']);
    validate(direct, 'valid', { width: 19, height: 17, scans: structure(direct).scans.length });
  });
  await t.test('complete progressive grayscale is supported', () => {
    const bytes = encode({ gray: true, width: 17, height: 13 }, ['-progressive']);
    validate(bytes, 'valid', { width: 17, height: 13, scans: structure(bytes).scans.length });
  });
  await t.test('valid restart-coded input decodes before restart corruption is tested', () => {
    const bytes = encode({ width: 96, height: 80 }, ['-restart', '1B', '-sample', '1x1,1x1,1x1']);
    const layout = structure(bytes); assert.ok(layout.restarts.length > 2);
    validate(bytes, 'valid', { width: 96, height: 80, scans: 1 });
    const wrong = Buffer.from(bytes); wrong[layout.restarts[0] + 1] = 0xd4;
    validate(wrong, 'invalid');
    validate(Buffer.concat([bytes.subarray(0, layout.restarts[0]), bytes.subarray(layout.restarts[0] + 2)]), 'invalid');
  });
  await t.test('a legal transformed codestream remains valid without implying sender authenticity', () => {
    const flipped = tool('jpegtran', ['-copy', 'none', '-flip', 'horizontal'], rgb);
    assert.notDeepEqual(flipped, rgb, 'lossless transform must alter this asymmetric authored image');
    validate(flipped, 'valid', { width: 64, height: 64, scans: 1 });
    validate(rgb, 'valid', { width: 64, height: 64, scans: 1 });
  });
  await t.test('truncated header, entropy and physical EOI fail rather than receiving synthetic EOI', () => {
    validate(gray.subarray(0, grayLayout.frame.start + 8), 'invalid');
    const scan = grayLayout.scans[0], cut = scan.entropyStart + Math.floor((scan.entropyEnd - scan.entropyStart) / 2);
    validate(gray.subarray(0, cut), 'invalid');
    validate(gray.subarray(0, gray.length - 2), 'invalid');
    validate(Buffer.alloc(0), 'invalid');
  });
  await t.test('28-byte JPEG shell without tables or complete entropy is invalid', () => {
    validate(Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex'), 'invalid');
  });
  await t.test('missing quantization or Huffman tables cannot decode', () => {
    validate(omitSegments(gray, 0xdb), 'invalid'); validate(omitSegments(gray, 0xc4), 'invalid');
  });
  await t.test('every referenced DC/AC Huffman and quantization table must be present', async t => {
    const bytes = encode({}), huffman = individualTables(bytes, 0xc4), quantization = individualTables(bytes, 0xdb);
    assert.deepEqual(huffman.map(table => table.identifier).sort((a, b) => a - b), [0, 1, 16, 17]);
    assert.deepEqual(quantization.map(table => table.identifier).sort((a, b) => a - b), [0, 1]);
    for (const table of huffman) await t.test(`missing Huffman ${table.identifier >> 4 ? 'AC' : 'DC'} table ${table.identifier & 15}`, () => {
      validate(omitTable(bytes, table), 'invalid');
    });
    for (const table of quantization) await t.test(`missing quantization table ${table.identifier}`, () => {
      validate(omitTable(bytes, table), 'invalid');
    });
  });
  await t.test('oversubscribed Huffman table is invalid', () => {
    const bytes = Buffer.from(gray), table = grayLayout.segments.find(item => item.marker === 0xc4);
    assert.ok(table); bytes[table.payload + 1] = 255;
    validate(bytes, 'invalid');
  });
  await t.test('declared extra MCU row cannot be filled with decoder recovery', () => {
    const bytes = Buffer.from(gray); bytes.writeUInt16BE(72, grayLayout.frame.payload + 1);
    validate(bytes, 'invalid');
  });
  await t.test('forged EOI within required entropy is invalid even with an exact physical end', () => {
    const scan = grayLayout.scans[0], cut = scan.entropyStart + Math.floor((scan.entropyEnd - scan.entropyStart) / 2);
    validate(Buffer.concat([gray.subarray(0, cut), Buffer.from([0xff, 0xd9])]), 'invalid');
  });
  await t.test('progressive EOI at complete scan boundaries cannot omit remaining bands or refinement', () => {
    validate(atBoundary(progressive, progressiveLayout.scans[0]), 'unsupported');
    validate(atBoundary(progressive, progressiveLayout.scans.at(-2)), 'unsupported');
    validate(atBoundary(progressive, progressiveLayout.scans.at(-1)), 'valid', { width: 63, height: 47, scans: progressiveLayout.scans.length });
  });
  await t.test('legal reduced-precision progressive input is outside the supported subset', () => {
    const script = join(root, 'reduced-precision.scans');
    writeFileSync(script, '0,1,2: 0 0 0 0;\n0: 1 63 0 1;\n1: 1 63 0 1;\n2: 1 63 0 1;\n');
    validate(encode({}, ['-scans', script]), 'unsupported');
  });
  await t.test('legal sequential separate-component scans are outside the supported subset', () => {
    const script = join(root, 'separate-components.scans'); writeFileSync(script, '0;\n1;\n2;\n');
    const bytes = encode({}, ['-scans', script]); assert.equal(structure(bytes).scans.length, 3);
    validate(bytes, 'unsupported');
  });
  await t.test('arithmetic, lossless and high-precision profiles stay unsupported', () => {
    validate(encode({}, ['-arithmetic']), 'unsupported');
    validate(encode({}, ['-lossless', '1']), 'unsupported');
    validate(encode({}, ['-precision', '12']), 'unsupported');
  });
  await t.test('trailing bytes and concatenated images are rejected', () => {
    validate(Buffer.concat([gray, Buffer.from([0])]), 'invalid');
    validate(Buffer.concat([gray, gray]), 'invalid');
    validate(Buffer.concat([gray, Buffer.from('SYNTHETIC-NOT-A-RECEIPT')]), 'invalid');
  });
  await t.test('out-of-range segment skip cannot read past the supplied buffer', () => {
    validate(Buffer.from('ffd8ffe1ffff53594e544845544943ffd9', 'hex'), 'invalid');
  });
  await t.test('input and decoded-output budgets fail with a finite limit receipt', () => {
    validate(Buffer.alloc(inputLimit + 1), 'limit');
    const bytes = Buffer.from(gray);
    bytes.writeUInt16BE(4096, grayLayout.frame.payload + 1); bytes.writeUInt16BE(4097, grayLayout.frame.payload + 3);
    validate(bytes, 'limit');
    const maximum = Buffer.from(gray);
    maximum.writeUInt16BE(65535, grayLayout.frame.payload + 1); maximum.writeUInt16BE(65535, grayLayout.frame.payload + 3);
    validate(maximum, 'limit');
  });
  await t.test('otherwise complete progressive scan explosion fails the scan budget', () => {
    // cjpeg's script reader itself caps 100 scans. Encode the same coefficients
    // in two legal schedules and append only the final, matching refinement
    // scan (including its encoder-generated DHT) to the 100-scan prefix.
    const prefixScript = join(root, 'hundred-scans.scans'), tailScript = join(root, 'last-refinement.scans');
    const rows = ['0: 0 0 0 0;'];
    for (let coefficient = 1; coefficient <= 63; coefficient++) rows.push(`0: ${coefficient} ${coefficient} 0 ${coefficient <= 37 ? 1 : 0};`);
    for (let coefficient = 1; coefficient <= 36; coefficient++) rows.push(`0: ${coefficient} ${coefficient} 1 0;`);
    assert.equal(rows.length, 100); writeFileSync(prefixScript, rows.join('\n') + '\n');
    writeFileSync(tailScript, '0: 0 0 0 0;\n0: 1 37 0 1;\n0: 38 63 0 0;\n0: 1 36 1 0;\n0: 37 37 1 0;\n');
    const options = { gray: true, width: 16, height: 16 };
    const prefixBytes = encode(options, ['-scans', prefixScript]), tailBytes = encode(options, ['-scans', tailScript]);
    assert.equal(structure(prefixBytes).scans.length, 100);
    validate(prefixBytes, 'unsupported'); // Exactly 100 scans are allowed, but coefficient 37 is still at Al=1.
    const start = structure(tailBytes).scans.at(-2).entropyEnd;
    const bytes = Buffer.concat([prefixBytes.subarray(0, prefixBytes.length - 2), tailBytes.subarray(start)]);
    assert.equal(structure(bytes).scans.length, 101);
    // Independent mature decoding must prove the assembled input is complete;
    // this check prevents a corrupt test fixture from masquerading as a budget test.
    const decoded = tool('jpegtran', ['-strict', '-maxscans', '200', '-copy', 'none'], bytes);
    validate(decoded, 'valid', { width: 16, height: 16, scans: 1 });
    validate(bytes, 'limit');
  });
});
