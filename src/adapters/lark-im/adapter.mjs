// @ts-check

import { isDeepStrictEqual } from "node:util";

import {
  assertValidLarkMessage,
  MessageDetailsIncompleteError,
  MessageWindowBudgetError,
  isPaginationLimitError,
  parseLarkTimeMs,
  readBoundedPages,
} from "./core.mjs";
import { PaginationLimitError } from "../../../dist/core/sync.js";
import { normalizeApiMessage } from "./raw-message.mjs";
import {
  createNameResolver,
  displayNameFromUser,
  firstArray,
  uniqueAppIds,
  uniqueOpenIds,
} from "./name-resolver.mjs";
import {
  DEFAULT_LARK_CLI_TIMEOUT_MS,
  DEFAULT_LARK_RETRY_BUDGET_MS,
  classifyLarkFailure,
  isTransientLarkFailure,
  parseJson,
  redactCommand,
  runLark,
} from "./transport.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} AdapterRunOptions
 * @property {string[]=} redactedFlags
 * @property {number=} retries
 * @property {number=} retryDelayMs
 * @property {number=} timeoutMs
 * @property {number=} retryBudgetMs
 *
 * @typedef {(args: string[], options?: AdapterRunOptions) => JsonObject | null} LarkRunner
 *
 * @typedef {object} AdapterOptions
 * @property {number=} retries
 * @property {number=} retryDelayMs
 *
 * @typedef {AdapterOptions & {
 *   pageSize: number,
 *   maxPages: number,
 *   chatPageSize: number,
 *   chatTypes: string
 * }} FetchOptions
 *
 * @typedef {object} ApiEnvelope
 * @property {any[]} items
 * @property {boolean} has_more
 * @property {string} page_token
 *
 * @typedef {object} SelfProfile
 * @property {string} open_id
 * @property {string} name
 *
 * @typedef {object} ChatDiscoveryItem
 * @property {string} chat_id
 * @property {string | null} chat_type
 * @property {string | null} chat_name
 *
 * @typedef {object} ChatDiscoveryPage
 * @property {ChatDiscoveryItem[]} chats
 * @property {boolean} has_more
 * @property {string} page_token
 *
 * @typedef {object} MessageFetchResult
 * @property {any[]} messages
 * @property {number} pages
 *
 * @typedef {MessageFetchResult & {detailRoots: JsonObject[]}} MessageListResult
 *
 * @typedef {AdapterOptions & {
 *   detailBudgetMs?: number,
 *   detailMaxPages?: number,
 *   detailMaxItems?: number
 * }} DetailOptions
 *
 * @typedef {object} NameDetails
 * @property {string} name
 * @property {string} source
 * @property {string} confidence
 *
 * @typedef {object} PeopleContext
 * @property {SelfProfile | null} self
 * @property {Map<string, string>} contacts
 * @property {Map<string, string>} chat_members
 * @property {Map<string, string>} apps
 * @property {Map<string, NameDetails>} app_fallbacks
 * @property {Map<string, string>} userNames
 * @property {Map<string, string>} chatMemberNames
 * @property {Map<string, string>} appNames
 * @property {Map<string, NameDetails>} appFallbackNames
 *
 * @typedef {object} LarkImAdapter
 * @property {(opts?: AdapterOptions) => SelfProfile} getSelfProfile
 * @property {(openIds: unknown[], opts: AdapterOptions, seed?: Map<string, string>) => Map<string, string>} resolveContactNames
 * @property {(chatIdValue: string, openIds: unknown[], opts: AdapterOptions) => Map<string, string>} resolveChatMemberNames
 * @property {(appIds: unknown[], opts: AdapterOptions) => Map<string, string>} resolveApplicationNames
 * @property {(appIdsByChat: Map<string, Set<string>>, officialApps: Map<string, string>, opts: AdapterOptions) => Map<string, NameDetails>} resolveChatBotAppFallbackNames
 * @property {(messages: any[], opts: AdapterOptions, selfProfile: SelfProfile | null, scopeConfig?: JsonObject) => PeopleContext} buildPeopleContext
 * @property {(selfOpenId: string, startMs: number, endMs: number, opts: FetchOptions) => MessageFetchResult} fetchSentMessages
 * @property {(chatIdValue: string, startMs: number, endMs: number, opts: FetchOptions) => MessageFetchResult} fetchChatMessages
 * @property {(selfOpenId: string, startMs: number, endMs: number, opts: FetchOptions) => MessageListResult} fetchSentMessageList
 * @property {(chatIdValue: string, startMs: number, endMs: number, opts: FetchOptions) => MessageListResult} fetchChatMessageList
 * @property {(rawRoot: JsonObject, opts?: DetailOptions) => JsonObject} fetchMessageDetails
 * @property {(opts: FetchOptions, pageToken: string) => ChatDiscoveryPage} fetchChatDiscoveryPage
 */

