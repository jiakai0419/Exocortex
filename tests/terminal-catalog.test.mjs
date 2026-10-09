import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { COMMANDS, GROUPS, commandCatalog, renderHelp } from "../src/cli/registry.mjs";
import { commandDocumentation } from "../src/development/command-docs.mjs";

test("checked-in route and option documentation exactly matches the public machine catalog", () => {
  const catalog = JSON.parse(renderHelp({ all: true, options: { format: "json" } }));
  const document = readFileSync("docs/commands.md", "utf8");
  assert.ok(document.includes(`**${catalog.groups.length} 个顶层命令、${catalog.route_count} 个执行路由**`));
  for (const [name, expected] of Object.entries(commandDocumentation(catalog))) {
    const begin = `<!-- BEGIN GENERATED ${name} -->\n`, end = `\n<!-- END GENERATED ${name} -->`;
    assert.equal(document.split(begin).length, 2, `${name} start marker`);
    assert.equal(document.split(end).length, 2, `${name} end marker`);
    assert.equal(document.split(begin)[1].split(end)[0], expected, `Regenerate ${name} from commandDocumentation(commandCatalog()).`);
  }
});

test("public catalog contains exactly six groups and seventeen canonical routes", () => {
  assert.deepEqual(GROUPS.map(({id}) => id), ["messages", "status", "check", "sync", "service", "maintenance"]);
  assert.deepEqual(COMMANDS.map(({id}) => id), ["messages", "status", "check", "sync", "service.install", "service.start", "service.stop", "service.restart", "service.uninstall", "maintenance.init", "maintenance.backup", "maintenance.enrich", "maintenance.preview", "maintenance.repair", "maintenance.replay", "maintenance.prune-runs", "maintenance.compact"]);
  assert.equal(new Set(COMMANDS.map(({id}) => id)).size, 17);
});

test("coverage remains an explicit fixed-endpoint check with one internal Python implementation", () => {
  const check = COMMANDS.find(({id}) => id === "check");
  assert.ok(check.options.some(({flag}) => flag === "--through"));
  assert.ok(existsSync("tools/coverage/lark-im-coverage-check.py"));
  assert.ok(!GROUPS.some(({id}) => /coverage|probe|worker/.test(id)));
});

test("development verification uses the one developer entry and retains all required checks", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  assert.equal(scripts.verify, "node tools/verify.mjs");
  assert.equal(scripts.help, "node bin/exocortex.mjs --help");
  assert.equal(scripts.exo, "node bin/exocortex.mjs");
  assert.equal(scripts["build:check"], "node tools/verify.mjs --generated-only");
  for (const name of ["build", "typecheck", "check", "test", "build:check", "verify"]) {
    assert.doesNotMatch(scripts[name], /maintenance|service|launchctl/);
  }
});

test("catalog owns complete option metadata and explicit effects and privacy modes", () => {
  const catalog = commandCatalog();
  for (const entry of catalog.commands) {
    assert.ok(GROUPS.some(({id}) => id === entry.group));
    assert.ok(entry.summary && entry.example && entry.effects.length && entry.privacy);
    assert.equal(new Set(entry.options.map(({flag}) => flag)).size, entry.options.length);
    assert.ok(entry.options.every(({flag,key,type,description}) => flag.startsWith("--") && key && type && description));
  }
  assert.equal(catalog.commands.find(({id}) => id === "messages").privacy, "private");
  assert.ok(catalog.commands.find(({id}) => id === "status").modes.some(({when,privacy}) => when === "--logs" && privacy === "private"));
});

test("daily help leads with reading and status while research and worker remain internal", () => {
  const text = renderHelp();
  assert.ok(text.indexOf("messages") < text.indexOf("check --help"));
  assert.ok(text.indexOf("status") < text.indexOf("check --help"));
  assert.doesNotMatch(text, /probe|worker|tools\//);
  const json = JSON.parse(renderHelp({all:true,options:{format:"json"}}));
  assert.equal(json.commands.length,17);
  assert.ok(json.commands.find(({id}) => id === "check").options.some(({flag}) => flag === "--write-live-cache"));
});
