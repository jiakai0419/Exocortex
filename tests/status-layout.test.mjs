import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { plain } from "../dist/terminal/index.js";
import { statusLayout, statusWidth, wrapStatus } from "../src/terminal/status-layout.mjs";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const segments = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);
const stream = new Writable({ write(_chunk, _encoding, done) { done(); } });

for (const [name, value, width] of [
  ["empty", "", 0],
  ["ASCII", "Status 42", 9],
  ["CJK", "状态日本語", 10],
  ["fullwidth Latin", "ＡＢＣ", 6],
  ["supplementary CJK", "𠀀", 2],
  ["Hangul", "한글", 4],
  ["decomposed Hangul", "가", 2],
  ["combining acute", "e\u0301", 1],
  ["multiple combining marks", "a\u0301\u0327", 1],
  ["standalone combining mark", "\u0301", 0],
  ["text heart", "❤", 1],
  ["VS16 heart", "❤️", 2],
  ["text sun", "☀", 1],
  ["VS16 sun", "☀️", 2],
  ["VS16 copyright", "©️", 2],
  ["VS15 heart", "❤︎", 1],
  ["VS15 sun", "☀︎", 1],
  ["VS16 on non-emoji letter", "A\uFE0F", 1],
  ["default emoji", "😀⏰", 4],
  ["ZWJ family", "👨‍👩‍👧‍👦", 2],
  ["ZWJ profession and skin tone", "👩🏽‍💻", 2],
  ["ZWJ rainbow flag", "🏳️‍🌈", 2],
  ["ZWJ heart on fire", "❤️‍🔥", 2],
  ["regional flag", "🇺🇸", 2],
  ["adjacent regional flags", "🇯🇵🇬🇧", 4],
  ["digit keycap", "1️⃣", 2],
  ["hash keycap", "#️⃣", 2],
  ["keycap without VS16", "*\u20E3", 2],
  ["skin tone", "👍🏿", 2],
  ["second skin tone", "👋🏻", 2],
  ["ordinary keycap characters", "1#*", 3],
  ["ambiguous characters use narrow cells", "·Ωé", 3],
  ["default ignorable code points", "a\u200Bb\u2060c", 3],
  ["sanitized ANSI", "\u001b[31m❤️\u001b[0m", 2],
]) {
  test(`status cell width: ${name}`, () => assert.equal(statusWidth(value), width));
}

test("emoji tag flag is one two-cell grapheme", () => {
  const flag = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
  assert.equal(statusWidth(flag), 2);
  assert.deepEqual(wrapStatus(`${flag}${flag}`, 2), [flag, flag]);
});

for (const [value, width, expected] of [
  ["alpha beta gamma", 10, ["alpha beta", "gamma"]],
  ["状态正常", 4, ["状态", "正常"]],
  ["e\u0301e\u0301e\u0301", 2, ["e\u0301e\u0301", "e\u0301"]],
  ["a❤️b", 3, ["a❤️", "b"]],
  ["☀️☀️☀️", 4, ["☀️☀️", "☀️"]],
  ["👨‍👩‍👧‍👦👩🏽‍💻", 2, ["👨‍👩‍👧‍👦", "👩🏽‍💻"]],
  ["🇺🇸🇯🇵🇬🇧", 4, ["🇺🇸🇯🇵", "🇬🇧"]],
  ["1️⃣#️⃣*\u20E3", 4, ["1️⃣#️⃣", "*\u20E3"]],
  ["👍🏿👋🏻", 2, ["👍🏿", "👋🏻"]],
  ["A \u0301B", 2, ["A \u0301", "B"]],
  ["   alpha\t beta\n gamma   ", 10, ["alpha beta", "gamma"]],
]) {
  test(`wraps complete graphemes at ${width} cells: ${JSON.stringify(value)}`, () => {
    const lines = wrapStatus(value, width);
    assert.deepEqual(lines, expected);
    for (const line of lines) assert.ok(statusWidth(line) <= width, line);
  });
}

test("long unbroken Unicode logs retain every grapheme and fit all status widths", () => {
  const input = "abc状态e\u0301❤️☀️👨‍👩‍👧‍👦👩🏽‍💻🇺🇸1️⃣👍🏿".repeat(9);
  const original = segments(input);
  for (const width of [2, 3, 16, 36, 40, 56, 80, 96]) {
    const lines = wrapStatus(input, width);
    assert.equal(lines.join(""), input);
    assert.deepEqual(lines.flatMap(segments), original, `graphemes split at width ${width}`);
    for (const line of lines) assert.ok(statusWidth(line) <= width, `${width}: ${line}`);
  }
});

test("one too-wide grapheme is preserved intact rather than broken or clipped", () => {
  assert.deepEqual(wrapStatus("❤️a", 1), ["❤️", "a"]);
  assert.deepEqual(wrapStatus("中a", 1), ["中", "a"]);
});

test("empty text stays representable and invalid wrap widths are rejected", () => {
  assert.deepEqual(wrapStatus("", 10), [""]);
  assert.deepEqual(wrapStatus("   ", 10), [""]);
  for (const width of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => wrapStatus("example", width), /positive safe integer/);
  }
});

test("sanitization occurs before grapheme wrapping and cannot inject terminal commands", () => {
  const input = "\u001b]52;c;INVENTED_CLIPBOARD\u0007a\u001b[2J❤️\u202e☀️";
  const lines = wrapStatus(input, 3);
  assert.deepEqual(lines, ["a❤️", "☀️"]);
  assert.doesNotMatch(lines.join(""), /\u001b|\u202e|INVENTED_CLIPBOARD/);
});

test("whole layout aligns wide labels and wraps arbitrary private log graphemes", () => {
  const log = "状态❤️☀️👨‍👩‍👧‍👦👩🏽‍💻🇺🇸1️⃣👍🏿e\u0301".repeat(8);
  for (const columns of [40, 56, 80, 96]) {
    const screen = statusLayout({ columns, stream });
    screen.title("Exocortex status");
    screen.heading("Private logs");
    screen.row("状态❤️", log);
    screen.row("Plain", "value");
    const output = plain(screen.finish());
    for (const line of output.split("\n")) assert.ok(statusWidth(line) <= columns, `${columns}: ${line}`);
    const valueLines = output.split("\n").filter((line) => line.includes("状态❤️") || /☀|👨|👩|🇺|1|👍|e\u0301/.test(line));
    assert.ok(valueLines.length > 1);
    assert.equal((output.match(/❤️/g) || []).length, 9, "label and every log heart survive");
    if (columns >= 64) {
      const labeled = output.split("\n").find((line) => line.startsWith("  状态❤️"));
      const plainRow = output.split("\n").find((line) => line.startsWith("  Plain"));
      assert.equal(statusWidth(labeled.slice(0, labeled.indexOf(log.slice(0, 4), 2 + "状态❤️".length))), 25);
      assert.equal(statusWidth(plainRow.slice(0, plainRow.indexOf("value"))), 25);
    }
  }
});
