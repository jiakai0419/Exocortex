#!/usr/bin/env node
// Usage: node tests/helpers/render-status-examples.mjs OUTPUT_DIRECTORY
// These files are synthetic review artifacts, never recordings of a real status.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Writable } from "node:stream";
import { renderStatusText } from "../../src/terminal/status-view.mjs";
import { plain } from "../../dist/terminal/index.js";
import { STATUS_SCREEN_SCENARIOS, statusScreenFixture } from "./status-screen-fixture.mjs";

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]) {
  process.stderr.write("Usage: node tests/helpers/render-status-examples.mjs OUTPUT_DIRECTORY\n");
  process.exitCode = 1;
} else {
  const destination = resolve(args[0]);
  mkdirSync(destination, { recursive: true });
  const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { isTTY: false });
  const entries = [];
  for (const name of STATUS_SCREEN_SCENARIOS) {
    for (const columns of [96, 80, 56, 40]) {
      const file = `${name}-${columns}.txt`;
      writeFileSync(join(destination, file), plain(renderStatusText(statusScreenFixture(name), { columns, stream })));
      entries.push(file);
    }
  }
  writeFileSync(join(destination, "failed-detail-80.txt"), plain(renderStatusText(statusScreenFixture("failed", { detail: true }), { columns: 80, stream })));
  entries.push("failed-detail-80.txt");
  writeFileSync(join(destination, "README.txt"), `Invented Exocortex status screens. Fixed observation time: 2032-02-04T12:00:00Z.\nTime zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}.\nAll inputs originate in tests/helpers/status-screen-fixture.mjs.\nNo production data, screenshots or operational logs are included.\n\n${entries.join("\n")}\n`);
  process.stdout.write(`Wrote ${entries.length} synthetic status examples to ${destination}\n`);
}
