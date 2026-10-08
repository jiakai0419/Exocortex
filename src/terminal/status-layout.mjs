// @ts-check
import { Writable } from "node:stream";
import { paint, sanitizeTerminalText } from "../../dist/terminal/index.js";
import { textWidth, wrapTextLine } from "./text-layout.mjs";

/** Estimated cells in sanitized terminal text. Common CJK wide characters use
 * two cells; East Asian ambiguous characters use one. Emoji support, font shaping
 * and a terminal's ambiguous-width setting can differ from this model. Public
 * status terms are ASCII; arbitrary Unicode occurs in explicitly private logs.
 * @param {string} text */
export function statusWidth(text) {
  return textWidth(sanitizeTerminalText(text));
}

/** Sanitize and normalize whitespace before wrapping. Never split a grapheme or
 * truncate facts to fit. A grapheme wider than the requested width is preserved
 * on its own line; normal status rows have at least 16 cells available.
 * @param {unknown} value @param {number} width */
export function wrapStatus(value, width) {
  return wrapTextLine(sanitizeTerminalText(value), width);
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
