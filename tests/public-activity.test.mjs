import assert from "node:assert/strict";
import test from "node:test";
import { buildServiceOverview } from "../src/diagnostics/lark-im-service-report.mjs";
import { publicActivity, activityReasonText } from "../src/diagnostics/public-activity.mjs";

const now = Date.parse("2034-06-07T08:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const key = "b".repeat(64);
const privateMarker = "SYNTHETIC_PRIVATE_ACTIVITY_DETAIL";
const phase = (overrides = {}) => ({ type: "lark_im_worker_activity", version: 1, role: "worker", pid: 7111,
  instance_id: "invented-worker", parent_instance: null, database_key: key, process_started_at_ms: now - 60000,
  phase: "step", cycle: 3, step: "sent", updated_at: iso(now - 1000), valid_until: iso(now + 4000), ...overrides });
const process = (overrides = {}) => ({ state: "alive", started_at_ms: now - 60000, ppid: 7000, ...overrides });
function activity(events = [], overrides = {}) {
  return buildServiceOverview({ launchd: { loaded: true, state: "running", pid: 7111, ...overrides.launchd },
    syncStatus: overrides.syncStatus === undefined ? { health: "ok", locks: [] } : overrides.syncStatus, workerSummary: {}, nowMs: now,
    activityEvidence: { events, database_key: key, database_identity_stable: true, integrity: true, observed_at: iso(now),
      processes: new Map(events.map((event) => [event.pid, process()])), ...overrides.evidence },
  }).activity;
}

for (const current of ["cycle", "between_steps", "step", "waiting"]) {
  test(`public worker ${current} keeps its finite source and phase`, () => {
    const raw = activity([phase({ phase: current, step: current === "step" ? "sent" : null })]);
    const value = publicActivity(raw);
    assert.equal(value.state, current === "waiting" ? "waiting" : "syncing");
    assert.equal(value.source, "worker"); assert.equal(value.evidence, "verified_worker_phase"); assert.equal(value.phase, current);
    assert.equal(value.reason, current === "waiting" ? "worker_waiting" : "worker_phase_observed");
    assert.equal(value.observed_at, iso(now)); assert.equal(value.valid_until, iso(now + 4000));
    assert.equal(raw.source, value.source, "source is explicit domain evidence");
  });
}
test("independent foreground and stopped service retain distinct public categories", () => {
  const foreground = publicActivity(activity([phase({ role: "sync", phase: "sync", pid: 7222, instance_id: "invented-foreground", step: null })], { launchd: { loaded: false, pid: null } }));
  assert.equal(foreground.state, "syncing"); assert.equal(foreground.source, "foreground"); assert.equal(foreground.phase, "sync");
  assert.equal(foreground.evidence, "recent_foreground_phase"); assert.equal(foreground.reason, "foreground_sync_observed");
  assert.equal(activityReasonText(foreground.reason), "independent foreground sync observed");
  const stopped = publicActivity(activity([], { launchd: { loaded: false, pid: null } }));
  assert.equal(stopped.status, "idle"); assert.equal(stopped.state, "stopped"); assert.equal(stopped.source, "none");
  assert.equal(stopped.phase, "stopped"); assert.equal(stopped.reason, "no_current_sync_observed");
});

const cases = [
  ["sync_status_unavailable", () => activity([], { syncStatus: null })],
  ["database_identity_unavailable", () => activity([phase()], { evidence: { database_identity_stable: false } })],
  ["phase_evidence_incomplete", () => activity([phase()], { evidence: { truncated: true } })],
  ["phase_evidence_incomplete", () => activity([{ type: "lark_im_worker_activity" }])],
  ["current_phase_unavailable", () => activity([phase({ valid_until: iso(now) })])],
  ["current_phase_unavailable", () => activity([phase()], { evidence: { processes: new Map([[7111, { state: "unknown" }]]) } })],
  ["owner_evidence_unavailable", () => activity([], { syncStatus: { health: "ok", locks: [{ owner_state: "unknown", owner_observed_at: iso(now) }] } })],
  ["worker_phase_unavailable", () => activity([])],
  ["service_state_unavailable", () => activity([], { launchd: { loaded: null, state: null, pid: null } })],
  ["worker_child_conflict", () => activity([phase({ phase: "waiting", step: null }), phase({ role: "sync", phase: "sync", pid: 7222, instance_id: "invented-child", parent_instance: "invented-worker", step: null })],
    { evidence: { processes: new Map([[7111, process()], [7222, process({ ppid: 7111 })]]) } })],
  ["worker_parent_unverified", () => activity([phase({ role: "sync", phase: "sync", pid: 7222, instance_id: "invented-child", parent_instance: "invented-unobserved-worker", step: null })])],
  ["foreground_parent_unavailable", () => activity([phase({ role: "sync", phase: "sync", pid: 7222, instance_id: "invented-foreground", step: null })],
    { evidence: { processes: new Map([[7222, process({ ppid: null })]]) } })],
];
for (const [reason, collect] of cases) test(`unknown activity explains ${reason} without promoting source or phase`, () => {
  const raw = collect(); const value = publicActivity(raw);
  assert.equal(value.state, "unknown"); assert.equal(value.status, "unknown"); assert.equal(value.reason, reason);
  assert.equal(value.source, "unknown"); assert.equal(value.phase, "unknown"); assert.equal(value.evidence, "unavailable");
  assert.notEqual(activityReasonText(reason), "activity evidence unavailable");
});

test("public activity never reads internal details or copies identities, unknown enums or arbitrary reasons", () => {
  const raw = activity([phase()]);
  const value = publicActivity({ ...raw, detail: privateMarker, pid: 7111, instance_id: privateMarker, database_key: key, path: privateMarker });
  assert.equal(value.state, "syncing"); assert.doesNotMatch(JSON.stringify(value), new RegExp(`${privateMarker}|7111|${key}`));
  assert.deepEqual(Object.keys(value).sort(), ["status", "state", "evidence", "source", "phase", "reason", "observed_at", "updated_at", "valid_until"].sort());
  for (const field of ["reason", "source", "phase", "evidence", "state"]) {
    const invalid = publicActivity({ ...raw, [field]: privateMarker, detail: "foreground sync observed" });
    assert.equal(invalid.state, "unknown", field); assert.equal(invalid.reason, "activity_evidence_unavailable", field);
    assert.doesNotMatch(JSON.stringify(invalid), new RegExp(privateMarker));
  }
  assert.equal(activityReasonText(privateMarker), "activity evidence unavailable");
  assert.equal(activityReasonText("constructor"), "activity evidence unavailable");
  assert.equal(publicActivity({ state: "unknown", reason: privateMarker, detail: "worker sync observed" }).reason, "activity_evidence_unavailable");
});
