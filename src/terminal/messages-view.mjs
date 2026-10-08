// @ts-check

import {
  block,
  compact,
  key,
  sanitizeTerminalText,
  section,
  statusBadge,
  subtitle,
  title,
  value,
} from "../../dist/terminal/index.js";
import { displayCard } from "../diagnostics/messages-report.mjs";
import { terminalColumns, textWidth, wrapTextLine } from "./text-layout.mjs";

/**
 * @typedef {import("../diagnostics/messages-report.mjs").EnrichedMessage} EnrichedMessage
 */

/** @param {EnrichedMessage[]} messages
 * @param {{columns?: number, stream?: any}} [options] */
function renderMessagesText(messages, options = {}) {
  if (messages.length === 0) return "No messages.\n";
  const columns = terminalColumns(options.stream, options.columns);
  const lines = [];
  const faithful = { preserveWhitespace: true, preserveUrls: true };
  /** Metadata keeps its existing label and first-line spacing. */
  function field(label, content, gap) {
    const prefix = `  ${label}${" ".repeat(gap)}`;
    const continuation = " ".repeat(textWidth(prefix));
    const wrapped = wrapTextLine(sanitizeTerminalText(content), columns - textWidth(prefix), faithful);
    for (const [index, line] of wrapped.entries()) {
      lines.push(`${index === 0 ? `  ${key(label)}${" ".repeat(gap)}` : continuation}${line}`);
    }
  }
  /** Keep the four trusted header segments together whenever they fit. */
  function header(message, time) {
    const segments = [
      { text: sanitizeTerminalText(statusBadge(message.direction)), style: statusBadge, gap: "" },
      { text: sanitizeTerminalText(time), style: value, gap: " " },
      { text: sanitizeTerminalText(message.display.external_id), style: subtitle, gap: "  " },
      { text: sanitizeTerminalText(message.display.scene), style: section, gap: "  " },
    ];
    let line = "", width = 0;
    for (const segment of segments) {
      const gap = line ? segment.gap : "";
      if (width + textWidth(gap) + textWidth(segment.text) <= columns) {
        line += `${gap}${segment.style(segment.text)}`;
        width += textWidth(gap) + textWidth(segment.text);
        continue;
      }
      if (line) { lines.push(line); line = "  "; width = 2; }
      const wrapped = wrapTextLine(segment.text, columns - 2, faithful);
      for (const [index, part] of wrapped.entries()) {
        if (index > 0) { lines.push(line); line = "  "; width = 2; }
        line += segment.style(part);
        width += textWidth(part);
      }
    }
    lines.push(line);
  }
  /** Preserve each source hard line and its indentation independently. */
  function cardLine(line) {
    const indentation = line.match(/^ */)?.[0] || "";
    const available = columns - 4 - textWidth(indentation);
    // Deep source indentation is evidence, not disposable layout padding.
    if (available <= 0) { lines.push(`    ${line}`); return; }
    for (const part of wrapTextLine(line.slice(indentation.length), available, faithful)) {
      lines.push(`    ${indentation}${part}`);
    }
  }
  lines.push(title(`Messages (${messages.length})`));
  lines.push("");
  for (const message of messages) {
    const time = message.occurred_at ? new Date(message.occurred_at).toLocaleString() : "unknown time";
    header(message, time);
    field("发送人", message.display.sender, 2);
    if (message.display.recipient) field("接收人", message.display.recipient, 2);
    if (message.display.chat) field("群", message.display.chat, 6);
    field("类型", `${message.display.sender_type} / ${message.display.message_type}`, 4);
    if (message.display.card) {
      // Never feed a failed card projection back into the legacy raw-JSON body
      // fallback. Preserve lines, sanitize before indentation, and keep styling
      // restricted to trusted labels.
      lines.push(`  ${key("消息")}`);
      // Reproject source nodes instead of deleting matching text: real prose can
      // contain diagnostic wording or literal Markdown separators. The stored
      // and machine-readable projection retains its original representation.
      const card = displayCard(message.raw, { includePartialNotice: false, includeDecorativeSeparators: false });
      const text = sanitizeTerminalText(card.text, { preserveNewlines: true });
      for (const line of (text || "[卡片没有可展示的文本]").split("\n")) cardLine(line);
    } else {
      field("消息", compact(message.display.body), 4);
    }
    lines.push("");
  }
  return `${block(lines)}\n`;
}

export {
  renderMessagesText,
};
