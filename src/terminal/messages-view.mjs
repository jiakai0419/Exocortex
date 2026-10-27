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
  /** Keep existing spacing unless a long label leaves no room for a wide glyph. */
  function field(label, content, gap) {
    const prefix = `  ${label}${" ".repeat(gap)}`;
    if (columns - textWidth(prefix) < 2) {
      // terminalColumns clamps to at least 20; both stacked widths stay positive.
      for (const line of wrapTextLine(label, columns - 2, faithful)) {
        lines.push(`  ${key(line)}`);
      }
      for (const line of wrapTextLine(sanitizeTerminalText(content), columns - 4, faithful)) {
        lines.push(`    ${line}`);
      }
      return;
    }
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
  const incomplete=messages.filter(message=>message.readiness && message.readiness.state!=='ready');
  if (incomplete.length) {
    const blocked=incomplete.filter(message=>message.readiness?.state==='blocked').length;
    lines.push(...wrapTextLine(`完整 ${messages.length-incomplete.length} · 待补全 ${incomplete.length-blocked} · 受阻 ${blocked}`,columns,faithful));
  }
  lines.push("");
  for (const message of messages) {
    const time = message.occurred_at ? new Date(message.occurred_at).toLocaleString() : "unknown time";
    header(message, time);
    if (message.readiness && message.readiness.state!=='ready') {
      const reasons = {
        message_identity_invalid:'消息身份需核验',message_time_invalid:'消息时间需核验',direction_unknown:'方向未知',
        account_unknown:'账号归属待核验',account_conflict:'账号证据冲突',conversation_identity_conflict:'会话身份冲突',
        conversation_type_unknown:'会话类型待核验',conversation_name_missing:'会话名称待补全',
        sender_identity_unknown:'发送人身份待核验',sender_identity_conflict:'发送人身份冲突',
        sender_name_missing:'发送人名称待补全',sender_name_unverified:'发送人名称待核验',
        recipient_identity_unknown:'接收人身份待核验',recipient_identity_conflict:'接收人身份冲突',
        recipient_name_missing:'接收人名称待补全',name_explicitly_cleared:'来源已清除名称',
        content_pending:'消息详情待补全',content_partial:'消息内容未完整解析',content_invalid:'消息内容需核验',
        content_unsupported:'消息类型尚未完整支持',permission_denied:'来源权限不足',unsupported_identity:'身份类型暂不支持',
      };
      field('状态',message.readiness.state==='blocked'?'准备受阻':'等待完整信息',4);
      field('原因',[...new Set((message.readiness.reasons||[]).map(reason=>reasons[reason]||'信息待核验'))].join('；'),4);
      field('查看','messages --format json 可检查已保存内容与原因',4);
      lines.push('');
      continue;
    }
    field("发送人", message.display.sender, 2);
    if (message.display.recipient) field("接收人", message.display.recipient, 2);
    if (message.display.chat) {
      if (message.display.scene === "群聊" || message.display.scene === "话题群") field("群", message.display.chat, 6);
      else field("会话", message.display.chat, 4);
    }
    if (message.display.system?.current_group_context) {
      field("当前本地标题来源", "会话配置；观察时间未知", 2);
    }
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
