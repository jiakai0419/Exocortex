import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveProbeContext, readLiveProbeCache } from "../src/diagnostics/live-probe-cache.mjs";

const checkedAt = "2030-01-02T12:00:00.000Z";
const legacy = (version) => ({ kind: `lark_im_live_probe_cache/v${version}`, checked_at: checkedAt,
  status: "delayed", ok: false, missing_count: 2, lag_ms: 42000, reason: "remote_missing",
  ...(version === 2 ? { context: { database_key: "a".repeat(64), source_id: "lark.im", auth_identity_verified: false },
    scope: "recent_hot_messages", expires_at: "2030-01-02T12:05:00.000Z",
    window: { start: "2030-01-02T00:00:00.000Z", end: checkedAt },
    sample: { hot_chats_requested: 2, hot_chats_found: 2, messages_per_chat: 20,
      remote_messages_checked: 3, unsupported_chats: 0, probe_errors: 0 } } : {}) });

for (const version of [1, 2]) test(`legacy v${version} cache remains readable and drops unrecognized private fields`, () => {
  const original = legacy(version);
  const input = { ...original, missing: [{ message_id: "om_invented_private", body: "PRIVATE_BODY" }], stderr: "PRIVATE_STDERR" };
  const result = readLiveProbeCache("/synthetic/cache.json", {
    existsSync: () => true, readFileSync: () => JSON.stringify(input),
  });
  assert.deepEqual(result, original);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|om_invented/);
});

test("reading legacy cache and its file context preserves existing permissions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "exocortex-live-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "live-probe.json");
  writeFileSync(path, JSON.stringify(legacy(2)), { mode: 0o600 });
  chmodSync(root, 0o755); chmodSync(path, 0o644);
  assert.deepEqual(readLiveProbeCache(path), legacy(2));
  const context = liveProbeContext(path);
  assert.match(context.database_key, /^[a-f0-9]{64}$/);
  assert.equal(context.auth_identity_verified, false);
  assert.equal(statSync(root).mode & 0o777, 0o755);
  assert.equal(statSync(path).mode & 0o777, 0o644);
});

test("live probe cache ignores missing, invalid, and wrong-kind files", () => {
  assert.equal(readLiveProbeCache("missing.json", { existsSync: () => false }), null);
  for (const text of ["{bad", JSON.stringify({ kind: "other" })]) {
    assert.equal(readLiveProbeCache("/synthetic/cache.json", { existsSync: () => true, readFileSync: () => text }), null);
  }
});
