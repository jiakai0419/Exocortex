import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { renderCardContent } from "../src/adapters/lark-im/card-content.mjs";

// Entirely generated adversarial text; no captured messages or production data.
const moduleUrl = new URL("../src/adapters/lark-im/card-content.mjs", import.meta.url).href;
const plainCard = (content) => ({ elements: [{ tag: "plain_text", content }] });

function boundedChild(program) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", `
    import {renderCardContent} from ${JSON.stringify(moduleUrl)};
    const start = performance.now();
    ${program}
    process.stdout.write(JSON.stringify({
      ...evidence, status: rendered.status, reason: rendered.reason,
      outputChars: rendered.text.length, elapsedMs: performance.now() - start,
      heapUsed: process.memoryUsage().heapUsed, maxRssKb: process.resourceUsage().maxRSS,
    }));
  `], { encoding: "utf8", timeout: 4000, maxBuffer: 16_384 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.ok(evidence.outputChars <= 16_000, JSON.stringify(evidence));
  assert.ok(evidence.heapUsed < 64 * 1024 * 1024, JSON.stringify(evidence));
  assert.ok(evidence.maxRssKb < 128 * 1024, JSON.stringify(evidence));
  return evidence;
}

test("245000 repeated OSC openers finish within four seconds and a 64 MiB child heap", (t) => {
  const evidence = boundedChild(`
    const source = JSON.stringify({elements:[{tag:'plain_text',content:'\u009d'.repeat(245000)}]});
    if(source.length >= 256 * 1024) throw new Error('fixture must remain below the input limit');
    const rendered = renderCardContent(source);
    if(rendered.text.includes('\u009d')) throw new Error('OSC opener escaped sanitization');
    const evidence = {inputChars:source.length,oscOpeners:245000};
  `);
  assert.equal(evidence.oscOpeners, 245_000);
  assert.ok(evidence.inputChars < 256 * 1024);
  assert.equal(evidence.status, "structured_fallback");
  assert.equal(evidence.reason, "card_no_visible_content");
  t.diagnostic(JSON.stringify(evidence));
});

test("10000 mentions of a 16384-character name never allocate the full expansion", (t) => {
  const evidence = boundedChild(`
    const name = 'n'.repeat(16384);
    const source = {elements:[{tag:'plain_text',content:'@_user_1 '.repeat(10000)}]};
    const mentions = [{key:'@_user_1',id:{open_id:'ou_generated_resource_person'},name}];
    const inputChars = JSON.stringify({source,mentions}).length;
    if(inputChars >= 110000) throw new Error('fixture must remain near the original 106k input size');
    const rendered = renderCardContent(source,mentions);
    if(!rendered.text.startsWith('@nnn')) throw new Error('known visible prefix was lost');
    const evidence = {inputChars,mentionCount:10000,nameChars:name.length};
  `);
  assert.equal(evidence.mentionCount, 10_000);
  assert.equal(evidence.nameChars, 16_384);
  assert.ok(evidence.inputChars < 110_000);
  assert.equal(evidence.status, "partial");
  assert.equal(evidence.reason, "card_output_limit");
  t.diagnostic(JSON.stringify(evidence));
});

test("linear control scanning preserves lines and strips complete ANSI, OSC and bidi sequences", () => {
  const source = "first\r\nred\u001b[31m text\u001b[0m\u202e\n" +
    "before\u001b]8;;https://example.invalid/HIDDEN_OSC\u001b\\after\n" +
    "c1\u009d52;c;HIDDEN_C1\u009cvisible\n" +
    "bel\u001b]52;c;HIDDEN_BEL\u0007visible\n" +
    "dcs\u001bPHIDDEN_DCS\u001b\\visible\n" +
    "space\u0000\tend\u2028last";
  // Preserve the original mixed control/URL fixture. Even a hidden URL can
  // straddle a removed control terminator, so this whole value is ambiguous.
  const ambiguous = renderCardContent(plainCard(source));
  assert.equal(ambiguous.status, "partial");
  assert.equal(ambiguous.reason, "unsupported_card_link");
  assert.doesNotMatch(ambiguous.text, /HIDDEN|https?:|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
  // Controls without link syntax retain the exact multiline prose contract.
  const result = renderCardContent(plainCard(source.replace("https://example.invalid/HIDDEN_OSC", "HIDDEN_OSC")));
  assert.equal(result.text, "first\nred text\nbeforeafter\nc1visible\nbelvisible\ndcsvisible\nspace  end\nlast");
  assert.equal(result.status, "rendered");
  assert.doesNotMatch(result.text, /HIDDEN|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
});

test("unterminated control strings and CSI cannot expose their hidden remaining payload", () => {
  for (const suffix of [
    "\u009dHIDDEN_UNTERMINATED_OSC",
    "\u001b]HIDDEN_UNTERMINATED_ESC_OSC",
    "\u001bPHIDDEN_UNTERMINATED_DCS",
    "\u001b[123456",
    "\u001b[\u001b]HIDDEN_OSC_AFTER_ABORTED_CSI",
  ]) {
    const result = renderCardContent(plainCard(`Visible prefix${suffix}`));
    assert.equal(result.text, "Visible prefix");
    assert.doesNotMatch(result.text, /HIDDEN|123456/);
  }
});

test("bounded expansion preserves exact raw identity and opaque names containing mention keys", () => {
  const content = '<at id="ou_generated_exact"></at> / <at id="ou_generated_exact\u202e"></at> / @_user_1 / @_user_10';
  const result = renderCardContent(plainCard(content), [
    { key: "@_user_1", id: { open_id: "ou_generated_exact" }, name: "Literal @_user_2 name" },
    { key: "@_user_2", name: "DO_NOT_EXPAND_INSERTED_NAME" },
  ]);
  assert.match(result.text, /@Literal @_user_2 name \/ @未知用户 \/ @Literal @_user_2 name \/ @未知用户/);
  assert.doesNotMatch(result.text, /DO_NOT_EXPAND_INSERTED_NAME|name0/);
  assert.equal(result.status, "partial");
  assert.equal(result.reason, "unresolved_card_mention");
});

test("repeated names retain URL sanitization while sharing their cached safe projection", () => {
  const result = renderCardContent(plainCard("@_user_1 / @_user_1 / @_user_3"), [
    { key: "@_user_1", name: "Name https://user:GENERATED_PASSWORD@example.invalid/profile?token=GENERATED_TOKEN#GENERATED_FRAGMENT" },
    { key: "@_user_3", name: "Name https://user:GENERATED_PASSWORD@example.invalid/profile?token=GENERATED_TOKEN#GENERATED_FRAGMENT" },
  ]);
  assert.equal(result.status, "rendered");
  assert.equal(result.text.match(/@Name https:\/\/example\.invalid\/profile/g).length, 3);
  assert.doesNotMatch(result.text, /GENERATED_PASSWORD|GENERATED_TOKEN|GENERATED_FRAGMENT|user:/);
});
