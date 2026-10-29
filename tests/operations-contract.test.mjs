import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../bin/exocortex.mjs";
import { COMMANDS, commandCatalog, parseRouteOptions } from "../src/cli/registry.mjs";
import { runCheckCommand } from "../src/cli/check-command.mjs";
import * as commandDocs from "../src/development/command-docs.mjs";
import * as store from "../dist/storage/sqlite/ingestion-store.js";
import { chatScopeId } from "../src/adapters/lark-im/core.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/message-record.mjs";
import { normalizeApiMessage } from "../src/adapters/lark-im/raw-message.mjs";
import { at, fixture as checkFixture, live, liveResult } from "./helpers/check-fixture.mjs";

for (const file of ["README.md", "docs/cli-migration.md"]) test(`${file} public route count matches the catalog`, () => {
  const catalog = commandCatalog();
  assert.match(readFileSync(file, "utf8"), new RegExp(`${catalog.groups.length} 个顶层命令、${catalog.route_count} 个执行路由`));
});

test("terminal experience maintenance count matches the catalog", () => {
  const count = COMMANDS.filter(({ group }) => group === "maintenance").length;
  assert.ok(readFileSync("docs/terminal-experience.md", "utf8").includes(`\`maintenance\` 的 ${count} 种维护动作`));
});

test("operations maintenance safety contract is generated and does not imply a universal apply gate", () => {
  const document = readFileSync("docs/operations.md", "utf8");
  const section = document.split("### 业务数据维护\n")[1].split("## Public-Safe Command Output")[0];
  assert.doesNotMatch(section, /其他维护动词默认预览/);
  const begin = "<!-- BEGIN GENERATED maintenance-effects -->\n", end = "\n<!-- END GENERATED maintenance-effects -->";
  assert.equal(section.split(begin).length, 2, "operations must include the generated maintenance safety contract");
  assert.equal(section.split(end).length, 2);
  assert.equal(section.split(begin)[1].split(end)[0], commandDocs.maintenanceEffectDocumentation(commandCatalog()));
  // Pin the independently observed history boundary, not just renderer/catalog agreement.
  assert.ok(section.includes("| `maintenance history` | local-read, remote-read, database-write | 不支持 | — |"));
  assert.match(section, /只有 `prune-runs` 和 `compact` 支持加 `--apply`/);
});

test("maintenance catalog distinguishes database writes, file writes and supported apply gates", () => {
  const commands = COMMANDS.filter(({ group }) => group === "maintenance");
  assert.deepEqual(commands.filter(({ effects }) => effects.includes("database-write")).map(({ id }) => id),
    ["maintenance.init", "maintenance.history", "maintenance.resources"]);
  assert.deepEqual(commands.filter(({ options }) => options.some(({ flag }) => flag === "--apply")).map(({ id }) => id),
    ["maintenance.enrich", "maintenance.repair", "maintenance.replay", "maintenance.prune-runs", "maintenance.compact"]);
  const preview = commands.find(({ id }) => id === "maintenance.preview");
  assert.ok(preview.effects.includes("private-review-file-write"));
  assert.ok(preview.effects.includes("private-progress-file-write"));
  for (const id of ["maintenance.enrich", "maintenance.replay"]) {
    const entry = commands.find(command => command.id === id);
    assert.ok(entry.modes.some(({ when, effects }) => when === "--review-out" && effects.includes("private-review-file-write")));
  }
  assert.ok(commands.find(({ id }) => id === "maintenance.replay").effects.includes("remote-read"));
  const enrich = commands.find(({ id }) => id === "maintenance.enrich");
  assert.deepEqual(enrich.effects, ["local-read"], "resource preview must not imply remote reads");
  assert.deepEqual(enrich.modes.find(({ when }) => when === "--target records|scopes|recipients").effects, ["remote-read"]);
  assert.deepEqual(enrich.modes.find(({ when }) => when === "--apply with --target records|scopes|recipients").effects, ["database-write"]);
  assert.deepEqual(enrich.modes.find(({ when }) => when === "--apply with --target resources").effects, ["remote-read", "private-resource-write"]);
  assert.ok(!enrich.modes.some(({ when }) => when === "--apply"), "writes require explicit target conditions");
  assert.throws(() => parseRouteOptions("maintenance.history", ["--db", "/tmp/synthetic-not-opened.sqlite", "--apply"]), /unknown/i);
});

