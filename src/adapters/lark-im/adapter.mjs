// @ts-check

import {
  localIsoFromMs,
  readBoundedPages,
} from "./core.mjs";
import {
  createNameResolver,
  displayNameFromUser,
  firstArray,
  uniqueAppIds,
  uniqueOpenIds,
} from "./name-resolver.mjs";
import {
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
 * @property {(opts: FetchOptions, pageToken: string) => ChatDiscoveryPage} fetchChatDiscoveryPage
 */

/**
 * @param {JsonObject | null} json
 * @param {string} collectionName
 * @returns {ApiEnvelope}
 */
function getEnvelope(json, collectionName) {
  const root = json && typeof json === "object" ? json : /** @type {JsonObject} */ ({});
  const data = root.data && typeof root.data === "object" ? /** @type {JsonObject} */ (root.data) : {};
  return {
    items: firstArray(root[collectionName], data[collectionName], root.items, data.items, root.results, data.results),
    has_more: Boolean(root.has_more ?? data.has_more),
    page_token: root.page_token || data.page_token || "",
  };
}

/** @param {unknown} error */
function isRestrictedModeError(error) {
  const message = String(error instanceof Error ? error.message : error || "");
  return /"code"\s*:\s*231203|Restricted Mode|don't allow copying or forwarding messages/i.test(message);
}

/** @param {unknown} error */
function isBotUserOutOfChatError(error) {
  const message = String(error instanceof Error ? error.message : error || "");
  return /"code"\s*:\s*230002|Bot\/User can NOT be out of the chat/i.test(message);
}

/**
 * @param {{run?: LarkRunner}} [deps]
 * @returns {LarkImAdapter}
 */
function createLarkImAdapter({ run = runLark } = {}) {
  const nameResolver = createNameResolver({ run });

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
   */
  function fetchSentMessages(selfOpenId, startMs, endMs, opts) {
    return readBoundedPages({
      maxPages: opts.maxPages,
      missingPageTokenMessage: "messages-search returned has_more without page_token",
      maxPagesMessage: (maxPages) => `messages-search still has more data after ${maxPages} pages`,
      fetchPage: (pageToken) => {
        const args = [
          "im",
          "+messages-search",
          "--as",
          "user",
          "--query",
          "",
          "--sender",
          selfOpenId,
          "--start",
          localIsoFromMs(startMs),
          "--end",
          localIsoFromMs(endMs),
          "--page-size",
          String(opts.pageSize),
          "--no-reactions",
          "--format",
          "json",
        ];
        if (pageToken) args.push("--page-token", pageToken);
        const json = run(args, {
          redactedFlags: ["--sender", "--page-token"],
          retries: opts.retries,
          retryDelayMs: opts.retryDelayMs,
        });
        const envelope = getEnvelope(json, "messages");
        return {
          messages: envelope.items,
          has_more: envelope.has_more,
          page_token: envelope.page_token,
        };
      },
    });
  }

  /**
   * @param {string} chatIdValue
   * @param {number} startMs
   * @param {number} endMs
   * @param {FetchOptions} opts
   */
  function fetchChatMessages(chatIdValue, startMs, endMs, opts) {
    return readBoundedPages({
      maxPages: opts.maxPages,
      missingPageTokenMessage: "chat-messages-list returned has_more without page_token",
      maxPagesMessage: (maxPages) => `chat-messages-list still has more data after ${maxPages} pages`,
      fetchPage: (pageToken) => {
        const args = [
          "im",
          "+chat-messages-list",
          "--as",
          "user",
          "--chat-id",
          chatIdValue,
          "--start",
          localIsoFromMs(startMs),
          "--end",
          localIsoFromMs(endMs),
          "--order",
          "asc",
          "--page-size",
          String(opts.pageSize),
          "--no-reactions",
          "--format",
          "json",
        ];
        if (pageToken) args.push("--page-token", pageToken);
        const json = run(args, {
          redactedFlags: ["--chat-id", "--page-token"],
          retries: opts.retries,
          retryDelayMs: opts.retryDelayMs,
        });
        const envelope = getEnvelope(json, "messages");
        return {
          messages: envelope.items,
          has_more: envelope.has_more,
          page_token: envelope.page_token,
        };
      },
    });
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
      chats: envelope.items
        .filter((chat) => chat?.chat_id)
        .map((chat) => ({
          chat_id: chat.chat_id,
          chat_type: chat.chat_mode || chat.chat_type || null,
          chat_name: chat.name || chat.i18n_names?.zh_cn || chat.i18n_names?.en_us || null,
        })),
      has_more: envelope.has_more,
      page_token: envelope.page_token,
    };
  }

  return {
    buildPeopleContext,
    fetchChatDiscoveryPage,
    fetchChatMessages,
    fetchSentMessages,
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
  firstArray,
  getEnvelope,
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
