import { stdout } from "node:process";
import { stripVTControlCharacters, styleText } from "node:util";
function paint(format, text, options = {}) {
    const stream = options.stream || stdout;
    return styleText(format, String(text), { stream });
}
function plain(value) {
    return stripVTControlCharacters(String(value ?? ""));
}
function visibleLength(value) {
    return plain(value).length;
}
function padRight(value, width) {
    const text = String(value ?? "");
    const padding = Math.max(0, width - visibleLength(text));
    return `${text}${" ".repeat(padding)}`;
}
function title(text) {
    return paint("bold", text);
}
function subtitle(text) {
    return paint("dim", text);
}
function section(text) {
    return paint(["bold", "green"], text);
}
function command(text) {
    return paint(["bold", "cyan"], text);
}
function key(text) {
    return paint("dim", text);
}
function value(text) {
    return String(text ?? "");
}
function hint(label, text) {
    return `${paint("yellow", label)} ${subtitle(text)}`;
}
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
        problem: ["PROBLEM", "red"],
        failed: ["FAILED", "red"],
        command_failed: ["FAILED", "red"],
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
    const fallback = [String(status || "UNKNOWN").toUpperCase(), "gray"];
    const [label, color] = labels[normalized] || fallback;
    return paint(["bold", color], label);
}
function kv(rows, options = {}) {
    const entries = [];
    for (const row of rows) {
        if (!row)
            continue;
        const [name, val] = row;
        entries.push([String(name), String(val ?? "")]);
    }
    const width = Math.max(options.width || 0, ...entries.map(([name]) => visibleLength(name)));
    return entries.map(([name, val]) => `  ${key(padRight(name, width))}  ${value(val)}`).join("\n");
}
function table(rows, columns) {
    if (rows.length === 0)
        return "";
    const widths = columns.map((column) => Math.max(visibleLength(column.header), ...rows.map((row) => visibleLength(column.render ? column.render(row) : row[column.key]))));
    const header = columns
        .map((column, index) => paint("bold", padRight(column.header, widths[index])))
        .join("  ");
    const body = rows.map((row) => columns
        .map((column, index) => padRight(column.render ? column.render(row) : row[column.key], widths[index]))
        .join("  "));
    return [header, ...body].join("\n");
}
function list(items, options = {}) {
    if (!items || items.length === 0)
        return options.empty || "";
    return items.map((item) => `  - ${item}`).join("\n");
}
function block(lines) {
    return lines.filter((line) => line !== null && line !== undefined).join("\n").trimEnd();
}
function compact(value, limit = 240) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text)
        return "(empty)";
    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}
function json(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function parseEmbeddedJson(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed.startsWith("{"))
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
}
function renderError(error) {
    const message = String(error instanceof Error ? error.message : error || "unknown error");
    const payload = parseEmbeddedJson(message);
    const inner = payload?.error && typeof payload.error === "object" ? payload.error : null;
    const lines = [`${title("Error")} ${statusBadge("failed")}`];
    if (inner) {
        lines.push("");
        lines.push(kv([
            ["Type", [inner.type, inner.subtype].filter(Boolean).join("/") || "unknown"],
            ["Message", inner.message || "unknown error"],
        ]));
        if (inner.hint) {
            lines.push("");
            lines.push(hint("Hint", compact(inner.hint, 280)));
        }
    }
    else {
        lines.push("");
        lines.push(`  ${message}`);
    }
    return `${block(lines)}\n`;
}
export { block, command, compact, hint, json, key, kv, list, padRight, paint, plain, renderError, section, statusBadge, subtitle, table, title, value, visibleLength, };
