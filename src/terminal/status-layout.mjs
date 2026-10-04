// @ts-check
import { Writable } from "node:stream";
import { paint, sanitizeTerminalText } from "../../dist/terminal/index.js";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const NONSPACING = /[\p{Mark}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}(?!\uFE0E)/u;
const EMOJI_VARIATION = /\p{Extended_Pictographic}\uFE0F/u;
const EMOJI_JOINED = /\p{Extended_Pictographic}.*\u200D.*\p{Extended_Pictographic}/u;
const EMOJI_KEYCAP = /[0-9#*]\uFE0F?\u20E3/u;

/** @param {string} text */
const graphemes = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);

/** Width model for a single extended grapheme, using the runtime Unicode data.
 * Emoji presentation sequences occupy two cells as a unit, including flags,
 * modifiers, keycaps and ZWJ families. VS15 falls back to text presentation.
 * @param {string} grapheme */
function graphemeWidth(grapheme) {
  if (EMOJI_PRESENTATION.test(grapheme) || EMOJI_VARIATION.test(grapheme)
    || !grapheme.includes("\uFE0E") && EMOJI_JOINED.test(grapheme) || EMOJI_KEYCAP.test(grapheme)) return 2;
  return [...grapheme].reduce((width, char) => {
    const n = char.codePointAt(0) || 0;
    // Decomposed Hangul vowels and trailing consonants share the leading cell.
    if (NONSPACING.test(char) || n >= 0x1160 && n <= 0x11ff || n >= 0xd7b0 && n <= 0xd7ff) return width;
    const wide = n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a ||
      n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f || n >= 0xac00 && n <= 0xd7a3 || n >= 0xf900 && n <= 0xfaff ||
      n >= 0xfe10 && n <= 0xfe19 || n >= 0xfe30 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0xffe0 && n <= 0xffe6 ||
      n >= 0x16fe0 && n <= 0x16fe4 || n >= 0x17000 && n <= 0x18d8f || n >= 0x1b000 && n <= 0x1b2ff ||
      n >= 0x1f200 && n <= 0x1f2ff || n >= 0x20000 && n <= 0x3fffd);
    return width + (wide ? 2 : 1);
  }, 0);
}

/** Estimated cells in sanitized terminal text. Common CJK wide characters use
 * two cells; East Asian ambiguous characters use one. Emoji support, font shaping
 * and a terminal's ambiguous-width setting can differ from this model. Public
 * status terms are ASCII; arbitrary Unicode occurs in explicitly private logs.
 * @param {string} text */
export function statusWidth(text) {
  return graphemes(sanitizeTerminalText(text)).reduce((width, grapheme) => width + graphemeWidth(grapheme), 0);
}

/** Sanitize and normalize whitespace before wrapping. Never split a grapheme or
 * truncate facts to fit. A grapheme wider than the requested width is preserved
 * on its own line; normal status rows have at least 16 cells available.
 * @param {unknown} value @param {number} width */
export function wrapStatus(value, width) {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("status wrap width must be a positive safe integer");
  const text = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  /** @type {string[][]} */ const words = [[]];
  for (const grapheme of graphemes(text)) {
    // Only a complete space cluster is a word boundary. A space with combining
    // marks remains intact, just like a letter with combining marks.
    if (grapheme === " ") words.push([]);
    else words[words.length - 1].push(grapheme);
  }
  /** @type {string[]} */
  const lines = [];
  let line = "";
  let lineWidth = 0;
  for (const word of words) {
    const widths = word.map(graphemeWidth);
    const wordWidth = widths.reduce((total, cells) => total + cells, 0);
    if (line && lineWidth + 1 + wordWidth <= width) { line += ` ${word.join("")}`; lineWidth += 1 + wordWidth; continue; }
    if (line) { lines.push(line); line = ""; lineWidth = 0; }
    for (let index = 0; index < word.length; index++) {
      if (line && lineWidth + widths[index] > width) { lines.push(line); line = ""; lineWidth = 0; }
      line += word[index];
      lineWidth += widths[index];
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Status-local layout; other commands and message/card rendering are unaffected.
 * @param {{columns?: number, stream?: any}} [options] */
export function statusLayout(options = {}) {
  const requested = options.columns ?? options.stream?.columns ?? process.stdout.columns ?? 80;
  const columns = Number.isFinite(requested) ? Math.max(20, Math.floor(requested)) : 80;
  const stream = options.stream instanceof Writable ? options.stream : process.stdout;
  const style = (format, value) => paint(format, value, { stream });
  /** @type {string[]} */ const lines = [];
  return {
    heading(value) { lines.push("", ...wrapStatus(value, columns).map((text) => style(["bold", "green"], text))); },
    title(value) { lines.push(...wrapStatus(value, columns).map((text) => style("bold", text))); },
    text(value) { lines.push(...wrapStatus(value, columns)); },
    row(label, value, tone = "") {
      const safeLabel = sanitizeTerminalText(label);
      if (columns < 64 || statusWidth(safeLabel) > 21) {
        lines.push(...wrapStatus(safeLabel, columns - 2).map((text) => `  ${style("dim", text)}`));
        lines.push(...wrapStatus(value, columns - 4).map((text) => `    ${tone ? style(tone, text) : text}`));
      } else {
        const prefix = `  ${safeLabel}${" ".repeat(Math.max(0, 21 - statusWidth(safeLabel)))}  `;
        const wrapped = wrapStatus(value, columns - statusWidth(prefix));
        lines.push(...wrapped.map((text, index) => `${index === 0 ? style("dim", prefix) : " ".repeat(statusWidth(prefix))}${tone ? style(tone, text) : text}`));
      }
    },
    finish() { return `${lines.join("\n")}\n`; },
  };
}
