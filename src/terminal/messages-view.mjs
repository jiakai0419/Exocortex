// @ts-check

import {
  block,
  compact,
  key,
  section,
  statusBadge,
  subtitle,
  title,
  value,
} from "../../dist/terminal/index.js";

/**
 * @typedef {import("../diagnostics/messages-report.mjs").EnrichedMessage} EnrichedMessage
 */

/** @param {EnrichedMessage[]} messages */
function renderMessagesText(messages) {
  if (messages.length === 0) return "No messages.\n";
  const lines = [];
  lines.push(title(`Messages (${messages.length})`));
  lines.push(subtitle("Latest synced messages first."));
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
    lines.push(`  ${key("消息")}    ${compact(message.display.body)}`);
    lines.push("");
  }
  return `${block(lines)}\n`;
}

export {
  renderMessagesText,
};