/**
 * @param {JsonObject | null} json
 * @param {string} collectionName
 * @returns {ApiEnvelope}
 */
function getEnvelope(json, collectionName) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error(`${collectionName} response must be an object`);
  }
  const root = /** @type {JsonObject} */ (json);
  if (root.data !== null && root.data !== undefined && (typeof root.data !== "object" || Array.isArray(root.data))) {
    throw new Error(`${collectionName} response data must be an object`);
  }
  const data = root.data && typeof root.data === "object" ? /** @type {JsonObject} */ (root.data) : {};
  const candidates = [
    root[collectionName],
    data[collectionName],
    root.items,
    data.items,
    root.results,
    data.results,
  ];
  const presentCollections = candidates.filter((value) => value !== undefined);
  if (presentCollections.length === 0 || presentCollections.some((value) => !Array.isArray(value))) {
    throw new Error(`${collectionName} response is missing a valid ${collectionName} array`);
  }
  const items = /** @type {any[]} */ (presentCollections[0]);
  if (root.has_more !== undefined && data.has_more !== undefined && root.has_more !== data.has_more) {
    throw new Error(`${collectionName} response has conflicting has_more values`);
  }
  const hasMore = root.has_more ?? data.has_more;
  if (typeof hasMore !== "boolean") {
    throw new Error(`${collectionName} response is missing a boolean has_more`);
  }
  if (root.page_token !== undefined && data.page_token !== undefined && root.page_token !== data.page_token) {
    throw new Error(`${collectionName} response has conflicting page_token values`);
  }
  const pageToken = root.page_token ?? data.page_token ?? "";
  if (typeof pageToken !== "string") {
    throw new Error(`${collectionName} response has a non-string page_token`);
  }
  return {
    items,
    has_more: hasMore,
    page_token: pageToken,
  };
}

/** @param {any[]} messages @param {string} endpoint */
function assertValidMessagePage(messages, endpoint) {
  messages.forEach((message, index) => assertValidLarkMessage(message, `${endpoint} message at index ${index}`));
}

/** Native API output must positively acknowledge success, including CLI's code-stripping wrapper.
 * @param {JsonObject | null} json @param {string} endpoint @returns {JsonObject}
 */
function nativeData(json, endpoint) {
  if (!json || typeof json !== "object" || Array.isArray(json) ||
      (json.ok !== undefined && json.ok !== true) ||
      (json.code !== undefined && json.code !== 0) ||
      (json.ok !== true && json.code !== 0) || json.error != null ||
      !json.data || typeof json.data !== "object" || Array.isArray(json.data)) {
    throw new Error(`${endpoint} returned an invalid or unsuccessful API envelope`);
  }
  return json.data;
}

/** @param {JsonObject} data @param {string} endpoint @returns {JsonObject[]} */
function nativeItems(data, endpoint) {
  if (!Array.isArray(data.items)) throw new Error(`${endpoint} response is missing a valid items array`);
  return data.items;
}

/** @param {JsonObject | null} json @param {string} endpoint @param {Set<string>} tokens */
function nativePage(json, endpoint, tokens) {
  const data = nativeData(json, endpoint);
  const items = nativeItems(data, endpoint);
  if (typeof data.has_more !== "boolean") throw new Error(`${endpoint} response is missing a boolean has_more`);
  const token = data.page_token ?? "";
  if (typeof token !== "string") throw new Error(`${endpoint} response has a non-string page_token`);
  if (data.has_more) {
    if (!token.trim()) throw new Error(`${endpoint} returned has_more without page_token`);
    if (tokens.has(token)) throw new Error(`${endpoint} returned a repeated page_token`);
    tokens.add(token);
  } else if (token) {
    // Some endpoints keep their final token. It cannot schedule another request.
    if (tokens.has(token)) throw new Error(`${endpoint} returned a repeated final page_token`);
  }
  return { items, has_more: data.has_more, page_token: token };
}

