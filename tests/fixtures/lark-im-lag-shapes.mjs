// Constructed from scratch for unit tests; no captured or anonymized runtime inputs.
const SELF_OPEN_ID = "ou_unit_lag_self";
const HOT_CHATS = ["alpha", "beta"].map((key, index) => ({
  chat_id: `oc_unit_lag_${key}`,
  chat_name: `Synthetic Room ${index + 1}`,
  chat_type: index === 0 ? "group" : "thread",
}));
function message(id, offsetSeconds, chatIndex, sender, msgType, content) {
  return {
    message_id: id,
    create_time: String(1000000000 + offsetSeconds),
    msg_type: msgType,
    sender,
    ...HOT_CHATS[chatIndex],
    content,
  };
}
const REMOTE_MESSAGES = [
  message("om_unit_lag_text", 0, 0,
    { id: "ou_unit_lag_peer", id_type: "open_id", sender_type: "user", name: "Synthetic Sender" },
    "text", { text: "Unit test text" }),
  message("om_unit_lag_card", 60, 1,
    { id: "cli_unit_lag_app", id_type: "app_id", sender_type: "app", display_name: "Synthetic App" },
    "interactive", { title: "Unit test card", elements: [{ tag: "markdown", content: "Unit test markdown" }] }),
  message("om_unit_lag_self", 120, 0,
    { id: SELF_OPEN_ID, id_type: "open_id", sender_type: "user", name: "Synthetic Self" },
    "text", { text: "Self message for exclusion test" }),
];
export { HOT_CHATS, REMOTE_MESSAGES, SELF_OPEN_ID };
