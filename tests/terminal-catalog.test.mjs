import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { COMMANDS, GROUPS, filteredCommands } from "../scripts/help.mjs";

test("terminal catalog lists every script command", () => {
  const scripts = readdirSync("scripts")
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".py"))
    .map((name) => `scripts/${name}`)
    .sort();
  const catalogedScripts = COMMANDS.filter((item) => item.file.startsWith("scripts/"))
    .map((item) => item.file)
    .sort();

  assert.deepEqual(catalogedScripts, scripts);
});

test("coverage help names Python and an explicit endpoint without adding a daily command", () => {
  const entries = filteredCommands({ all: false, group: null, command: "coverage-check" });
  assert.equal(entries.length, 1);
  assert.match(entries[0].command, /^python3 -B .* --target /);
  assert.match(entries[0].summary, /without writing/);
  assert.notEqual(entries[0].core, true);
});

test("terminal catalog entries have valid groups and examples", () => {
  const groupIds = new Set(GROUPS.map((group) => group.id));
  const commands = new Set();

  for (const item of COMMANDS) {
    assert.ok(groupIds.has(item.group), `${item.command} has unknown group`);
    assert.ok(item.command, "command is required");
    assert.ok(item.file, `${item.command} file is required`);
    assert.ok(item.summary, `${item.command} summary is required`);
    assert.ok(Array.isArray(item.examples) && item.examples.length > 0, `${item.command} needs examples`);
    assert.equal(commands.has(item.command), false, `${item.command} is duplicated`);
    commands.add(item.command);
  }
});

test("default terminal help shows only the core daily commands", () => {
  const commands = filteredCommands({ all: false, group: null, command: null }).map((item) => item.command);

  assert.deepEqual(commands, [
    "npm run help",
    "node scripts/messages.mjs --limit 20",
    "node scripts/lark-im-service.mjs status",
  ]);
});