/** @param {JsonObject[]} messages @param {string} endpoint */
function assertRawMessagePage(messages, endpoint) {
  assertValidMessagePage(messages, endpoint);
  for (const message of messages) {
    if (typeof message.message_id !== "string" || !message.message_id.trim() ||
        typeof message.msg_type !== "string" || !message.msg_type.trim() ||
        !message.body || typeof message.body !== "object" || Array.isArray(message.body) ||
        typeof message.body.content !== "string") {
      throw new Error(`${endpoint} response contains an invalid raw message`);
    }
  }
}

/** @param {number} startMs @param {number} endMs @param {FetchOptions} opts */
function assertFetchBounds(startMs, endMs, opts) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs < startMs ||
      !Number.isFinite(new Date(endMs).getTime()) || !Number.isSafeInteger(opts.pageSize) || opts.pageSize < 1 ||
      !Number.isSafeInteger(opts.maxPages) || opts.maxPages < 1) {
    throw new Error("message fetch requires valid millisecond bounds and positive page limits");
  }
}

/** All embedded nodes must reach this root; malformed trees cannot render as complete.
 * @param {string} rootId @param {JsonObject[]} items
 */
function assertMergeTree(rootId, items) {
  const byId = new Map(items.map((item) => [item.message_id, item]));
  if (byId.size !== items.length) throw new Error("message-details returned duplicate merge-forward IDs");
  if (!byId.has(rootId)) throw new Error("message-details is missing the merge-forward root");
  for (const item of items) {
    if (item.upper_message_id != null && typeof item.upper_message_id !== "string") {
      throw new Error("message-details returned an invalid merge-forward parent");
    }
    const visited = new Set();
    let current = item;
    while (current.message_id !== rootId) {
      if (visited.has(current.message_id) || visited.size >= 64) {
        throw new Error("message-details returned a cyclic or excessively deep merge-forward tree");
      }
      visited.add(current.message_id);
      const parent = current.upper_message_id || rootId;
      if (parent === rootId) break;
      if (!byId.has(parent)) throw new Error("message-details returned an orphan merge-forward item");
      current = /** @type {JsonObject} */ (byId.get(parent));
    }
  }
  if (byId.get(rootId)?.upper_message_id) throw new Error("message-details returned an invalid merge-forward root");
}

/** @param {unknown} value @param {number} index */
function normalizeChat(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`chat-list chat at index ${index} must be an object`);
  }
  const chat = /** @type {JsonObject} */ (value);
  if (typeof chat.chat_id !== "string" || !chat.chat_id.trim()) {
    throw new Error(`chat-list chat at index ${index} is missing a valid chat_id`);
  }
  return {
    chat_id: chat.chat_id,
    chat_type: chat.chat_mode || chat.chat_type || null,
    chat_name: chat.name || chat.i18n_names?.zh_cn || chat.i18n_names?.en_us || null,
  };
}

/** @param {unknown} error */
function isRestrictedModeError(error) {
  return classifyLarkFailure(error).kind === "restricted_mode";
}

/** @param {unknown} error */
function isBotUserOutOfChatError(error) {
  return classifyLarkFailure(error).kind === "bot_user_out_of_chat";
}

/** One queued root failed; its deadline or page bounds cannot bisect a list window. */
class MessageDetailError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`message-details unavailable: kind=${reason}`);
    this.name = "MessageDetailError";
    this.detailReason = reason;
  }
}

/** @param {unknown} error */
function detailFailureReason(error) {
  if (error instanceof MessageDetailError) return error.detailReason;
  const failure = classifyLarkFailure(error);
  return failure.kind === "unknown" ? "invalid_or_unavailable_details" : failure.kind;
}

/** A queued root is evidence of identity/version, not the authoritative detail snapshot.
 * @param {JsonObject} queued @param {JsonObject} refreshed
 */
