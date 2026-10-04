import assert from "node:assert/strict";
import test from "node:test";

import { createNameResolver } from "../src/adapters/lark-im/name-resolver.mjs";

const opts = { retries: 0, retryDelayMs: 0 };

function commandValue(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test("all optional name lookups use a five-second retry budget", () => {
  const calls = [];
  const resolver = createNameResolver({
    run(args, options) {
      calls.push({ operation: args.slice(0, 3), options });
      if (args[0] === "contact") return { users: [{ open_id: "ou_person", name: "Person" }] };
      if (args[0] === "api") return { app: { app_name: "Application" } };
      if (args[2] === "bots") return { items: [{ app_id: "cli_bot", bot_name: "Bot" }] };
      return { items: [{ member_id: "ou_member", name: "Member" }], has_more: false };
    },
  });
  resolver.resolveContactNames(["ou_person"], opts);
  resolver.resolveChatMemberNames("oc_a", ["ou_member"], opts);
  resolver.resolveApplicationNames(["cli_app"], opts);
  resolver.resolveChatBotAppFallbackNames(new Map([["oc_a", new Set(["cli_bot"])]]), new Map(), opts);

  assert.deepEqual(calls.map(({ operation }) => operation.slice(0, 2)), [
    ["contact", "+search-user"], ["im", "chat.members"], ["api", "GET"], ["im", "chat.members"],
  ]);
  assert.equal(calls[1].operation[2], "get");
  assert.equal(calls[3].operation[2], "bots");
  for (const { options } of calls) {
    assert.equal(options.retryBudgetMs, 5000);
    assert.equal(options.retries, opts.retries);
    assert.equal(options.retryDelayMs, opts.retryDelayMs);
  }
});

test("people contexts reuse positive user and application names across scopes", () => {
  const calls = [];
  const resolver = createNameResolver({
    now: () => 0,
    run(args) {
      calls.push(args);
      if (args[0] === "contact") return { users: [{ open_id: "ou_person", name: "Person" }] };
      if (args[0] === "api") return { app: { app_name: "Application" } };
      throw new Error("unexpected name lookup");
    },
  });

  for (const chat of ["oc_first", "oc_second", "oc_third"]) {
    const context = resolver.buildPeopleContext([
      { sender: { id: "ou_person", id_type: "open_id" }, chat_id: chat, chat_type: "group" },
      { sender: { id: "cli_app", sender_type: "app" }, chat_id: chat, chat_type: "group" },
    ], opts, null);
    assert.equal(context.contacts.get("ou_person"), "Person");
    assert.equal(context.apps.get("cli_app"), "Application");
    assert.equal(context.chat_members.size, 0);
    assert.equal(context.app_fallbacks.size, 0);
  }
  assert.deepEqual(calls.map((args) => args[0]), ["contact", "api"]);
});

test("current seed wins over cached and unsolicited response names", () => {
  let calls = 0;
  const resolver = createNameResolver({
    now: () => 0,
    run() {
      calls += 1;
      return { users: [
        { open_id: "ou_self", name: "Old Self" },
        { open_id: "ou_other", name: "Other" },
      ] };
    },
  });

  resolver.resolveContactNames(["ou_self"], opts);
  const seed = new Map([["ou_self", "Current Self"]]);
  const names = resolver.resolveContactNames(["ou_self", "ou_other"], opts, seed);
  assert.equal(names.get("ou_self"), "Current Self");
  assert.equal(names.get("ou_other"), "Other");
  assert.deepEqual([...seed], [["ou_self", "Current Self"]]);
  assert.equal(calls, 2);
  names.set("ou_other", "Caller Mutation");
  assert.equal(resolver.resolveContactNames(["ou_other"], opts).get("ou_other"), "Other");
  assert.equal(calls, 2);
});

test("31 contact IDs use explicit 30-item pages and cache every returned name", () => {
  const requests = [];
  const resolver = createNameResolver({
    now: () => 0,
    run(args) {
      const ids = commandValue(args, "--user-ids").split(",");
      const pageSize = Number(commandValue(args, "--page-size") || 20);
      requests.push({ ids, pageSize });
      return { users: ids.slice(0, Math.min(pageSize, 30))
        .map((open_id) => ({ open_id, name: `Name ${open_id}` })) };
    },
  });
  const ids = Array.from({ length: 31 }, (_, index) => `ou_${index}`);

  const names = resolver.resolveContactNames(ids, opts);
  assert.deepEqual(requests.map(({ ids: batch, pageSize }) => [batch.length, pageSize]), [[30, 30], [1, 30]]);
  assert.deepEqual([...names], ids.map((id) => [id, `Name ${id}`]));
  assert.deepEqual([...resolver.resolveContactNames(ids, opts)], [...names]);
  assert.equal(requests.length, 2);
});

test("chat member names are cached only within their chat", () => {
  const chats = [];
  const resolver = createNameResolver({
    now: () => 0,
    run(args) {
      const chat = JSON.parse(commandValue(args, "--params")).chat_id;
      chats.push(chat);
      return { items: [{ member_id: "ou_member", name: `Member in ${chat}` }], has_more: false };
    },
  });

  assert.equal(resolver.resolveChatMemberNames("oc_a", ["ou_member"], opts).get("ou_member"), "Member in oc_a");
  assert.equal(resolver.resolveChatMemberNames("oc_b", ["ou_member"], opts).get("ou_member"), "Member in oc_b");
  assert.equal(resolver.resolveChatMemberNames("oc_a", ["ou_member"], opts).get("ou_member"), "Member in oc_a");
  assert.deepEqual(chats, ["oc_a", "oc_b"]);
});

const lookupCases = [
  {
    kind: "user",
    lookup: (resolver) => resolver.resolveContactNames(["ou_person"], opts).get("ou_person"),
    response: (name) => ({ users: [{ open_id: "ou_person", name }] }),
  },
  {
    kind: "application",
    lookup: (resolver) => resolver.resolveApplicationNames(["cli_app"], opts).get("cli_app"),
    response: (name) => ({ app: { app_name: name } }),
  },
  {
    kind: "chat member",
    lookup: (resolver) => resolver.resolveChatMemberNames("oc_a", ["ou_person"], opts).get("ou_person"),
    response: (name) => ({ items: [{ member_id: "ou_person", name }], has_more: false }),
  },
];

for (const { kind, lookup, response } of lookupCases) {
  test(`${kind} cache expires after five minutes even when read before expiry`, () => {
    let now = 0;
    let calls = 0;
    let currentName = "Before Rename";
    const resolver = createNameResolver({
      now: () => now,
      run() {
        calls += 1;
        return response(currentName);
      },
    });

    assert.equal(lookup(resolver), "Before Rename");
    currentName = "After Rename";
    now = 299_999;
    assert.equal(lookup(resolver), "Before Rename");
    assert.equal(calls, 1);
    now = 300_000;
    assert.equal(lookup(resolver), "After Rename");
    assert.equal(calls, 2);
  });

  test(`${kind} failures and empty results never suppress a later lookup`, () => {
    let calls = 0;
    const resolver = createNameResolver({
      now: () => 0,
      run() {
        calls += 1;
        if (calls === 1) throw new Error("temporary failure");
        if (calls === 2) return null;
        if (calls === 3) return response("");
        if (calls === 4) return response("   ");
        return response("Recovered");
      },
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      lookup(resolver);
      assert.equal(calls, attempt);
    }
    assert.equal(lookup(resolver), "Recovered");
    assert.equal(lookup(resolver), "Recovered");
    assert.equal(calls, 5);
  });
}

test("caches do not share names between resolver instances", () => {
  let firstCalls = 0;
  let secondCalls = 0;
  const first = createNameResolver({
    run() {
      firstCalls += 1;
      return { users: [{ open_id: "ou_shared", name: "First Account Name" }] };
    },
  });
  const second = createNameResolver({
    run() {
      secondCalls += 1;
      return { users: [{ open_id: "ou_shared", name: "Second Account Name" }] };
    },
  });

  assert.equal(first.resolveContactNames(["ou_shared"], opts).get("ou_shared"), "First Account Name");
  assert.equal(second.resolveContactNames(["ou_shared"], opts).get("ou_shared"), "Second Account Name");
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
});

test("the 1000-name bound is shared by user, app, and chat member caches with LRU eviction", () => {
  const contactRequests = [];
  let appCalls = 0;
  let memberCalls = 0;
  const resolver = createNameResolver({
    now: () => 0,
    run(args) {
      if (args[0] === "contact") {
        const ids = commandValue(args, "--user-ids").split(",");
        contactRequests.push(ids);
        return { users: ids.map((open_id) => ({ open_id, name: `Name ${open_id}` })) };
      }
      if (args[0] === "api") {
        appCalls += 1;
        return { app: { app_name: "App" } };
      }
      memberCalls += 1;
      return { items: [{ member_id: "ou_member", name: "Member" }], has_more: false };
    },
  });

  const ids = Array.from({ length: 999 }, (_, index) => `ou_${index}`);
  assert.equal(resolver.resolveContactNames(ids, opts).size, 999);
  assert.equal(contactRequests.length, 34);
  assert.ok(contactRequests.every((batch) => batch.length <= 30));
  resolver.resolveApplicationNames(["cli_app"], opts);
  resolver.resolveContactNames(["ou_0"], opts); // Recently used entry survives.
  resolver.resolveChatMemberNames("oc_a", ["ou_member"], opts);
  resolver.resolveContactNames(["ou_0"], opts);
  resolver.resolveApplicationNames(["cli_app"], opts);
  resolver.resolveChatMemberNames("oc_a", ["ou_member"], opts);
  assert.equal(contactRequests.length, 34);
  assert.equal(appCalls, 1);
  assert.equal(memberCalls, 1);

  resolver.resolveContactNames(["ou_1"], opts); // Least recently used entry was evicted.
  assert.equal(contactRequests.length, 35);
  assert.deepEqual(contactRequests.at(-1), ["ou_1"]);
});

test("bot inference is reevaluated when a chat becomes ambiguous and never reused across chats", () => {
  const calls = [];
  let ambiguous = false;
  const resolver = createNameResolver({
    now: () => 0,
    run(args) {
      const chat = JSON.parse(commandValue(args, "--params")).chat_id;
      calls.push(chat);
      return { items: ambiguous && chat === "oc_a"
        ? [{ bot_name: "First Bot" }, { bot_name: "Other Bot" }]
        : [{ bot_name: `Bot in ${chat}` }] };
    },
  });
  const lookup = (chat) => resolver.resolveChatBotAppFallbackNames(
    new Map([[chat, new Set(["cli_app"])]]), new Map(), opts,
  );

  assert.equal(lookup("oc_a").get("oc_a:cli_app").name, "Bot in oc_a");
  ambiguous = true;
  assert.equal(lookup("oc_a").size, 0);
  assert.equal(lookup("oc_b").get("oc_b:cli_app").name, "Bot in oc_b");
  assert.deepEqual(calls, ["oc_a", "oc_a", "oc_b"]);
});
