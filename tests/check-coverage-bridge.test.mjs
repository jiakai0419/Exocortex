import assert from "node:assert/strict";
import test from "node:test";
import { inspectCoverage } from "../src/diagnostics/coverage-bridge.mjs";
import { fixture, options, at } from "./helpers/check-fixture.mjs";
const value = (ok) => ({ ok, database_checks_ok: true, checked_at: new Date(at).toISOString(), coverage: { initial_baseline_complete: ok, target_ms: at }, private: "PRIVATE_COVERAGE_SENTINEL" });
for (const ok of [true, false]) test(`coverage sole bridge distinguishes valid ${ok ? "complete" : "incomplete"} evidence`, () => {
  const f = fixture(); let call;
  const result = inspectCoverage({ ...options(), throughMs: at }, f.context, { spawnSync: (cmd, args, opts) => { call = { cmd, args, opts }; return { status: ok ? 0 : 2, stdout: JSON.stringify(value(ok)) }; } });
  assert.equal(result.ok, ok); assert.equal(call.cmd, "python3"); assert.deepEqual(call.args.slice(-4), ["--db", options().db, "--target", new Date(at).toISOString()]);
  assert.match(call.args[0], /tools\/coverage\/lark-im-coverage-check.py$/); assert.equal(call.opts.timeout, 120000); assert.equal(call.opts.killSignal, "SIGKILL");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COVERAGE/);
});
for (const result of [
  { status: 2, stdout: JSON.stringify({ ...value(false), error: "readonly_inspection_failed" }) },
  { status: 2, stdout: JSON.stringify(value(true)) }, { status: 0, stdout: JSON.stringify(value(false)) },
  { status: 1, stdout: JSON.stringify(value(true)) }, { status: null, signal: "SIGKILL", stdout: JSON.stringify(value(true)) },
  { status: 0, error: new Error("PRIVATE_ERROR"), stdout: JSON.stringify(value(true)) }, { status: 0, stdout: "PRIVATE_BAD_JSON" },
  { status: 2, stdout: "{}" }, { status: 0, stdout: "[]" },
]) test(`coverage execution contract rejects misleading process/JSON ${JSON.stringify(result)}`, () => {
  const f = fixture(); assert.throws(() => inspectCoverage({ ...options(), throughMs: at }, f.context, { spawnSync: () => result }), (error) => !/PRIVATE/.test(error.message));
});

// The old doctor no longer has JSON child commands. The actual remaining
// process boundaries (coverage Python and remote CLI) keep these counterexamples.
import { runLark } from "../src/diagnostics/lark-im-lag-report.mjs";
for (const failure of [{ status: 1 }, { status: 2 }, { status: null, signal: "SIGKILL" }, { status: 0, error: new Error("PRIVATE_FAILURE") }, { status: 0, signal: "SIGTERM" }]) {
  test(`live transport rejects successful-looking stdout after ${JSON.stringify(failure)}`, () => {
    assert.throws(() => runLark(["synthetic"], { env: { LARK_CLI: "/tmp/invented-cli" }, spawnSync: () => ({ status: 0, stdout: '{"ok":true,"open_id":"ou_invented"}', stderr: "PRIVATE_SENTINEL", ...failure }) }), (error) => !/PRIVATE|ou_invented/.test(error.message));
  });
}
for (const [stderr, message] of [["keychain not initialized\nPRIVATE_SENTINEL", /keychain not initialized/], ['{"error":{"code":231203}} PRIVATE_SENTINEL', /reason=restricted_mode code=231203/]]) {
  test(`live transport retains finite diagnostic classification ${message}`, () => {
    assert.throws(() => runLark([], { spawnSync: () => ({ status: 1, stdout: "", stderr }) }), (error) => message.test(error.message) && !/PRIVATE_SENTINEL/.test(error.message));
  });
}
test("live transport forwards invocation environment and preserves its existing bounded request budget", () => {
  const env = { LARK_CLI: "/tmp/invented-cli", PATH: "/tmp/invented-bin" }; let call;
  assert.deepEqual(runLark(["synthetic"], { env, spawnSync: (cmd, args, options) => { call = { cmd, args, options }; return { status: 0, stdout: '{"ok":true}', stderr: "" }; } }), { ok: true });
  assert.equal(call.cmd, env.LARK_CLI); assert.equal(call.options.env, env); assert.equal(call.options.timeout, 120000); assert.equal(call.options.maxBuffer, 100 * 1024 * 1024); assert.equal(call.options.killSignal, "SIGKILL");
});