function assertRefreshedRoot(queued, refreshed) {
  if (refreshed.message_id !== queued.message_id ||
      typeof queued.chat_id !== "string" || !queued.chat_id.trim() || refreshed.chat_id !== queued.chat_id ||
      parseLarkTimeMs(refreshed.create_time) !== parseLarkTimeMs(queued.create_time)) {
    throw new MessageDetailError("source_identity_changed");
  }
  const version = (/** @type {JsonObject} */ root) =>
    root.update_time == null || root.update_time === "" ? null : parseLarkTimeMs(root.update_time);
  const previousVersion = version(queued);
  const nextVersion = version(refreshed);
  if (previousVersion !== null && (nextVersion === null || nextVersion < previousVersion)) {
    throw new MessageDetailError("source_version_regressed");
  }
  if (previousVersion === nextVersion) {
    // Compare complete native source evidence; JSON object key ordering is not
    // a content edit. Detail-only empty parent metadata is not source content.
    const payload = (/** @type {JsonObject} */ root) => {
      const { create_time, update_time, upper_message_id, ...source } = root;
      return source;
    };
    if (!isDeepStrictEqual(payload(queued), payload(refreshed))) {
      throw new MessageDetailError("source_version_conflict");
    }
  }
}

/**
 * @param {{run?: LarkRunner, clock?: () => number}} [deps]
 * @returns {LarkImAdapter}
 */
