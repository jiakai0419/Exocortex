// @ts-check
// The cycle producer and public diagnostics share the same finite vocabulary.
export const REQUIRED_CYCLE_STEPS = Object.freeze([
  "sent", "discover-hot", "received-hot", "discover-catchup", "discover-reconcile", "received-fair",
]);
export const WORKER_STEP_LABELS = Object.freeze({
  sent: "Sent messages", "discover-hot": "Active conversation refresh", "received-hot": "Active conversation messages",
  "discover-catchup": "Initial conversation discovery", "discover-reconcile": "Conversation list review",
  "received-fair": "Other conversation messages", history: "Stored message history review",
  retention: "History cleanup", "received-catchup": "Conversation history",
});
export const WORKER_STEPS = Object.freeze(Object.keys(WORKER_STEP_LABELS));
