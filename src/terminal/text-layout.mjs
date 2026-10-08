// @ts-check
// Dependency-free cell geometry and plain-text wrapping; callers sanitize and style.

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const NONSPACING = /[\p{Mark}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}(?!\uFE0E)/u;
const EMOJI_VARIATION = /\p{Extended_Pictographic}\uFE0F/u;
const EMOJI_JOINED = /\p{Extended_Pictographic}.*\u200D.*\p{Extended_Pictographic}/u;
const EMOJI_KEYCAP = /[0-9#*]\uFE0F?\u20E3/u;

/** @param {string} text */
export const graphemes = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);

/** Width model for a single extended grapheme, using the runtime Unicode data.
 * Emoji presentation sequences occupy two cells as a unit, including flags,
 * modifiers, keycaps and ZWJ families. VS15 falls back to text presentation.
 * @param {string} grapheme */
export function graphemeWidth(grapheme) {
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

/** Count already-sanitized plain text; ANSI styling belongs after wrapping.
 * @param {string} text */
export function textWidth(text) {
  return graphemes(text).reduce((total, part) => total + graphemeWidth(part), 0);
}

/** @param {{columns?: number}} [stream] @param {number} [columns] */
export function terminalColumns(stream, columns) {
  const requested = columns ?? stream?.columns ?? 80;
  return Number.isSafeInteger(Math.floor(requested)) ? Math.max(20, Math.floor(requested)) : 80;
}

/** Wrap one sanitized hard line. Preserved fragments concatenate exactly to the
 * original, including spaces. A URL token or indivisible grapheme may overflow.
 * @param {string} input @param {number} width
 * @param {{preserveWhitespace?: boolean, preserveUrls?: boolean}} [options] */
export function wrapTextLine(input, width, options = {}) {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("text wrap width must be a positive safe integer");
  const text = options.preserveWhitespace ? input : input.replace(/\s+/g, " ").trim();
  /** @type {string[][]} */ const words = [[]];
  for (const part of graphemes(text)) {
    if (part === " ") words.push([]);
    else words[words.length - 1].push(part);
  }
  if (options.preserveWhitespace) {
    // Make URLs atomic without splitting a space+combining-mark grapheme.
    const units = words.flatMap((word, index) => [
      ...(index ? [" "] : []),
      ...(options.preserveUrls && /https?:\/\//i.test(word.join("")) ? [word.join("")] : word),
    ]);
    const widths = units.map(textWidth);
    const lines = [];
    let start = 0;
    while (start < units.length) {
      let end = start, cells = 0, boundary = start, visible = false;
      while (end < units.length && (cells + widths[end] <= width || end === start)) {
        cells += widths[end];
        if (units[end] !== " ") visible = true;
        else if (visible) boundary = end + 1;
        end++;
        if (cells > width) break;
      }
      // Keep leading spaces with an oversized URL instead of creating a blank
      // line solely for those spaces. Other source whitespace stays untouched.
      if (!visible && end < units.length && widths[end] > width) end++;
      else if (end < units.length && units[end] !== " " && boundary > start) end = boundary;
      lines.push(units.slice(start, end).join(""));
      start = end;
    }
    return lines.length ? lines : [""];
  }
  /** @type {string[]} */ const lines = [];
  let line = "", lineWidth = 0;
  for (const word of words) {
    const widths = word.map(graphemeWidth);
    const wordWidth = widths.reduce((total, cells) => total + cells, 0);
    if (line && lineWidth + 1 + wordWidth <= width) { line += ` ${word.join("")}`; lineWidth += 1 + wordWidth; continue; }
    if (line) { lines.push(line); line = ""; lineWidth = 0; }
    if (options.preserveUrls && /https?:\/\//i.test(word.join(""))) {
      line = word.join(""); lineWidth = wordWidth; continue;
    }
    for (let index = 0; index < word.length; index++) {
      if (line && lineWidth + widths[index] > width) { lines.push(line); line = ""; lineWidth = 0; }
      line += word[index]; lineWidth += widths[index];
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Label/value prose with a hanging continuation, stacking long labels on
 * narrow screens. Callers supply only sanitized or locally defined strings.
 * @param {string} label @param {string} value @param {number} columns
 * @param {{indent?: number, gap?: string}} [options] */
export function wrapLabelValue(label, value, columns, { indent = 0, gap = "  " } = {}) {
  const leading = " ".repeat(indent);
  const prefix = `${leading}${label}${gap}`;
  const whole = `${prefix}${value}`;
  if (textWidth(whole) <= columns) return [whole];
  if (columns < 64 && indent >= 4 || textWidth(prefix) > columns / 2) {
    return [
      ...wrapTextLine(label, Math.max(1, columns - indent)).map((line) => `${leading}${line}`),
      ...wrapTextLine(value, Math.max(1, columns - indent - 2)).map((line) => `${leading}  ${line}`),
    ];
  }
  return wrapTextLine(value, columns - textWidth(prefix)).map((line, index) => `${index ? " ".repeat(textWidth(prefix)) : prefix}${line}`);
}
