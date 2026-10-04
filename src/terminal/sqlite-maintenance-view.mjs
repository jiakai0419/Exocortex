// @ts-check
import {
  block,
  kv,
  section,
  statusBadge,
  subtitle,
  table,
  title,
} from "../../dist/terminal/index.js";

/** @typedef {Record<string, any>} JsonObject */
/** @param {JsonObject} report */
function renderSqliteMaintenanceText(report) {
  const lines = [
    `${title("SQLite maintenance")} ${statusBadge(report.status)}`,
    subtitle(`Checked at ${new Date(report.checked_at).toLocaleString()}`),
    "",
    section("Summary"),
    kv([
      ["Action", report.action],
      ["Database", report.db_path],
      ["Backup", report.backup_path || ""],
      ["Counts match", report.counts_match === undefined ? "" : report.counts_match ? "yes" : "no"],
      ["Manifest", report.manifest?.status || ""],
      ["Reclaimed", report.reclaimed_bytes === undefined ? "" : `${report.reclaimed_bytes} bytes`],
    ]),
  ];
  if (report.prune) {
    lines.push("");
    lines.push(section("Run retention"));
    lines.push(kv([
      ["Mode", report.prune.dry_run ? "dry-run" : "apply"],
      ["Rule", `delete succeeded no-op runs older than ${report.prune.retention_days} days`],
      ["Cutoff", report.prune.cutoff_at],
      ["Candidates", report.prune.candidate_count],
      ["Deleted", report.prune.deleted_count],
    ]));
  }
  if (report.retention) {
    lines.push("");
    lines.push(section("Backup retention"));
    lines.push(kv([
      ["Policy", `${report.retention.keep_count} files / ${report.retention.keep_days} days`],
      ["Removed", report.retention.removed_count],
    ]));
  }
  const check = report.after || report.backup_check || report.check || report.source_check || report.before;
  if (check) {
    lines.push("");
    lines.push(section("Integrity"));
    lines.push(kv([
      ["quick_check", check.quick_check],
      ["foreign_key_issues", check.foreign_key_issues],
      ["missing_tables", check.missing_tables?.length || 0],
      ["size_bytes", check.size_bytes],
    ]));
  }
  if (check?.counts) {
    lines.push("");
    lines.push(section("Counts"));
    lines.push(table(Object.entries(check.counts).map(([name, count]) => ({ name, count })), [
      { header: "Table", key: "name" },
      { header: "Rows", key: "count" },
    ]));
  }
  return `${block(lines)}\n`;
}


export { renderSqliteMaintenanceText };
