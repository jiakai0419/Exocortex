import assert from "node:assert/strict";
import test from "node:test";
import { textWidth, terminalColumns, wrapTextLine, wrapLabelValue } from "../src/terminal/text-layout.mjs";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const segments = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);

test("plain cell geometry and terminal fallback are independent of styling and business dependencies", () => {
  assert.equal(textWidth("状态e\u0301👨‍👩‍👧‍👦🇯🇵1️⃣"), 11);
  for (const [stream, columns, expected] of [[undefined, undefined, 80], [{ columns: 40 }, undefined, 40],
    [{ columns: 40 }, 96, 96], [{ columns: Infinity }, undefined, 80], [{ columns: Number.MAX_SAFE_INTEGER + 1 }, undefined, 80],
    [{ columns: 7 }, undefined, 20]]) {
    assert.equal(terminalColumns(stream, columns), expected);
  }
});

for (const width of [1, 2, 7, 20, 40, 80]) test(`preserved wrapping at ${width} cells loses no character or grapheme`, () => {
  for (const text of ["", "  alpha   beta  gamma ", "a".repeat(43) + " next", "状态e\u0301👨‍👩‍👧‍👦🇯🇵1️⃣".repeat(4),
    "A \u0301B \u0301C", " \u0301".repeat(12), "literal  ---  `code`   end"]) {
    const lines = wrapTextLine(text, width, { preserveWhitespace: true });
    assert.equal(lines.join(""), text);
    assert.deepEqual(lines.flatMap(segments), segments(text));
    for (const line of lines) assert.ok(textWidth(line) <= width || segments(line).length === 1, JSON.stringify(line));
  }
});

test("URL preservation keeps a whole copyable token with surrounding source whitespace", () => {
  const url = "https://example.invalid/invented-long-path/receipt?key=value";
  for (const text of [`Read ${url} now`, `  ${url}  `, `Open (${url}) or wait`, `前文 ${url} 后文`]) {
    const lines = wrapTextLine(text, 20, { preserveWhitespace: true, preserveUrls: true });
    assert.equal(lines.join(""), text);
    assert.equal(lines.filter((line) => line.includes(url)).length, 1);
    assert.ok(lines.every((line) => textWidth(line) <= 20 || line.includes(url)));
  }
});

test("normal prose keeps every word and uses hanging or stacked labels", () => {
  const input = "alpha beta gamma delta epsilon zeta";
  for (const width of [20, 40, 80]) {
    const lines = wrapTextLine(input, width);
    assert.equal(lines.join(" "), input);
    assert.ok(lines.every((line) => textWidth(line) <= width));
  }
  assert.deepEqual(wrapLabelValue("State:", "Ready", 40, { gap: " " }), ["State: Ready"]);
  assert.deepEqual(wrapLabelValue("State:", "alpha beta gamma delta epsilon", 20, { gap: " " }),
    ["State: alpha beta", "       gamma delta", "       epsilon"]);
  const stacked = wrapLabelValue("Observation details:", input, 40, { gap: " " });
  assert.equal(stacked[0], "Observation details:");
  assert.ok(stacked.slice(1).every((line) => line.startsWith("  ")));
});

test("invalid wrapping widths fail explicitly", () => {
  for (const width of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => wrapTextLine("text", width), RangeError);
});
