// @ts-check

import { stdout } from "node:process";
import { stripVTControlCharacters, styleText } from "node:util";

/**
 * @typedef {import("node:stream").Writable} WritableStream
 *
 * @typedef {object} PaintOptions
 * @property {WritableStream=} stream
 *
 * @typedef {object} KvOptions
 * @property {number=} width
 *
 * @typedef {object} TableColumn
 * @property {string} header
 * @property {string} key
 * @property {((row: Record<string, any>) => unknown)=} render
 *
 * @typedef {object} ListOptions
 * @property {string=} empty
 */

/**
 * @param {string | string[]} format
 * @param {unknown} text
 * @param {PaintOptions} [options]
 */
function paint(format, text, options = {}) {
  const stream = options.stream || stdout;
  return styleText(/** @type {any} */ (format), String(text), { stream });
}

/** @param {unknown} value */
function plain(value) {
  return stripVTControlCharacters(String(value ?? ""));
}

/** @param {unknown} value */
function visibleLength(value) {
  return plain(value).length;
}

/**
 * @param {unknown} value
 * @param {number} width
 */
function padRight(value, width) {
  const text = String(value ?? "");
  const padding = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(padding)}`;
}

/** @param {unknown} text */
function title(text) {
  return paint("bold", text);
}

/** @param {unknown} text */
function subtitle(text) {
  return paint("dim", text);
}

/** @param {unknown} text */
function section(text) {
  return paint(["bold", "green"], text);
}

/** @param {unknown} text */
function command(text) {
  return paint(["bold", "cyan"], text);
}

/** @param {unknown} text */
function key(text) {
  return paint("dim", text);
}

/** @param {unknown} text */
function value(text) {
  return String(text ?? "");
}

/**
 * @param {unknown} label
 * @param {unknown} text
 */
function hint(label, text) {
  return `${paint("yellow", label)} ${subtitle(text)}`;
}

/** @param {unknown} status */
function statusBadge(status) {
  const normalized = String(status || "unknown").toLowerCase();
  const labels = {
    fresh: ["OK", "green"],
    healthy: ["OK", "green"],
    ok: ["OK", "green"],
    succeeded: ["OK", "green"],
    syncing: ["SYNCING", "cyan"],
    catching_up: ["CATCHING UP", "yellow"],
    delayed: ["DELAYED", "yellow"],
    needs_attention: ["NEEDS ATTENTION", "red"],
    failed: ["FAILED", "red"],
    command_failed: ["FAILED", "red"],
    unavailable: ["UNAVAILABLE", "gray"],
    running: ["RUNNING", "cyan"],
    active: ["ACTIVE", "green"],
    sent: ["SENT", "cyan"],
    received: ["RECEIVED", "green"],
    loaded: ["LOADED", "green"],
    "not loaded": ["NOT LOADED", "yellow"],
    skipped: ["SKIPPED", "gray"],
    unknown: ["UNKNOWN", "gray"],
  };
  const [label, color] = labels[normalized] || [String(status || "UNKNOWN").toUpperCase(), "gray"];
  return paint(["bold", color], label);
}

/**
 * @param {Array<[unknown, unknown] | null | undefined>} rows
 * @param {KvOptions} [options]
 */
function kv(rows, options = {}) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  for (const row of rows) {
    if (!row) continue;
    const [name, val] = row;
    entries.push([String(name), String(val ?? "")]);
  }
  const width = Math.max(options.width || 0, ...entries.map(([name]) => visibleLength(name)));
  return entries.map(([name, val]) => `  ${key(padRight(name, width))}  ${value(val)}`).join("\n");
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {TableColumn[]} columns
 */
function table(rows, columns) {
  if (rows.length === 0) return "";
  const widths = columns.map((column) =>
    Math.max(
      visibleLength(column.header),
      ...rows.map((row) => visibleLength(column.render ? column.render(row) : row[column.key])),
    ),
  );
  const header = columns
    .map((column, index) => paint("bold", padRight(column.header, widths[index])))
    .join("  ");
  const body = rows.map((row) =>
    columns
      .map((column, index) => padRight(column.render ? column.render(row) : row[column.key], widths[index]))
      .join("  "),
  );
  return [header, ...body].join("\n");
}

/**
 * @param {unknown[] | null | undefined} items
 * @param {ListOptions} [options]
 */
function list(items, options = {}) {
  if (!items || items.length === 0) return options.empty || "";
  return items.map((item) => `  - ${item}`).join("\n");
}

/** @param {Array<unknown>} lines */
function block(lines) {
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trimEnd();
}

/**
 * @param {unknown} value
 * @param {number} [limit]
 */
function compact(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

/** @param {unknown} value */
function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @param {unknown} text */
function parseEmbeddedJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** @param {unknown} error */
function renderError(error) {
  const message = String(error instanceof Error ? error.message : error || "unknown error");
  const payload = parseEmbeddedJson(message);
  const inner = payload?.error && typeof payload.error === "object" ? payload.error : null;
  const lines = [`${title("Error")} ${statusBadge("failed")}`];
  if (inner) {
    lines.push("");
    lines.push(
      kv([
        ["Type", [inner.type, inner.subtype].filter(Boolean).join("/") || "unknown"],
        ["Message", inner.message || "unknown error"],
      ]),
    );
    if (inner.hint) {
      lines.push("");
      lines.push(hint("Hint", compact(inner.hint, 280)));
    }
  } else {
    lines.push("");
    lines.push(`  ${message}`);
  }
  return `${block(lines)}\n`;
}

export {
  block,
  command,
  compact,
  hint,
  json,
  key,
  kv,
  list,
  padRight,
  paint,
  plain,
  renderError,
  section,
  statusBadge,
  subtitle,
  table,
  title,
  value,
  visibleLength,
};