function createLarkImAdapter({ run = runLark, clock = Date.now } = {}) {
  const nameResolver = createNameResolver({ run });

  /** One fetch window shares its retry time and detail bounds; no per-child deadline reset.
   * @param {FetchOptions} opts @param {string} operation @param {number} startMs @param {number} endMs
   * @param {JsonObject[]=} detailRoots Defined only for the list-only path.
   */
  function nativeWindow(opts, operation, startMs, endMs, detailRoots) {
    let lastNow = clock();
    if (!Number.isFinite(lastNow)) throw new Error("message fetch clock is invalid");
    const now = () => {
      const value = clock();
      if (!Number.isFinite(value)) throw new Error("message fetch clock is invalid");
      lastNow = Math.max(lastNow, value);
      return lastNow;
    };
    const deadline = lastNow + DEFAULT_LARK_RETRY_BUDGET_MS;
    let detailCalls = 0;
    let detailItems = 0;
    /** @type {Map<string, JsonObject[]>} */
    const mergeCache = new Map();
    /** @type {Map<string, {message_id: string, reason: string}>} */
    const missingDetails = new Map();
    /** @param {string} method @param {string} path @param {JsonObject} params @param {JsonObject} [body] */
    const request = (method, path, params, body) => {
      const remaining = Math.floor(deadline - now());
      if (remaining <= 0) {
        throw new MessageWindowBudgetError(operation);
      }
      const args = ["api", method, path, "--as", "user", "--params", JSON.stringify(params), "--format", "json"];
      if (body !== undefined) args.push("--data", JSON.stringify(body));
      try {
        return run(args, { redactedFlags: ["--params", "--data"], retries: opts.retries,
          retryDelayMs: opts.retryDelayMs, timeoutMs: Math.min(DEFAULT_LARK_CLI_TIMEOUT_MS, remaining), retryBudgetMs: remaining });
      } catch (error) {
        // Only an exhausted shared deadline justifies a smaller time window.
        // Permission, rate limits and ordinary request failures keep their meaning.
        if (classifyLarkFailure(error).kind === "network_timeout" && now() >= deadline) {
          throw new MessageWindowBudgetError(operation, error);
        }
        throw error;
      }
    };
    /** @param {JsonObject[]} messages */
    const normalize = (messages) => messages.filter((message) => {
      const created = parseLarkTimeMs(message.create_time);
      return created >= startMs && created <= endMs;
    }).map((message) => {
      if (message.msg_type !== "merge_forward") return normalizeApiMessage(message);
      if (detailRoots) {
        detailRoots.push(JSON.parse(JSON.stringify(message)));
        return null;
      }
      if (missingDetails.has(message.message_id)) return null;
      try {
        let items = mergeCache.get(message.message_id);
        if (!items) {
          /** @type {JsonObject[]} */
          const collected = [];
          const tokens = new Set();
          let token = "";
          for (;;) {
            // Details consume the same page budget; the caller may retry a smaller complete time prefix.
            if (detailCalls >= Math.min(opts.maxPages, 50)) {
              throw new PaginationLimitError("merge-forward details exceed the bounded page budget", opts.maxPages);
            }
            detailCalls += 1;
            const json = request("GET", `/open-apis/im/v1/messages/${encodeURIComponent(message.message_id)}`,
              { user_id_type: "open_id", card_msg_content_type: "raw_card_content", ...(token ? { page_token: token } : {}) });
            const data = nativeData(json, "message-details");
            const pageItems = nativeItems(data, "message-details");
            assertRawMessagePage(pageItems, "message-details");
            detailItems += pageItems.length;
            if (detailItems > 1000) throw new PaginationLimitError("merge-forward details exceed the bounded item budget", opts.maxPages);
            collected.push(...pageItems);
            // The documented CLI detail path returns a single items array without pagination fields.
            if (data.has_more === undefined) {
              if (data.page_token != null && data.page_token !== "") throw new Error("message-details returned a token without has_more");
              break;
            }
            const page = nativePage(json, "message-details", tokens);
            if (!page.has_more) break;
            token = page.page_token;
          }
          if (!collected.length) throw new Error("message-details returned no merge-forward items");
          assertMergeTree(message.message_id, collected);
          items = collected;
          mergeCache.set(message.message_id, items);
        }
        return normalizeApiMessage(message, { mergeItems: items });
      } catch (error) {
        // A detail denial says nothing about list access to this chat. Keep
        // reading ordinary messages; do not turn a partial merge into a record
        // that could erase an already stored complete expansion.
        if (error instanceof MessageWindowBudgetError || isPaginationLimitError(error)) throw error;
        const text = error instanceof Error ? error.message : "";
        const reason = text === "merge-forward source changed during detail retrieval" ? "source_changed"
          : detailFailureReason(error);
        missingDetails.set(message.message_id, { message_id: message.message_id, reason });
        return null;
      }
    }).filter((message) => message !== null);
    /** @param {MessageFetchResult} result */
    const complete = (result) => {
      if (missingDetails.size) {
        throw new MessageDetailsIncompleteError(result.messages, result.pages, [...missingDetails.values()]);
      }
      return result;
    };
    return { request, normalize, complete };
  }

  /** @param {AdapterOptions} [opts] */
  function getSelfProfile(opts = {}) {
    const json = run(["contact", "+get-user", "--as", "user", "--format", "json"], {
      retries: opts.retries ?? 2,
      retryDelayMs: opts.retryDelayMs ?? 1000,
    });
    const openId =
      json?.open_id ||
      json?.user?.open_id ||
      json?.data?.open_id ||
      json?.data?.user?.open_id ||
      json?.data?.user_id?.open_id ||
      "";
    const name =
      displayNameFromUser(json) ||
      displayNameFromUser(json?.user) ||
      displayNameFromUser(json?.data) ||
      displayNameFromUser(json?.data?.user) ||
      "";
    return { open_id: openId, name };
  }

  const {
    buildPeopleContext,
    resolveApplicationNames,
    resolveChatBotAppFallbackNames,
    resolveChatMemberNames,
    resolveContactNames,
  } = nameResolver;

  /**
   * @param {string} selfOpenId
   * @param {number} startMs
   * @param {number} endMs
   * @param {FetchOptions} opts
   * @param {JsonObject[]=} detailRoots
   */
  function fetchSentWindow(selfOpenId, startMs, endMs, opts, detailRoots) {
    assertFetchBounds(startMs, endMs, opts);
    const { request, normalize, complete } = nativeWindow(opts, "message_search_bundle", startMs, endMs, detailRoots);
    const tokens = new Set();
    return complete(readBoundedPages({
      maxPages: opts.maxPages,
      missingPageTokenMessage: "messages-search returned has_more without page_token",
      maxPagesMessage: (maxPages) => `messages-search still has more data after ${maxPages} pages`,
      fetchPage: (pageToken) => {
        const json = request("POST", "/open-apis/im/v1/messages/search",
          { page_size: Math.min(opts.pageSize, 30), ...(pageToken ? { page_token: pageToken } : {}) },
          { query: "", filter: { from_ids: [selfOpenId], time_range: {
            // Search validates second-precision ISO8601; fractional seconds are rejected.
            // Round outwards for the request, then retain only the exact millisecond window.
            start_time: new Date(Math.floor(startMs / 1000) * 1000).toISOString().replace(".000Z", "Z"),
            end_time: new Date(Math.ceil(endMs / 1000) * 1000).toISOString().replace(".000Z", "Z"),
          } } });
        const envelope = nativePage(json, "messages-search", tokens);
        const ids = envelope.items.map((item) => item?.meta_data?.message_id);
        if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
          throw new Error("messages-search returned invalid or duplicate message IDs");
        }
        /** @type {JsonObject[]} */
        const messages = [];
        for (let offset = 0; offset < ids.length; offset += 50) {
          const expected = ids.slice(offset, offset + 50);
          const detailData = nativeData(request("GET", "/open-apis/im/v1/messages/mget",
            { message_ids: expected, card_msg_content_type: "raw_card_content" }), "messages-mget");
          if ((detailData.has_more !== undefined && detailData.has_more !== false) ||
              (detailData.page_token != null && detailData.page_token !== "")) {
            throw new Error("messages-mget returned unexpected pagination");
          }
          const details = nativeItems(detailData, "messages-mget");
          assertRawMessagePage(details, "messages-mget");
          const byId = new Map(details.map((message) => [message.message_id, message]));
          if (byId.size !== details.length || details.length !== expected.length || expected.some((id) => !byId.has(id))) {
            throw new Error("messages-mget response does not exactly match the requested message IDs");
          }
          messages.push(...expected.map((id) => /** @type {JsonObject} */ (byId.get(id))));
        }
        return {
          messages: normalize(messages),
          has_more: envelope.has_more,
          page_token: envelope.page_token,
        };
      },
    }));
  }

  /**
   * @param {string} chatIdValue
   * @param {number} startMs
   * @param {number} endMs
   * @param {FetchOptions} opts
   * @param {JsonObject[]=} detailRoots
   */
  function fetchChatWindow(chatIdValue, startMs, endMs, opts, detailRoots) {
    assertFetchBounds(startMs, endMs, opts);
    const { request, normalize, complete } = nativeWindow(opts, "message_history_bundle", startMs, endMs, detailRoots);
    const tokens = new Set();
    return complete(readBoundedPages({
      maxPages: opts.maxPages,
      missingPageTokenMessage: "chat-messages-list returned has_more without page_token",
      maxPagesMessage: (maxPages) => `chat-messages-list still has more data after ${maxPages} pages`,
      fetchPage: (pageToken) => {
        const json = request("GET", "/open-apis/im/v1/messages", {
          container_id_type: "chat", container_id: chatIdValue, only_thread_root_messages: false,
          sort_type: "ByCreateTimeAsc", page_size: Math.min(opts.pageSize, 50),
          card_msg_content_type: "raw_card_content", start_time: String(Math.floor(startMs / 1000)),
          end_time: String(Math.ceil(endMs / 1000)), ...(pageToken ? { page_token: pageToken } : {}),
        });
        const envelope = nativePage(json, "chat-messages-list", tokens);
        assertRawMessagePage(envelope.items, "chat-messages-list");
        return {
          messages: normalize(envelope.items),
          has_more: envelope.has_more,
          page_token: envelope.page_token,
        };
      },
    }));
  }

  /** @type {LarkImAdapter["fetchSentMessages"]} */
  const fetchSentMessages = (selfOpenId, startMs, endMs, opts) =>
    fetchSentWindow(selfOpenId, startMs, endMs, opts);
  /** @type {LarkImAdapter["fetchChatMessages"]} */
  const fetchChatMessages = (chatIdValue, startMs, endMs, opts) =>
    fetchChatWindow(chatIdValue, startMs, endMs, opts);

  /** Complete list coverage is independent of merge-detail availability.
   * No partial lists escape on search, mget, pagination or deadline failure.
   * @type {LarkImAdapter["fetchSentMessageList"]}
   */
  const fetchSentMessageList = (selfOpenId, startMs, endMs, opts) => {
    /** @type {JsonObject[]} */
    const detailRoots = [];
    const result = fetchSentWindow(selfOpenId, startMs, endMs, opts, detailRoots);
    return { ...result, detailRoots };
  };
  /** @type {LarkImAdapter["fetchChatMessageList"]} */
  const fetchChatMessageList = (chatIdValue, startMs, endMs, opts) => {
    /** @type {JsonObject[]} */
    const detailRoots = [];
    const result = fetchChatWindow(chatIdValue, startMs, endMs, opts, detailRoots);
    return { ...result, detailRoots };
  };

  /** Hydrate one root under an independent, capped budget. The returned root
   * is refreshed from the authoritative response, so a queued old version
   * cannot permanently block recovery after an edit.
   * @type {LarkImAdapter["fetchMessageDetails"]}
   */
  function fetchMessageDetails(rawRoot, opts = {}) {
    try {
      assertRawMessagePage([rawRoot], "queued-message-details");
      if (rawRoot.msg_type !== "merge_forward") throw new MessageDetailError("invalid_or_unavailable_details");
      const boundedOption = (/** @type {number | undefined} */ value, /** @type {number} */ cap) => {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new MessageDetailError("invalid_detail_options");
        }
        return Math.min(value ?? cap, cap);
      };
      const budgetMs = boundedOption(opts.detailBudgetMs, 30_000);
      const maxPages = boundedOption(opts.detailMaxPages, 50);
      const maxItems = boundedOption(opts.detailMaxItems, 1000);
      let lastNow = clock();
      if (!Number.isFinite(lastNow)) throw new MessageDetailError("invalid_or_unavailable_details");
      const deadline = lastNow + budgetMs;
      const remaining = () => {
        const value = clock();
        if (!Number.isFinite(value)) throw new MessageDetailError("invalid_or_unavailable_details");
        lastNow = Math.max(lastNow, value);
        const ms = Math.floor(deadline - lastNow);
        if (ms <= 0) throw new MessageDetailError("detail_budget_exhausted");
        return ms;
      };
      /** @type {JsonObject[]} */
      const items = [];
      const tokens = new Set();
      let token = "";
      for (let pageCount = 0; ; pageCount += 1) {
        if (pageCount >= maxPages) throw new MessageDetailError("detail_page_limit");
        const availableMs = remaining();
        const params = { user_id_type: "open_id", card_msg_content_type: "raw_card_content",
          ...(token ? { page_token: token } : {}) };
        const json = run(["api", "GET", `/open-apis/im/v1/messages/${encodeURIComponent(rawRoot.message_id)}`,
          "--as", "user", "--params", JSON.stringify(params), "--format", "json"], {
          redactedFlags: ["--params"], retries: opts.retries, retryDelayMs: opts.retryDelayMs,
          timeoutMs: Math.min(DEFAULT_LARK_CLI_TIMEOUT_MS, availableMs), retryBudgetMs: availableMs,
        });
        remaining();
        const data = nativeData(json, "message-details");
        const pageItems = nativeItems(data, "message-details");
        assertRawMessagePage(pageItems, "message-details");
        if (items.length + pageItems.length > maxItems) throw new MessageDetailError("detail_item_limit");
        items.push(...pageItems);
        if (data.has_more === undefined) {
          if (data.page_token != null && data.page_token !== "") throw new MessageDetailError("invalid_or_unavailable_details");
          break;
        }
        const page = nativePage(json, "message-details", tokens);
        if (!page.has_more) break;
        token = page.page_token;
      }
      assertMergeTree(rawRoot.message_id, items);
      const refreshed = /** @type {JsonObject} */ (items.find((item) => item.message_id === rawRoot.message_id));
      assertRefreshedRoot(rawRoot, refreshed);
      if (refreshed.msg_type !== "merge_forward") {
        if (items.length !== 1) throw new MessageDetailError("invalid_or_unavailable_details");
        return normalizeApiMessage(refreshed);
      }
      if (items.length === 1) throw new MessageDetailError("details_not_expanded");
      return normalizeApiMessage(refreshed, { mergeItems: items });
    } catch (error) {
      throw error instanceof MessageDetailError ? error : new MessageDetailError(detailFailureReason(error));
    }
  }

  /**
   * @param {FetchOptions} opts
   * @param {string} pageToken
   * @returns {ChatDiscoveryPage}
   */
  function fetchChatDiscoveryPage(opts, pageToken) {
    const args = [
      "im",
      "+chat-list",
      "--as",
      "user",
      "--exclude-muted",
      "--types",
      opts.chatTypes,
      "--sort",
      "active_time",
      "--page-size",
      String(opts.chatPageSize),
      "--format",
      "json",
    ];
    if (pageToken) args.push("--page-token", pageToken);
    const json = run(args, {
      redactedFlags: ["--page-token"],
      retries: opts.retries,
      retryDelayMs: opts.retryDelayMs,
    });
    const envelope = getEnvelope(json, "chats");
    return {
      chats: envelope.items.map(normalizeChat),
      has_more: envelope.has_more,
      page_token: envelope.page_token,
    };
  }

  return {
    buildPeopleContext,
    fetchChatDiscoveryPage,
    fetchChatMessages,
    fetchSentMessages,
    fetchChatMessageList,
    fetchSentMessageList,
    fetchMessageDetails,
    getSelfProfile,
    resolveChatMemberNames,
    resolveContactNames,
    resolveApplicationNames,
    resolveChatBotAppFallbackNames,
  };
}

