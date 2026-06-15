import assert from "node:assert/strict";
import test from "node:test";

import {
  createLarkImAdapter,
  isRestrictedModeError,
  isTransientLarkFailure,
} from "../scripts/lib/lark-im-adapter.mjs";
import { recordFromMessage } from "../src/adapters/lark-im/core.mjs";

function adapterOpts(overrides = {}) {
  return {
    pageSize: 50,
    maxPages: 5,
    chatPageSize: 100,
    chatTypes: "group",
    retries: 0,
    retryDelayMs: 0,
    ...overrides,
  };
}

function commandValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

test("fetchSentMessages builds user search commands and follows page tokens", () => {
  const calls = [];
  const adapter = createLarkImAdapter({
    run(args, options) {
      calls.push({ args, options });
      assert.equal(args[0], "im");
      assert.equal(args[1], "+messages-search");
      assert.equal(commandValue(args, "--sender"), "ou_self");
      if (commandValue(args, "--page-token") === "p2") {
        return { messages: [{ message_id: "om_2" }], has_more: false };
      }
      return {
        data: {
          messages: [{ message_id: "om_1" }],
          has_more: true,
          page_token: "p2",
        },
      };
    },
  });

  const result = adapter.fetchSentMessages("ou_self", 1000, 2000, adapterOpts());

  assert.equal(result.pages, 2);
  assert.deepEqual(result.messages.map((message) => message.message_id), ["om_1", "om_2"]);
  assert.deepEqual(calls[0].options.redactedFlags, ["--sender", "--page-token"]);
  assert.equal(commandValue(calls[1].args, "--page-token"), "p2");
});

test("fetchChatDiscoveryPage normalizes non-muted chat-list output", () => {
  const adapter = createLarkImAdapter({
    run(args) {
      assert.equal(args[0], "im");
      assert.equal(args[1], "+chat-list");
      assert.equal(args.includes("--exclude-muted"), true);
      assert.equal(commandValue(args, "--types"), "group");
      assert.equal(commandValue(args, "--page-token"), "next");
      return {
        data: {
          items: [
            {
              chat_id: "oc_1",
              chat_mode: "thread",
              i18n_names: { zh_cn: "Thread Group", en_us: "Thread Group EN" },
            },
            { name: "missing id" },
          ],
          has_more: true,
          page_token: "after",
        },
      };
    },
  });

  assert.deepEqual(adapter.fetchChatDiscoveryPage(adapterOpts(), "next"), {
    chats: [
      {
        chat_id: "oc_1",
        chat_type: "thread",
        chat_name: "Thread Group",
      },
    ],
    has_more: true,
    page_token: "after",
  });
});

test("transient classifier retries Lark internal API errors", () => {
  const stderr = JSON.stringify({
    ok: false,
    error: {
      type: "api",
      subtype: "unknown",
      code: 2200,
      message: "Internal Error",
    },
  });

  assert.equal(isTransientLarkFailure(stderr), true);
  assert.equal(
    isTransientLarkFailure(JSON.stringify({ error: { type: "api", code: 999, message: "Permission denied" } })),
    false,
  );
});

