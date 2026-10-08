// @ts-check
import { statusBadge } from "../../dist/terminal/index.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const optional = (value, valid) => value === undefined || value === null || valid(value);

/** Validate only fields used by the compact display. Private logs may also be
 * ordinary text, JSON scalars or damaged events; leave those lines to the
 * caller's existing sanitization and wrapping instead of guessing a result. */
function stepShape(event) {
  if (!text(event.finished_at || event.started_at) || !text(event.name) ||
      !event.ok && !optional(event.exit_code, Number.isSafeInteger) || !optional(event.stderr, (value) => typeof value === "string") ||
      !optional(event.summary, object)) return false;
  const summary = event.summary || {};
  for (const [name, fields] of Object.entries({ sent: ["run_id", "records", "inserted"],
    discovery: ["run_id", "pages", "discovered_in_run"], received: ["scopes", "records", "inserted", "failed"] })) {
    const part = summary[name];
    if (part == null) continue;
    if (!object(part)) return false;
    if (name === "discovery" && part.skipped === true) continue;
    if (!fields.every((field) => optional(part[field], count))) return false;
  }
  const discovery = summary.discovery;
  return !discovery || optional(discovery.mode, (value) => typeof value === "string") &&
    (discovery.skipped === undefined || typeof discovery.skipped === "boolean") &&
    optional(discovery.has_more, (value) => typeof value === "boolean") &&
    (discovery.skipped !== true || optional(discovery.reason, (value) => typeof value === "string"));
}

/** @param {string} line */
function formatLogLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }

  if (!object(event) || !Number.isSafeInteger(event.cycle) || event.cycle < 1 || typeof event.ok !== "boolean") return line;

  if (event.type === "lark_im_worker_cycle") {
    if (!text(event.at)) return line;
    return `${event.at} cycle=${event.cycle} ${event.ok ? statusBadge("ok") : statusBadge("failed")}`;
  }

  if (event.type === "lark_im_worker_step") {
    if (!stepShape(event)) return line;
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