const defaultAdapter = createLarkImAdapter();

/** @type {LarkImAdapter["buildPeopleContext"]} */
const buildPeopleContext = (messages, opts, selfProfile, scopeConfig) =>
  defaultAdapter.buildPeopleContext(messages, opts, selfProfile, scopeConfig);
/** @type {LarkImAdapter["fetchChatDiscoveryPage"]} */
const fetchChatDiscoveryPage = (opts, pageToken) => defaultAdapter.fetchChatDiscoveryPage(opts, pageToken);
/** @type {LarkImAdapter["fetchChatMessages"]} */
const fetchChatMessages = (chatIdValue, startMs, endMs, opts) =>
  defaultAdapter.fetchChatMessages(chatIdValue, startMs, endMs, opts);
/** @type {LarkImAdapter["fetchSentMessages"]} */
const fetchSentMessages = (selfOpenId, startMs, endMs, opts) =>
  defaultAdapter.fetchSentMessages(selfOpenId, startMs, endMs, opts);
/** @type {LarkImAdapter["fetchChatMessageList"]} */
const fetchChatMessageList = (chatIdValue, startMs, endMs, opts) =>
  defaultAdapter.fetchChatMessageList(chatIdValue, startMs, endMs, opts);
/** @type {LarkImAdapter["fetchSentMessageList"]} */
const fetchSentMessageList = (selfOpenId, startMs, endMs, opts) =>
  defaultAdapter.fetchSentMessageList(selfOpenId, startMs, endMs, opts);
