#!/usr/bin/env node

// @ts-check

import { pathToFileURL } from "node:url";
import {
  command as renderCommand,
  hint,
  key,
  padRight,
  renderError,
  section,
  subtitle,
  title,
} from "./lib/terminal.mjs";

/**
 * @typedef {object} CommandGroup
 * @property {string} id
 * @property {string} title
 *
 * @typedef {object} CommandEntry
 * @property {string} group
 * @property {string} command
 * @property {string} file
 * @property {string} summary
 * @property {string[]} examples
 * @property {boolean=} core
 *
 * @typedef {"text" | "json"} HelpFormat
 *
 * @typedef {object} HelpOptions
 * @property {HelpFormat} format
 * @property {string | null} group
 * @property {string | null} command
 * @property {boolean} all
 */

/** @type {CommandGroup[]} */
const GROUPS = [
  { id: "daily", title: "Daily Use" },
  { id: "sync", title: "Sync Lifecycle" },
  { id: "diagnostics", title: "Diagnostics" },
  { id: "maintenance", title: "Maintenance" },
  { id: "research", title: "Research Probes" },
  { id: "development", title: "Development" },
];

/** @type {CommandEntry[]} */
const COMMANDS = [
  {
    group: "daily",
    command: "npm run help",
    file: "scripts/help.mjs",
    summary: "Show the core terminal commands.",
    examples: ["npm run help", "npm run help -- --all"],
    core: true,
  },
  {
    group: "daily",
    command: "node scripts/doctor.mjs",
    file: "scripts/doctor.mjs",
    summary: "Show the clearest overall local health report.",
    examples: ["node scripts/doctor.mjs", "node scripts/doctor.mjs --live"],
  },
  {
    group: "daily",
    command: "node scripts/messages.mjs --limit 20",
    file: "scripts/messages.mjs",
    summary: "Read the latest synced messages from the local store.",
    examples: ["node scripts/messages.mjs --limit 20"],
    core: true,
  },
  {
    group: "sync",
    command: "node scripts/init-ingestion-core.mjs",
    file: "scripts/init-ingestion-core.mjs",
    summary: "Initialize or migrate the local ingestion database.",
    examples: ["node scripts/init-ingestion-core.mjs"],
  },
  {
    group: "sync",
    command: "node scripts/lark-im-sync.mjs",
    file: "scripts/lark-im-sync.mjs",
    summary: "Run one bounded Lark IM sync pass.",
    examples: [
      "node scripts/lark-im-sync.mjs",
      "node scripts/lark-im-sync.mjs --scope sent",
      "node scripts/lark-im-sync.mjs --scope received --received-scopes-per-run 10",
    ],
  },
  {
    group: "sync",
    command: "node scripts/lark-im-worker.mjs",
    file: "scripts/lark-im-worker.mjs",
    summary: "Run the continuous polling worker.",
    examples: ["node scripts/lark-im-worker.mjs", "node scripts/lark-im-worker.mjs --once"],
  },
  {
    group: "sync",
    command: "node scripts/lark-im-service.mjs status",
    file: "scripts/lark-im-service.mjs",
    summary: "Check whether the background worker service is running.",
    examples: [
      "node scripts/lark-im-service.mjs status",
      "node scripts/lark-im-service.mjs restart",
      "node scripts/lark-im-service.mjs wait-ok",
    ],
    core: true,
  },
  {
    group: "diagnostics",
    command: "node scripts/sync-status.mjs",
    file: "scripts/sync-status.mjs",
    summary: "Inspect local sync state, scopes, runs, and locks.",
    examples: ["node scripts/sync-status.mjs", "node scripts/sync-status.mjs --format json"],
  },
  {
    group: "diagnostics",
    command: "node scripts/lark-im-quality.mjs",
    file: "scripts/lark-im-quality.mjs",
    summary: "Check local Lark IM data quality.",
    examples: ["node scripts/lark-im-quality.mjs", "node scripts/lark-im-quality.mjs --format json"],
  },
  {
    group: "diagnostics",
    command: "node scripts/lark-im-lag-check.mjs",
    file: "scripts/lark-im-lag-check.mjs",
    summary: "Compare recent remote hot Lark messages with local records.",
    examples: ["node scripts/lark-im-lag-check.mjs", "node scripts/lark-im-lag-check.mjs --hot-chats 5"],
  },
  {
    group: "maintenance",
    command: "node scripts/maintenance-check.mjs",
    file: "scripts/maintenance-check.mjs",
    summary: "Run the release/maintenance validation flow.",
    examples: [
      "node scripts/maintenance-check.mjs",
      "node scripts/maintenance-check.mjs --live",
      "node scripts/maintenance-check.mjs --no-restart",
    ],
  },
  {
    group: "maintenance",
    command: "node scripts/sqlite-maintenance.mjs check",
    file: "scripts/sqlite-maintenance.mjs",
    summary: "Check, back up, and verify the private SQLite memory database.",
    examples: [
      "node scripts/sqlite-maintenance.mjs check",
      "node scripts/sqlite-maintenance.mjs backup",
      "node scripts/sqlite-maintenance.mjs verify --latest",
    ],
  },
  {
    group: "maintenance",
    command: "node scripts/lark-im-enrich-records.mjs",
    file: "scripts/lark-im-enrich-records.mjs",
    summary: "Backfill display names and normalized message bodies for existing records.",
    examples: [
      "node scripts/lark-im-enrich-records.mjs",
      "node scripts/lark-im-enrich-records.mjs --limit 100",
      "node scripts/lark-im-enrich-records.mjs --limit 1000 --probe-apps",
    ],
  },
  {
    group: "maintenance",
    command: "node scripts/lark-im-enrich-scopes.mjs",
    file: "scripts/lark-im-enrich-scopes.mjs",
    summary: "Backfill chat metadata on received-message scopes.",
    examples: ["node scripts/lark-im-enrich-scopes.mjs", "node scripts/lark-im-enrich-scopes.mjs --limit 100"],
  },
  {
    group: "research",
    command: "node scripts/lark-capability-probe.mjs",
    file: "scripts/lark-capability-probe.mjs",
    summary: "Probe lark-cli capabilities and write a capability report.",
    examples: ["node scripts/lark-capability-probe.mjs"],
  },
  {
    group: "research",
    command: "node scripts/lark-im-cursor-probe.mjs",
    file: "scripts/lark-im-cursor-probe.mjs",
    summary: "Probe Lark IM paging, ordering, and cursor behavior.",
    examples: ["node scripts/lark-im-cursor-probe.mjs"],
  },
  {
    group: "development",
    command: "npm test",
    file: "package.json",
    summary: "Run deterministic automated tests.",
    examples: ["npm test"],
  },
  {
    group: "development",
    command: "npm run check",
    file: "package.json",
    summary: "Run syntax checks for all scripts.",
    examples: ["npm run check"],
  },
];