test("real CLI history writes a synthetic record and scan checkpoint without apply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-operations-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, "invented.sqlite"), q = store.quoteSql;
  const start = Date.parse("2026-02-01T00:00:00Z");
  const self = { open_id: "ou_synthetic_doc_contract_self", name: "Synthetic Self" };
  const chat = "oc_synthetic_doc_contract_chat", scopeId = chatScopeId(chat);
  const original = { message_id: "om_synthetic_doc_contract_message", chat_id: chat,
    msg_type: "text", create_time: String(start + 1000), update_time: String(start + 2000),
    sender: { id: self.open_id, id_type: "open_id", sender_type: "user" },
    body: { content: '{"text":"Synthetic original"}' } };
  const changed = { ...original, update_time: String(start + 3000), body: { content: '{"text":"Synthetic newer edit"}' } };
  store.ensureInitialized(db);
  store.sqliteExec(db, `UPDATE sources SET config_json=${q(JSON.stringify({ initial_sync_start_ms: start,
    initial_account_binding: { kind: store.INITIAL_ACCOUNT_KIND,
      account_key: createHash("sha256").update(`lark.im\0${self.open_id}`).digest("hex"),
      reserved_at: "2026-02-01T00:00:00.000Z", confirmed_at: "2026-02-01T00:00:00.000Z" } }))} WHERE id='lark.im';
    INSERT INTO sync_scopes(id,source_id,name,config_json) VALUES(${q(scopeId)},'lark.im','Synthetic documentation scope',
      ${q(JSON.stringify({ chat_id: chat, chat_type: "group" }))});`);
  const scope = store.readScope(db, scopeId), run = store.createRun(db, scope);
  const record = recordFromMessage(normalizeApiMessage(original), scopeId, "received", { self },
    { chat_id: chat, chat_type: "group" });
  store.succeedRecordRun(db, scope, run, [record], 1, { created_at_ms: start + 60000 }, {});
  const snapshot = () => ({ versions: store.sqliteQuery(db, "SELECT external_version FROM records"),
    history_progress_rows: store.sqliteQuery(db, "SELECT count(*) n FROM lark_im_history_progress")[0].n });
  const before = snapshot();
  let stdout = "", stderr = "", profileCalls = 0, messageCalls = 0;
  const code = await runCli(["maintenance", "history", "--db", db, "--format", "json"], {
    root: dir, cwd: dir, env: {}, stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    deps: {
      createRequestSession: () => ({ runLark: () => assert.fail("Real transport is forbidden"),
        assertReady() {}, summary: () => ({ cli_attempts: 2, max_cli_attempts: 4, max_seconds: 30, elapsed_ms: 1 }) }),
      getSelfProfile: () => { profileCalls++; return self; },
      fetchChatMessageList: () => { messageCalls++; return { messages: [normalizeApiMessage(changed)], pages: 1 }; },
    },
  });
  const after = snapshot(), report = JSON.parse(stdout);
  assert.equal(code, 0, stdout + stderr);
  assert.equal(report.updated, 1);
  assert.deepEqual(before, { versions: [{ external_version: String(start + 2000) }], history_progress_rows: 0 });
  assert.deepEqual(after, { versions: [{ external_version: String(start + 3000) }], history_progress_rows: 1 });
  assert.ok(profileCalls > 0 && messageCalls > 0);
  t.diagnostic(JSON.stringify({ argv: "maintenance history --db <synthetic.sqlite> --format json", exit_code: code,
    before, after, fake_calls: { profiles: profileCalls, messages: messageCalls } }));
});

test("check unsafe-details documentation promises compatibility labeling without private sample fields", () => {
  const description = COMMANDS.find(({ id }) => id === "check").options.find(({ flag }) => flag === "--unsafe-details").description;
  assert.match(description, /Compatibility privacy label only/);
  assert.match(description, /v3 keeps the public-safe projection and adds no private sample fields/);
  const operations = readFileSync("docs/operations.md", "utf8");
  assert.match(operations, /`check --live --unsafe-details`.*兼容.*private.*v3.*脱敏.*不新增私有详情/);
  assert.match(readFileSync("README.md", "utf8"), /`check --live --unsafe-details`.*兼容.*v3.*不新增私有详情/);
});

test("CLI check unsafe-details changes the privacy label but preserves the safe v3 projection", async () => {
  const marker = "PRIVATE_SYNTHETIC_OPERATIONS_SENTINEL";
  const outputs = [];
  for (const unsafe of [false, true]) {
    const f = checkFixture();
    f.deps.collectRemoteSample = () => liveResult(live({ latest_remote: { body: marker, message_id: marker },
      missing: [{ body: marker }], probe_errors: [{ error: marker }] }));
    let stdout = "", stderr = "";
    const code = await runCli(["check", "--live", "--format", "json", ...(unsafe ? ["--unsafe-details"] : [])], {
      root: "/tmp/synthetic-not-opened-root", cwd: "/tmp/synthetic-not-opened-cwd", env: {}, now: () => at,
      stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
      loadCommand: async group => {
        assert.equal(group, "check");
        return { runCheckCommand: (options, context) => runCheckCommand(options, context, f.deps) };
      },
    });
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stdout, new RegExp(marker));
    const result = JSON.parse(stdout);
    assert.equal(result.privacy, unsafe ? "private" : "public-safe");
    assert.equal(result.checks.live.evidence.schema_version, 3);
    assert.deepEqual(f.calls, ["database", "sync", "quality"]);
    const { privacy, ...projection } = result;
    outputs.push(projection);
  }
  assert.deepEqual(outputs[1], outputs[0]);
});