/** @type {LarkImAdapter["fetchMessageDetails"]} */
const fetchMessageDetails = (rawRoot, opts) => defaultAdapter.fetchMessageDetails(rawRoot, opts);
/** @type {LarkImAdapter["getSelfProfile"]} */
const getSelfProfile = (opts) => defaultAdapter.getSelfProfile(opts);
/** @type {LarkImAdapter["resolveApplicationNames"]} */
const resolveApplicationNames = (appIds, opts) => defaultAdapter.resolveApplicationNames(appIds, opts);
/** @type {LarkImAdapter["resolveChatBotAppFallbackNames"]} */
const resolveChatBotAppFallbackNames = (appIdsByChat, officialApps, opts) =>
  defaultAdapter.resolveChatBotAppFallbackNames(appIdsByChat, officialApps, opts);

export {
  buildPeopleContext,
  createLarkImAdapter,
  displayNameFromUser,
  fetchChatDiscoveryPage,
  fetchChatMessages,
  fetchSentMessages,
  fetchChatMessageList,
  fetchSentMessageList,
  fetchMessageDetails,
  firstArray,
  getEnvelope,
  nativeData,
  nativePage,
  assertRawMessagePage,
  getSelfProfile,
  isBotUserOutOfChatError,
  isRestrictedModeError,
  isTransientLarkFailure,
  parseJson,
  redactCommand,
  resolveApplicationNames,
  resolveChatBotAppFallbackNames,
  runLark,
  uniqueAppIds,
  uniqueOpenIds,
};
