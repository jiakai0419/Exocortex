// Anonymized shape fixtures:
// - Field names mirror lark-cli IM responses.
// - Values are placeholders, not copied real IDs, names, chat names, links, or message bodies.

const SELF_OPEN_ID = "ou_shape_self";

const HOT_CHATS = [
  {
    chat_id: "oc_shape_hot_group_001",
    chat_name: "Shape Group A",
    chat_type: "group",
  },
  {
    chat_id: "oc_shape_hot_group_002",
    chat_name: "Shape Group B",
    chat_type: "thread",
  },
];

const REMOTE_MESSAGES = [
  {
    message_id: "om_shape_remote_text_001",
    create_time: "1800000000",
    msg_type: "text",
    sender: {
      id: "ou_shape_sender_001",
      id_type: "open_id",
      sender_type: "user",
      name: "Shape Person A",
    },
    chat_id: "oc_shape_hot_group_001",
    chat_type: "group",
    chat_name: "Shape Group A",
    content: {
      text: "<redacted text body>",
    },
  },
  {
    message_id: "om_shape_remote_card_002",
    create_time: "1800000060",
    msg_type: "interactive",
    sender: {
      id: "cli_shape_app_001",
      id_type: "app_id",
      sender_type: "app",
      display_name: "Shape App",
    },
    chat_id: "oc_shape_hot_group_002",
    chat_type: "thread",
    chat_name: "Shape Group B",
    content: {
      title: "<redacted card title>",
      elements: [{ tag: "markdown", content: "<redacted markdown body>" }],
    },
  },
  {
    message_id: "om_shape_self_003",
    create_time: "1800000120",
    msg_type: "text",
    sender: {
      id: SELF_OPEN_ID,
      id_type: "open_id",
      sender_type: "user",
      name: "Shape Self",
    },
    chat_id: "oc_shape_hot_group_001",
    chat_type: "group",
    chat_name: "Shape Group A",
    content: {
      text: "<redacted self-authored body>",
    },
  },
];

export { HOT_CHATS, REMOTE_MESSAGES, SELF_OPEN_ID };