function usage() {
  return `Usage: node scripts/help.mjs [options]

Options:
  --all               Show the full command catalog. Default shows only core daily commands.
  --group <id>        Show one command group.
  --command <text>    Show commands whose command or file contains text.
  --format <fmt>      text | json. Default: text
  --help              Show this help.

Groups:
${GROUPS.map((group) => `  ${group.id.padEnd(12)} ${group.title}`).join("\n")}
`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {HelpOptions} */
  const opts = { format: "text", group: null, command: null, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === "--all") {
      opts.all = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--format") opts.format = /** @type {HelpFormat} */ (next);
    else if (arg === "--group") opts.group = next;
    else if (arg === "--command") opts.command = next;
    else throw new Error(`Unknown option: ${arg}`);
    i += 1;
  }
  if (!["text", "json"].includes(opts.format)) throw new Error("--format must be text or json");
  if (opts.group && !GROUPS.some((group) => group.id === opts.group)) {
    throw new Error(`unknown group: ${opts.group}`);
  }
  return opts;
}

/** @param {HelpOptions} opts */
function filteredCommands(opts) {
  const fullCatalog = opts.all || opts.group || opts.command;
  return COMMANDS.filter((item) => {
    if (!fullCatalog && item.core !== true) return false;
    if (opts.group && item.group !== opts.group) return false;
    if (opts.command) {
      const needle = opts.command.toLowerCase();
      return item.command.toLowerCase().includes(needle) || item.file.toLowerCase().includes(needle);
    }
    return true;
  });
}

/** @param {CommandEntry[]} commands */
function renderCoreText(commands) {
  const lines = [];
  const width = Math.max(...commands.map((item) => item.command.length));

  lines.push(title("Exocortex core commands"));
  lines.push(subtitle("Copy one of these. Full catalog: npm run help -- --all"));
  lines.push("");

  for (const item of commands) {
    lines.push(`  ${renderCommand(padRight(item.command, width))}  ${subtitle(item.summary)}`);
  }

  lines.push("");
  lines.push(hint("Tip", "Run a command with --help when you need all of its options."));
  return `${lines.join("\n")}\n`;
}

/**
 * @param {CommandEntry[]} commands
 * @param {Partial<HelpOptions>} [opts]
 */
function renderText(commands, opts = {}) {
  if (!opts.all && !opts.group && !opts.command) return renderCoreText(commands);

  const lines = [];
  lines.push(title(opts.all ? "Exocortex terminal commands" : "Exocortex filtered commands"));
  lines.push("");
  lines.push(
    subtitle(opts.all
      ? "Full command catalog. Run any command with --help for full options."
      : "Filtered command catalog. Run npm run help -- --all for everything."),
  );
  lines.push("");

  for (const group of GROUPS) {
    const groupCommands = commands.filter((item) => item.group === group.id);
    if (groupCommands.length === 0) continue;
    lines.push(section(group.title));
    for (const item of groupCommands) {
      lines.push(`  ${renderCommand(item.command)}`);
      lines.push(`    ${subtitle(item.summary)}`);
      if (item.examples?.length > 0) {
        lines.push(`    ${key("Examples:")}`);
        for (const example of item.examples) lines.push(`      ${renderCommand(example)}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const commands = filteredCommands(opts);
  const payload = { groups: GROUPS, commands };
  if (opts.format === "json") process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(renderText(commands, opts));
}

export { COMMANDS, GROUPS, filteredCommands, renderText };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(renderError(error));
    process.exit(1);
  }
}
