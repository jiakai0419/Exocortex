import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  liveProbeCacheFromReport,
  readLiveProbeCache,
  writeLiveProbeCache,
} from "../src/diagnostics/live-probe-cache.mjs";

test("live probe cache keeps only redacted summary fields", () => {
  const cache = liveProbeCacheFromReport({
    checked_at: "2026-06-21T00:00:00.000Z",
    live: {
      status: "delayed",
      ok: false,
      missing_count: 2,
      lag_ms: 42000,
      reason: "remote_missing",
      missing: [{ message_id: "om_real", body: "private body", chat_name: "private chat" }],
      stderr: "private stderr",
    },
  });

  assert.deepEqual(cache, {
    kind: "lark_im_live_probe_cache/v1",
    checked_at: "2026-06-21T00:00:00.000Z",
    status: "delayed",
    ok: false,
    missing_count: 2,
    lag_ms: 42000,
    reason: "remote_missing",
  });
});

test("live probe cache read/write uses injected filesystem deps", () => {
  const writes = new Map();
  const dirs = [];
  const modes = [];
  const report = {
    checked_at: "2026-06-21T00:00:00.000Z",
    live: { status: "healthy", ok: true, missing_count: 0, lag_ms: 0 },
  };
  const deps = {
    mkdirSync: (path, options) => dirs.push([path, options]),
    chmodSync: (path, mode) => modes.push([path, mode]),
    writeFileSync: (path, data, options) => {
      modes.push([path, options.mode]);
      writes.set(path, data);
    },
    existsSync: (path) => writes.has(path),
    readFileSync: (path) => writes.get(path),
  };

  const written = writeLiveProbeCache("logs/lark-im/live-probe.json", report, deps);
  const read = readLiveProbeCache("logs/lark-im/live-probe.json", deps);

  assert.equal(dirs[0][0], "logs/lark-im");
  assert.equal(dirs[0][1].recursive, true);
  assert.equal(dirs[0][1].mode, 0o700);
  assert.deepEqual(modes.slice(0, 3), [
    ["logs/lark-im", 0o700],
    ["logs/lark-im/live-probe.json", 0o600],
    ["logs/lark-im/live-probe.json", 0o600],
  ]);
  assert.deepEqual(read, written);
});

test("live probe cache enforces private modes for new and existing paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "exocortex-live-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "logs", "live-probe.json");
  const report = {
    checked_at: "2026-06-21T00:00:00.000Z",
    live: { status: "healthy", ok: true, missing_count: 0, lag_ms: 0 },
  };

  writeLiveProbeCache(path, report);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);

  chmodSync(dirname(path), 0o755);
  chmodSync(path, 0o644);
  assert.ok(readLiveProbeCache(path));
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("live probe cache ignores missing, invalid, and wrong-kind files", () => {
  assert.equal(readLiveProbeCache("missing.json", { existsSync: () => false }), null);
  assert.equal(
    readLiveProbeCache("bad.json", {
      existsSync: () => true,
      readFileSync: () => "{bad",
    }),
    null,
  );
  assert.equal(
    readLiveProbeCache("wrong.json", {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ kind: "other" }),
    }),
    null,
  );
});
