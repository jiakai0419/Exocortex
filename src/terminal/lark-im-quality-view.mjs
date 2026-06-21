// @ts-check

import {
  block,
  compact,
  kv,
  list,
  section,
  statusBadge,
  table,
  title,
} from "../../dist/terminal/index.js";
import { hasQualityIssues } from "../diagnostics/lark-im-quality-report.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 */

/** @param {JsonObject} report */
function renderQualityText(report) {
  const hasIssues = hasQualityIssues(report);
  const lines = [
    `${title("Lark IM data quality")} ${statusBadge(hasIssues ? "needs_attention" : "ok")}`,
    "",
    section("Summary"),
    kv([
      ["Messages", `${report.messages.total} total, ${report.messages.sent} sent, ${report.messages.received} received`],
      ["Latest", report.messages.latest_at || "none"],
      ["Actionable missing sender names", report.quality.actionable_missing_sender_name || 0],
      ["Missing sender names", `${report.quality.missing_sender_name || 0} total`],
      ["Missing user sender names", report.quality.missing_user_sender_name || 0],
      ["Missing app sender names", report.quality.missing_app_sender_name || 0],
      ["Unresolved app sender names", report.quality.unresolved_app_sender_name || 0],
      ["System senderless messages", report.quality.missing_system_sender_name || 0],
      ["Missing chat names", report.quality.missing_chat_name || 0],
      ["Invalid bodies", report.quality.invalid_rendered_body || 0],
      ["Deleted/recalled bodies", report.quality.deleted_or_recalled_body || 0],
      ["App sender records", report.quality.app_sender_records || 0],
    ]),
    "",
    section("Scopes"),
    kv([
      [
        "Received scopes",
        `${report.scopes.enabled_received_scopes || 0} enabled / ${report.scopes.total_received_scopes || 0} total`,
      ],
      ["Without cursor", report.scopes.enabled_without_cursor || 0],
      ["Hot-seen", report.scopes.hot_seen_scopes || 0],
      ["Unsupported", report.scopes.unsupported_scopes || 0],
    ]),
  ];
  if (report.unsupported_reasons.length > 0) {
    lines.push("");
    lines.push(section("Unsupported reasons"));
    lines.push(
      table(report.unsupported_reasons, [
        { key: "reason", header: "Reason", render: (row) => row.reason },
        {
          key: "lark_cli",
          header: "Lark CLI",
          render: (row) =>
            row.lark_cli_error_message
              ? `${row.lark_cli_error_code}: ${row.lark_cli_error_message}`
              : "",
        },
        { key: "count", header: "Count", render: (row) => row.count },
      ]),
    );
  }
  if (report.message_types.length > 0) {
    lines.push("");
    lines.push(section("Message types"));
    lines.push(
      table(report.message_types, [
        { key: "type", header: "Type", render: (row) => row.msg_type || "unknown" },
        { key: "count", header: "Count", render: (row) => row.count },
      ]),
    );
  }
  if (report.recent_failures.length > 0) {
    lines.push("");
    lines.push(section("Historical failed runs"));
    lines.push(
      list(
        report.recent_failures.map(
          (row) => `#${row.id} ${row.scope_id}: ${row.error_type || "Error"} ${compact(row.error_message, 140)}`,
        ),
      ),
    );
  }
  return `${block(lines)}\n`;
}

export {
  renderQualityText,
};
