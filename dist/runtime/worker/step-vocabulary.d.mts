export const REQUIRED_CYCLE_STEPS: readonly string[];
export const WORKER_STEP_LABELS: Readonly<{
    sent: "Sent messages";
    "discover-hot": "Active conversation refresh";
    "received-hot": "Active conversation messages";
    "discover-catchup": "Initial conversation discovery";
    "discover-reconcile": "Conversation list review";
    "received-fair": "Other conversation messages";
    history: "Stored message history review";
    retention: "History cleanup";
    "received-catchup": "Conversation history";
}>;
export const WORKER_STEPS: readonly string[];