test("buildPeopleContext returns record-compatible contact and chat member maps", () => {
  const adapter = createLarkImAdapter({
    run(args) {
      if (args[0] === "contact" && args[1] === "+search-user") {
        assert.equal(commandValue(args, "--user-ids"), "ou_contact,ou_member");
        return {
          data: {
            users: [{ open_id: "ou_contact", name: "Contact Name" }],
          },
        };
      }
      if (args[0] === "im" && args[1] === "chat.members") {
        const params = JSON.parse(commandValue(args, "--params"));
        assert.equal(params.chat_id, "oc_group");
        return {
          data: {
            items: [{ member_id: "ou_member", name: "Member Name" }],
            has_more: false,
          },
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });
  const messages = [
    {
      message_id: "om_contact",
      create_time: "1000",
      sender: { id: "ou_contact", id_type: "open_id" },
      chat_id: "oc_p2p",
      chat_type: "p2p",
      content: "hello",
    },
    {
      message_id: "om_member",
      create_time: "1001",
      sender: { id: "ou_member", id_type: "open_id" },
      chat_id: "oc_group",
      chat_type: "group",
      content: "hi",
    },
  ];

  const context = adapter.buildPeopleContext(messages, adapterOpts(), {
    open_id: "ou_self",
    name: "Self Name",
  });

  assert.equal(context.contacts.get("ou_contact"), "Contact Name");
  assert.equal(context.chat_members.get("oc_group:ou_member"), "Member Name");
  assert.equal(context.self.name, "Self Name");

  const contactRecord = recordFromMessage(messages[0], "scope", "received", context);
  assert.equal(JSON.parse(contactRecord.canonical_json).sender_name, "Contact Name");

  const memberRecord = recordFromMessage(messages[1], "scope", "received", context);
  assert.equal(JSON.parse(memberRecord.canonical_json).sender_name, "Member Name");
});

test("buildPeopleContext resolves app sender from application API", () => {
  const adapter = createLarkImAdapter({
    run(args) {
      assert.equal(args[0], "api");
      assert.equal(args[1], "GET");
      assert.equal(args[2], "/open-apis/application/v6/applications/cli_app");
      assert.equal(commandValue(args, "--as"), "bot");
      const params = JSON.parse(commandValue(args, "--params"));
      assert.equal(params.lang, "zh_cn");
      return {
        data: {
          app: { app_id: "cli_app", app_name: "Demo Workflow Bot" },
        },
      };
    },
  });
  const messages = [
    {
      message_id: "om_app",
      create_time: "1000",
      sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
      chat_id: "oc_group",
      chat_type: "group",
      content: "card",
      msg_type: "interactive",
    },
  ];

  const context = adapter.buildPeopleContext(messages, adapterOpts(), {
    open_id: "ou_self",
    name: "Self Name",
  });

  assert.equal(context.apps.get("cli_app"), "Demo Workflow Bot");
  const record = recordFromMessage(messages[0], "scope", "received", context);
  const canonical = JSON.parse(record.canonical_json);
  assert.equal(canonical.sender_name, "Demo Workflow Bot");
  assert.equal(canonical.sender_name_source, "application_api");
  assert.equal(canonical.sender_name_confidence, "high");
});

test("buildPeopleContext falls back to a unique chat bot when application API is unavailable", () => {
  const adapter = createLarkImAdapter({
    run(args) {
      if (args[0] === "api") throw new Error("210508 insufficient permission level");
      if (args[0] === "im" && args[1] === "chat.members" && args[2] === "bots") {
        const params = JSON.parse(commandValue(args, "--params"));
        assert.equal(params.chat_id, "oc_group");
        return { data: { items: [{ bot_id: "ou_bot", bot_name: "Demo Workflow Bot" }] } };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });
  const messages = [
    {
      message_id: "om_app",
      create_time: "1000",
      sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
      chat_id: "oc_group",
      chat_type: "group",
      content: "card",
    },
  ];

  const context = adapter.buildPeopleContext(messages, adapterOpts(), null);

  assert.equal(context.apps.has("cli_app"), false);
  assert.equal(context.app_fallbacks.get("oc_group:cli_app").name, "Demo Workflow Bot");
  const record = recordFromMessage(messages[0], "scope", "received", context);
  const canonical = JSON.parse(record.canonical_json);
  assert.equal(canonical.sender_name, "Demo Workflow Bot");
  assert.equal(canonical.sender_name_source, "chat_bot_unique");
  assert.equal(canonical.sender_name_confidence, "medium");
});

test("buildPeopleContext does not infer an app sender from ambiguous chat bots", () => {
  const adapter = createLarkImAdapter({
    run(args) {
      if (args[0] === "api") throw new Error("210508 insufficient permission level");
      if (args[0] === "im" && args[1] === "chat.members" && args[2] === "bots") {
        return {
          data: {
            items: [
              { bot_id: "ou_bot_1", bot_name: "Bot One" },
              { bot_id: "ou_bot_2", bot_name: "Bot Two" },
            ],
          },
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });
  const messages = [
    {
      message_id: "om_app",
      create_time: "1000",
      sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
      chat_id: "oc_group",
      chat_type: "group",
      content: "card",
    },
  ];

  const context = adapter.buildPeopleContext(messages, adapterOpts(), null);

  assert.equal(context.apps.has("cli_app"), false);
  assert.equal(context.app_fallbacks.has("oc_group:cli_app"), false);
  const record = recordFromMessage(messages[0], "scope", "received", context);
  const canonical = JSON.parse(record.canonical_json);
  assert.equal(canonical.sender_name, null);
  assert.equal(canonical.sender_name_source, null);
  assert.equal(canonical.sender_name_confidence, null);
});

test("buildPeopleContext uses bot app_id matches even when a chat has multiple bots", () => {
  const adapter = createLarkImAdapter({
    run(args) {
      if (args[0] === "api") throw new Error("210508 insufficient permission level");
      if (args[0] === "im" && args[1] === "chat.members" && args[2] === "bots") {
        return {
          data: {
            items: [
              { app_id: "cli_other", bot_id: "ou_bot_1", bot_name: "Other Bot" },
              { app_id: "cli_app", bot_id: "ou_bot_2", bot_name: "Exact Bot" },
            ],
          },
        };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
  });
  const messages = [
    {
      message_id: "om_app",
      create_time: "1000",
      sender: { id: "cli_app", id_type: "app_id", sender_type: "app" },
      chat_id: "oc_group",
      chat_type: "group",
      content: "card",
    },
  ];

  const context = adapter.buildPeopleContext(messages, adapterOpts(), null);

  assert.equal(context.app_fallbacks.get("oc_group:cli_app").name, "Exact Bot");
  const record = recordFromMessage(messages[0], "scope", "received", context);
  const canonical = JSON.parse(record.canonical_json);
  assert.equal(canonical.sender_name, "Exact Bot");
  assert.equal(canonical.sender_name_source, "chat_bot_app_id");
  assert.equal(canonical.sender_name_confidence, "high");
});

test("restricted mode classifier recognizes Lark restricted chat errors", () => {
  assert.equal(isRestrictedModeError(new Error('{"code":231203,"msg":"Restricted Mode"}')), true);
  assert.equal(isRestrictedModeError(new Error("don't allow copying or forwarding messages")), true);
  assert.equal(isRestrictedModeError(new Error("network timeout")), false);
});
