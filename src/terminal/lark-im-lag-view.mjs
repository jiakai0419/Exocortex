// @ts-check

import {
  block,
  compact as compactText,
  kv,
  list,
  section,
  statusBadge,
  subtitle,
  title,
} from "../../dist/terminal/index.js";

/**
 * @typedef {Record<string, any>} JsonObject
 */

/** @param {JsonObject} report */
function renderLagText(report) {
  const lines = [
    `${title("Lark IM lag check")} ${statusBadge(report.status)}`,
    subtitle(`${report.window.start} to ${report.window.end}`),
    "",
    section("Summary"),
    kv([
      ["Hot chats", `${report.probe.hot_chats_found}/${report.probe.hot_chats_requested}`],
      ["Remote messages checked", report.probe.remote_messages_checked],
      ["Missing remote messages", report.missing_count],
      ["Latest remote-local lag", report.lag_ms === null ? "unknown" : `${Math.round(report.lag_ms / 1000)}s`],
      ["Probe errors", report.probe.probe_errors],
      ["Unsupported chats", report.probe.unsupported_chats],
    ]),
  ];
  if (report.latest_remote) {
    lines.push("");
    lines.push(section("Latest remote"));
    lines.push(
      kv([
        ["Created", report.latest_remote.created_at],
        ["Chat", report.latest_remote.chat_name],
        ["Sender", report.latest_remote.sender_name],
        ["Exists locally", report.latest_remote.exists_locally],
      ]),
    );
    if (report.latest_remote.body) lines.push(`  ${compactText(report.latest_remote.body, 180)}`);
  }
  if (report.latest_local) {
    lines.push("");
    lines.push(section("Latest local"));
    lines.push(
      kv([
        ["Created", report.latest_local.created_at],
        ["Chat", report.latest_local.chat_name || ""],
        ["Direction", report.latest_local.direction],
      ]),
    );
  }
  if (report.missing.length > 0) {
    lines.push("");
    lines.push(section("Missing"));
    lines.push(
      list(
        report.missing.map(
          (message) =>
            `${message.created_at} ${message.chat_name} / ${message.sender_name}: ${compactText(message.body, 140)}`,
        ),
      ),
    );
  }
  if (report.unsupported_chats.length > 0) {
    lines.push("");
    lines.push(section("Unsupported chats"));
    lines.push(list(report.unsupported_chats.map((chat) => `${chat.chat_name}: ${chat.reason}`)));
  }
  if (report.probe_errors.length > 0) {
    lines.push("");
    lines.push(section("Probe errors"));
    lines.push(list(report.probe_errors.map((error) => `${error.chat_name}: ${compactText(error.error, 180)}`)));
  }
  return `${block(lines)}\n`;
}

export {
  renderLagText,
};
