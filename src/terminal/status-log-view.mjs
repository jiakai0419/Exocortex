// @ts-check
import { statusBadge } from "../../dist/terminal/index.js";

/** @param {string} line */
function formatLogLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }

  if (event.type === "lark_im_worker_cycle") {
    return `${event.at} cycle=${event.cycle} ${event.ok ? statusBadge("ok") : statusBadge("failed")}`;
  }

  if (event.type === "lark_im_worker_step") {
    const summary = event.summary || {};
    const parts = [
      `${event.finished_at || event.started_at} cycle=${event.cycle}`,
      event.name,
      event.ok ? statusBadge("ok") : `${statusBadge("failed")} exit=${event.exit_code}`,
    ];

    if (summary.sent) {
      parts.push(
        `run=${summary.sent.run_id}`,
        `records=${summary.sent.records ?? 0}`,
        `inserted=${summary.sent.inserted ?? 0}`,
      );
    }
    if (summary.discovery) {
      if (summary.discovery.skipped) {
        parts.push(
          statusBadge("skipped"),
          summary.discovery.reason || "skipped",
          `mode=${summary.discovery.mode || "unknown"}`,
          `has_more=${summary.discovery.has_more}`,
        );
      } else {
        parts.push(
          `run=${summary.discovery.run_id}`,
          `mode=${summary.discovery.mode || "unknown"}`,
          `pages=${summary.discovery.pages ?? 0}`,
          `discovered=${summary.discovery.discovered_in_run ?? 0}`,
          `has_more=${summary.discovery.has_more}`,
        );
      }
    }
    if (summary.received) {
      parts.push(
        `scopes=${summary.received.scopes ?? 0}`,
        `records=${summary.received.records ?? 0}`,
        `inserted=${summary.received.inserted ?? 0}`,
        `failed=${summary.received.failed ?? 0}`,
      );
    }
    if (event.stderr) parts.push(`stderr=${event.stderr.slice(0, 240)}`);
    return parts.join(" ");
  }

  return line;
}

export { formatLogLine };
