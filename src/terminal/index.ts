import { stdout } from "node:process";
import type { Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";

type PaintOptions = {
  stream?: Writable;
};

type KvOptions = {
  width?: number;
};

type TableColumn<Row extends Record<string, any> = Record<string, any>> = {
  header: string;
  key: string;
  render?: (row: Row) => unknown;
};

type ListOptions = {
  empty?: string;
};

type SanitizeOptions = {
  preserveNewlines?: boolean;
};

type StyleFormat = Parameters<typeof styleText>[0];
type StyleName = Extract<StyleFormat, string>;

const OSC_SEQUENCE = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C)/g;
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g;
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const TERMINAL_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;
const UNICODE_LINE_SEPARATORS = /[\u2028\u2029]/g;

/**
 * Normalize text that crosses into terminal rendering. Styling added by this
 * module is applied only after this function returns, so remote ANSI/CSI/OSC
 * sequences cannot be confused with trusted presentation escapes.
 */
function sanitizeTerminalText(value: unknown, options: SanitizeOptions = {}) {
  const preserveNewlines = options.preserveNewlines === true;
  const withoutSequences = stripVTControlCharacters(
    String(value ?? "").replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, ""),
  );
  return withoutSequences
    .replace(BIDI_CONTROLS, "")
    .replace(UNICODE_LINE_SEPARATORS, " ")
    .replace(TERMINAL_CONTROLS, (control) =>
      preserveNewlines && control === "\n" ? "\n" : " ",
    );
}

function paint(format: StyleFormat, text: unknown, options: PaintOptions = {}) {
  const stream = options.stream || stdout;
  return styleText(format, sanitizeTerminalText(text), { stream });
}

function plain(value: unknown) {
  return sanitizeTerminalText(value, { preserveNewlines: true });
}

function visibleLength(value: unknown) {
  return plain(value).length;
}

function padRight(value: unknown, width: number) {
  const text = sanitizeTerminalText(value);
  const padding = Math.max(0, width - visibleLength(text));
  return `${text}${" ".repeat(padding)}`;
}

function title(text: unknown) {
  return paint("bold", text);
}

function subtitle(text: unknown) {
  return paint("dim", text);
}

function section(text: unknown) {
  return paint(["bold", "green"], text);
}

function command(text: unknown) {
  return paint(["bold", "cyan"], text);
}

function key(text: unknown) {
  return paint("dim", text);
}

function value(text: unknown) {
  return sanitizeTerminalText(text);
}

function hint(label: unknown, text: unknown) {
  return `${paint("yellow", label)} ${subtitle(text)}`;
}

function statusBadge(status: unknown) {
  const safeStatus = sanitizeTerminalText(status || "unknown");
  const normalized = safeStatus.toLowerCase();
  const labels: Record<string, [string, StyleName]> = {
    fresh: ["OK", "green"],
    healthy: ["OK", "green"],
    ok: ["OK", "green"],
    succeeded: ["OK", "green"],
    syncing: ["SYNCING", "cyan"],
    catching_up: ["CATCHING UP", "yellow"],
    delayed: ["DELAYED", "yellow"],
    needs_attention: ["NEEDS ATTENTION", "red"],
    problem: ["PROBLEM", "red"],
    failed: ["FAILED", "red"],
    command_failed: ["FAILED", "red"],
    inconclusive: ["INCONCLUSIVE", "yellow"],
    unavailable: ["UNAVAILABLE", "gray"],
    verified: ["VERIFIED", "green"],
    behind: ["BEHIND", "yellow"],
    running: ["RUNNING", "cyan"],
    stopped: ["STOPPED", "red"],
    idle: ["IDLE", "gray"],
    active: ["ACTIVE", "green"],
    sent: ["SENT", "cyan"],
    received: ["RECEIVED", "green"],
    loaded: ["LOADED", "green"],
    "not loaded": ["NOT LOADED", "yellow"],
    skipped: ["SKIPPED", "gray"],
    unknown: ["UNKNOWN", "gray"],
  };
  const fallback: [string, StyleName] = [safeStatus.toUpperCase(), "gray"];
  const [label, color] = labels[normalized] || fallback;
  return paint(["bold", color], label);
}

function kv(rows: Array<[unknown, unknown] | null | undefined>, options: KvOptions = {}) {
  const entries: Array<[string, string]> = [];
  for (const row of rows) {
    if (!row) continue;
    const [name, val] = row;
    entries.push([sanitizeTerminalText(name), sanitizeTerminalText(val)]);
  }
  const width = Math.max(options.width || 0, ...entries.map(([name]) => visibleLength(name)));
  return entries.map(([name, val]) => `  ${key(padRight(name, width))}  ${value(val)}`).join("\n");
}

function table<Row extends Record<string, any>>(rows: Row[], columns: Array<TableColumn<Row>>) {
  if (rows.length === 0) return "";
  const headers = columns.map((column) => sanitizeTerminalText(column.header));
  const cells = rows.map((row) =>
    columns.map((column) =>
      sanitizeTerminalText(column.render ? column.render(row) : row[column.key]),
    ),
  );
  const widths = columns.map((_column, index) =>
    Math.max(
      visibleLength(headers[index]),
      ...cells.map((row) => visibleLength(row[index])),
    ),
  );
  const header = columns
    .map((_column, index) => paint("bold", padRight(headers[index], widths[index])))
    .join("  ");
  const body = cells.map((row) =>
    row.map((cell, index) => padRight(cell, widths[index])).join("  "),
  );
  return [header, ...body].join("\n");
}

function list(items: unknown[] | null | undefined, options: ListOptions = {}) {
  if (!items || items.length === 0) return sanitizeTerminalText(options.empty || "");
  return items.map((item) => `  - ${sanitizeTerminalText(item)}`).join("\n");
}

function block(lines: unknown[]) {
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trimEnd();
}

function compact(value: unknown, limit = 240) {
  const text = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
  if (!text) return "(empty)";
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function json(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseEmbeddedJson(text: unknown) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function renderError(error: unknown) {
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
    lines.push(`  ${sanitizeTerminalText(message)}`);
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
  sanitizeTerminalText,
  section,
  statusBadge,
  subtitle,
  table,
  title,
  value,
  visibleLength,
};
