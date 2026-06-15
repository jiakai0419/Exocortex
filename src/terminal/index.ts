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

type StyleFormat = Parameters<typeof styleText>[0];
type StyleName = Extract<StyleFormat, string>;

function paint(format: StyleFormat, text: unknown, options: PaintOptions = {}) {
  const stream = options.stream || stdout;
  return styleText(format, String(text), { stream });
}

function plain(value: unknown) {
  return stripVTControlCharacters(String(value ?? ""));
}

function visibleLength(value: unknown) {
  return plain(value).length;
}

function padRight(value: unknown, width: number) {
  const text = String(value ?? "");
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
  return String(text ?? "");
}

function hint(label: unknown, text: unknown) {
  return `${paint("yellow", label)} ${subtitle(text)}`;
}

function statusBadge(status: unknown) {
  const normalized = String(status || "unknown").toLowerCase();
  const labels: Record<string, [string, StyleName]> = {
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
  const fallback: [string, StyleName] = [String(status || "UNKNOWN").toUpperCase(), "gray"];
  const [label, color] = labels[normalized] || fallback;
  return paint(["bold", color], label);
}

function kv(rows: Array<[unknown, unknown] | null | undefined>, options: KvOptions = {}) {
  const entries: Array<[string, string]> = [];
  for (const row of rows) {
    if (!row) continue;
    const [name, val] = row;
    entries.push([String(name), String(val ?? "")]);
  }
  const width = Math.max(options.width || 0, ...entries.map(([name]) => visibleLength(name)));
  return entries.map(([name, val]) => `  ${key(padRight(name, width))}  ${value(val)}`).join("\n");
}

function table<Row extends Record<string, any>>(rows: Row[], columns: Array<TableColumn<Row>>) {
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

function list(items: unknown[] | null | undefined, options: ListOptions = {}) {
  if (!items || items.length === 0) return options.empty || "";
  return items.map((item) => `  - ${item}`).join("\n");
}

function block(lines: unknown[]) {
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trimEnd();
}

function compact(value: unknown, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
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
