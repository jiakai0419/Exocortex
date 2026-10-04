// @ts-check
import { publicTimestamp } from "./public-safe.mjs";

/** Finite explanations selected by the activity decision tree, never parsed
 * from an internal detail string or a remote/process error. */
const STEPS = new Set(["sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair", "retention", "all", "discover", "received", "details"]);
const REASONS = Object.freeze({
  activity_evidence_unavailable: "activity evidence unavailable",
  sync_status_unavailable: "sync status unavailable",
  database_identity_unavailable: "database identity changed or unavailable",
  phase_evidence_incomplete: "current phase evidence is incomplete",
  worker_child_conflict: "worker and child phases disagree",
  worker_parent_unverified: "worker child has no verified parent phase",
  foreground_parent_unavailable: "foreground process parent is unavailable",
  foreground_sync_observed: "independent foreground sync observed",
  worker_phase_observed: "worker sync observed",
  current_phase_unavailable: "current phase or process identity is unavailable",
  owner_evidence_unavailable: "scope owner evidence is unavailable",
  worker_waiting: "worker is between cycles",
  no_current_sync_observed: "no current local sync process observed",
  worker_phase_unavailable: "current worker phase is unavailable",
  service_state_unavailable: "background service state is unavailable",
});

/** @param {unknown} reason */
function activityReasonText(reason) {
  return typeof reason === "string" && Object.hasOwn(REASONS, reason)
    ? REASONS[reason] : REASONS.activity_evidence_unavailable;
}

/** Preserve the established state while adding only a finite explanation.
 * Unknown or contradictory categories cannot become a positive observation.
 * @param {Record<string, any> | null | undefined} activity */
function publicActivity(activity) {
  let reason = typeof activity?.reason === "string" && Object.hasOwn(REASONS, activity.reason)
    ? activity.reason : "activity_evidence_unavailable";
  let state = "unknown";
  let phase = "unknown";
  let source = "unknown";
  let evidence = "unavailable";
  if (reason === "foreground_sync_observed" && activity?.state === "syncing" && activity.phase === "sync"
      && activity.source === "foreground" && activity.evidence === "recent_foreground_phase") {
    state = "syncing"; phase = "sync"; source = "foreground"; evidence = "recent_foreground_phase";
  } else if (reason === "worker_phase_observed" && activity?.state === "syncing" && ["cycle", "between_steps", "step"].includes(activity.phase)
      && activity.source === "worker" && activity.evidence === "verified_worker_phase") {
    state = "syncing"; phase = activity.phase; source = "worker"; evidence = "verified_worker_phase";
  } else if (reason === "worker_waiting" && activity?.state === "waiting" && activity.phase === "waiting"
      && activity.source === "worker" && activity.evidence === "verified_worker_phase") {
    state = "waiting"; phase = "waiting"; source = "worker"; evidence = "verified_worker_phase";
  } else if (reason === "no_current_sync_observed" && activity?.state === "stopped" && activity.phase === "stopped"
      && activity.source === "none" && activity.evidence === "no_current_process_observed") {
    state = "stopped"; phase = "stopped"; source = "none"; evidence = "no_current_process_observed";
  } else if (activity?.state !== "unknown" || ["foreground_sync_observed", "worker_phase_observed", "worker_waiting", "no_current_sync_observed"].includes(reason)) {
    reason = "activity_evidence_unavailable";
  }
  return { status: state === "waiting" || state === "stopped" ? "idle" : state,
    state, evidence, source, phase, reason,
    step: state === "syncing" && ["step", "sync"].includes(phase) && STEPS.has(activity?.step) ? activity?.step : null,
    observed_at: publicTimestamp(activity?.observed_at), updated_at: publicTimestamp(activity?.updated_at),
    valid_until: publicTimestamp(activity?.valid_until) };
}

export { publicActivity, activityReasonText };
