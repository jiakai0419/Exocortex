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

/**
 * @typedef {import("../diagnostics/messages-report.mjs").EnrichedMessage} EnrichedMessage
 */

/** @param {EnrichedMessage[]} messages */
function renderMessagesText(messages) {
  if (messages.length === 0) return "No messages.\n";
  const lines = [];
  lines.push(title(`Messages (${messages.length})`));
  lines.push("");
  for (const message of messages) {
    const time = message.occurred_at ? new Date(message.occurred_at).toLocaleString() : "unknown time";
    lines.push(
      `${statusBadge(message.direction)} ${time}  ${subtitle(message.display.external_id)}  ${section(
        message.display.scene,
      )}`,
    );
    lines.push(`  ${key("发送人")}  ${value(message.display.sender)}`);
    if (message.display.recipient) lines.push(`  ${key("接收人")}  ${value(message.display.recipient)}`);
    if (message.display.chat) lines.push(`  ${key("群")}      ${value(message.display.chat)}`);
    lines.push(`  ${key("类型")}    ${value(message.display.sender_type)} / ${value(message.display.message_type)}`);
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
      for (const line of (text || "[卡片没有可展示的文本]").split("\n")) lines.push(`    ${line}`);
    } else {
      lines.push(`  ${key("消息")}    ${compact(message.display.body)}`);
    }
    lines.push("");
  }
  return `${block(lines)}\n`;
}

export {
  renderMessagesText,
};
