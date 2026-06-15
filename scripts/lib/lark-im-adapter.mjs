// @ts-check

import { spawnSync } from "node:child_process";
import {
  chatId,
  localIsoFromMs,
  readBoundedPages,
  senderId,
  senderName,
  senderType,
} from "./lark-im-core.mjs";

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
 * @param {string} stdout
 * @returns {JsonObject | null}
 */
function parseJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`lark-cli returned non-JSON output: ${message}`);
  }
}

/**
 * @param {string[]} args
 * @param {string[]} [redactedFlags]
 */
function redactCommand(args, redactedFlags = []) {
  const parts = ["lark-cli", ...args];
  for (const flag of redactedFlags) {
    const index = parts.indexOf(flag);
    if (index >= 0 && index + 1 < parts.length) parts[index + 1] = "<redacted>";
  }
  return parts.join(" ");
}

/** @param {number} ms */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {unknown} stderr */
function isTransientLarkFailure(stderr) {
  const text = String(stderr || "");
  if (/TLS handshake timeout|Client\.Timeout|timeout awaiting response headers|i\/o timeout/i.test(text)) {
    return true;
  }
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error;
    if (error?.type === "network" && error?.subtype === "timeout") return true;
    return error?.type === "api" && Number(error?.code) === 2200 && /Internal Error/i.test(String(error?.message || ""));
  } catch {
    return false;
  }
}

/**
 * @param {string[]} args
 * @param {AdapterRunOptions} [options]
 * @returns {JsonObject | null}
 */
function runLark(args, options = {}) {
  const bin = process.env.LARK_CLI || "lark-cli";
  const retries = Number(options.retries ?? 0);
  const retryDelayMs = Number(options.retryDelayMs ?? 1000);
  let lastResult = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = spawnSync(bin, args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    lastResult = result;
    if (result.status === 0) return parseJson(result.stdout || "");
    const stderr = result.stderr.trim();
    if (attempt < retries && isTransientLarkFailure(stderr)) {
      sleepMs(retryDelayMs);
      continue;
    }
    break;
  }
  const stderr = lastResult?.stderr?.trim() || "";
  throw new Error(`${redactCommand(args, options.redactedFlags)} failed: ${stderr}`);
}

/** @param {...unknown} values */
function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
}

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

/** @param {unknown} user */
function displayNameFromUser(user) {
  if (!user || typeof user !== "object") return "";
  const objectUser = /** @type {JsonObject} */ (user);
  return objectUser.localized_name || objectUser.name || objectUser.display_name || objectUser.en_name || objectUser.open_id || "";
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0).map(String))];
}

/** @param {unknown[]} values */
function uniqueOpenIds(values) {
  return uniqueNonEmpty(values).filter((value) => value.startsWith("ou_"));
}

/** @param {unknown[]} values */
function uniqueAppIds(values) {
  return uniqueNonEmpty(values).filter((value) => value.startsWith("cli_"));
}

/**
 * @template T
 * @param {T[]} values
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/** @param {unknown} error */
function isRestrictedModeError(error) {
  const message = String(error instanceof Error ? error.message : error || "");
  return /"code"\s*:\s*231203|Restricted Mode|don't allow copying or forwarding messages/i.test(message);
}

/** @param {unknown} bot */
function botName(bot) {
  if (!bot || typeof bot !== "object") return "";
  const objectBot = /** @type {JsonObject} */ (bot);
  return objectBot.bot_name || objectBot.name || objectBot.display_name || "";
}

/** @param {unknown} bot */
function botAppId(bot) {
  if (!bot || typeof bot !== "object") return "";
  const objectBot = /** @type {JsonObject} */ (bot);
  return objectBot.app_id || objectBot.application_id || objectBot.bot_app_id || objectBot.cli_id || "";
}

/**
 * @param {{run?: LarkRunner}} [deps]
 * @returns {LarkImAdapter}
 */
function createLarkImAdapter({ run = runLark } = {}) {
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

  /**
   * @param {unknown[]} openIds
   * @param {AdapterOptions} opts
   * @param {Map<string, string>} [seed]
   */
  function resolveContactNames(openIds, opts, seed = new Map()) {
    const names = new Map(seed);
    const unresolved = uniqueOpenIds(openIds).filter((id) => !names.has(id));
    for (const ids of chunk(unresolved, 100)) {
      try {
        const json = run(
          [
            "contact",
            "+search-user",
            "--user-ids",
            ids.join(","),
            "--as",
            "user",
            "--format",
            "json",
          ],
          {
            redactedFlags: ["--user-ids"],
            retries: opts.retries,
            retryDelayMs: opts.retryDelayMs,
          },
        );
        const users = firstArray(json?.users, json?.data?.users);
        for (const user of users) {
          const openId = user?.open_id;
          const name = displayNameFromUser(user);
          if (openId && name) names.set(openId, name);
        }
      } catch {
        // Name enrichment is best-effort; message sync correctness must not depend on it.
      }
    }
    return names;
  }

  /**
   * @param {string} chatIdValue
   * @param {unknown[]} openIds
   * @param {AdapterOptions} opts
   */
  function resolveChatMemberNames(chatIdValue, openIds, opts) {
    const targetIds = new Set(uniqueOpenIds(openIds));
    const names = new Map();
    if (!chatIdValue || targetIds.size === 0) return names;

    let pageToken = "";
    for (let page = 0; page < 50 && targetIds.size > 0; page += 1) {
      const params = {
        chat_id: chatIdValue,
        member_id_type: "open_id",
        page_size: 100,
      };
      if (pageToken) params.page_token = pageToken;
      try {
        const json = run(
          [
            "im",
            "chat.members",
            "get",
            "--as",
            "user",
            "--params",
            JSON.stringify(params),
            "--format",
            "json",
          ],
          {
            redactedFlags: ["--params"],
            retries: opts.retries,
            retryDelayMs: opts.retryDelayMs,
          },
        );
        const items = firstArray(json?.items, json?.data?.items);
        for (const item of items) {
          const memberId = item?.member_id;
          const name = item?.name || item?.localized_name || "";
          if (memberId && targetIds.has(memberId) && name) {
            names.set(memberId, name);
            targetIds.delete(memberId);
          }
        }
        const hasMore = Boolean(json?.has_more ?? json?.data?.has_more);
        pageToken = json?.page_token || json?.data?.page_token || "";
        if (!hasMore || !pageToken) break;
      } catch {
        break;
      }
    }
    return names;
  }

  /**
   * @param {unknown[]} appIds
   * @param {AdapterOptions} opts
   */
  function resolveApplicationNames(appIds, opts) {
    const names = new Map();
    for (const appId of uniqueAppIds(appIds)) {
      try {
        const json = run(
          [
            "api",
            "GET",
            `/open-apis/application/v6/applications/${appId}`,
            "--as",
            "bot",
            "--params",
            JSON.stringify({ lang: "zh_cn" }),
            "--format",
            "json",
          ],
          {
            retries: opts.retries,
            retryDelayMs: opts.retryDelayMs,
          },
        );
        const app = json?.data?.app || json?.app;
        const name = app?.app_name || firstArray(app?.i18n).find((item) => item?.i18n_key === "zh_cn")?.name || "";
        if (name) names.set(appId, name);
      } catch {
        // App-name enrichment is best-effort. If permission is missing, leave it unresolved.
      }
    }
    return names;
  }

  /**
   * @param {Map<string, Set<string>>} appIdsByChat
   * @param {Map<string, string>} officialApps
   * @param {AdapterOptions} opts
   */
  function resolveChatBotAppFallbackNames(appIdsByChat, officialApps, opts) {
    const names = new Map();
    for (const [chatIdValue, ids] of appIdsByChat.entries()) {
      const pendingIds = uniqueAppIds([...ids]).filter((id) => !officialApps.has(id));
      if (pendingIds.length === 0) continue;
      try {
        const json = run(
          [
            "im",
            "chat.members",
            "bots",
            "--as",
            "user",
            "--params",
            JSON.stringify({ chat_id: chatIdValue }),
            "--format",
            "json",
          ],
          {
            redactedFlags: ["--params"],
            retries: opts.retries,
            retryDelayMs: opts.retryDelayMs,
          },
        );
        const bots = firstArray(json?.items, json?.data?.items).filter((bot) => botName(bot));
        const directMatches = new Set();
        for (const bot of bots) {
          const appId = botAppId(bot);
          if (pendingIds.includes(appId)) {
            directMatches.add(appId);
            names.set(`${chatIdValue}:${appId}`, {
              name: botName(bot),
              source: "chat_bot_app_id",
              confidence: "high",
            });
          }
        }

        const remainingIds = pendingIds.filter((id) => !directMatches.has(id));
        const remainingBots = bots.filter((bot) => !directMatches.has(botAppId(bot)));
        if (remainingIds.length === 1 && remainingBots.length === 1) {
          names.set(`${chatIdValue}:${remainingIds[0]}`, {
            name: botName(remainingBots[0]),
            source: "chat_bot_unique",
            confidence: "medium",
          });
        }
      } catch {
        // Fallback display-name enrichment must never block message sync.
      }
    }
    return names;
  }

  /**
   * @param {any[]} messages
   * @param {AdapterOptions} opts
   * @param {SelfProfile | null} selfProfile
   * @param {JsonObject} [scopeConfig]
   */
  function buildPeopleContext(messages, opts, selfProfile, scopeConfig = {}) {
    const seed = new Map();
    if (selfProfile?.open_id && selfProfile?.name) seed.set(selfProfile.open_id, selfProfile.name);

    const contactIds = [];
    const unresolvedByChat = new Map();
    const appIds = [];
    const appIdsByChat = new Map();
    for (const message of messages) {
      const id = senderId(message);
      const isAppSender = senderType(message) === "app" || String(id || "").startsWith("cli_");
      if (id && !senderName(message) && !isAppSender) contactIds.push(id);
      const effectiveChatId = chatId(message) || scopeConfig.chat_id || "";
      if (id && !senderName(message) && isAppSender) {
        appIds.push(id);
        if (effectiveChatId) {
          if (!appIdsByChat.has(effectiveChatId)) appIdsByChat.set(effectiveChatId, new Set());
          appIdsByChat.get(effectiveChatId).add(id);
        }
      }

      const partner = message?.chat_partner && typeof message.chat_partner === "object" ? message.chat_partner : null;
      const partnerId = partner?.open_id || partner?.id || partner?.user_id || "";
      if (partnerId && !(partner.name || partner.display_name)) contactIds.push(partnerId);

      const effectiveChatType = message?.chat_type || message?.chat?.chat_type || scopeConfig.chat_type || "";
      if (effectiveChatId && effectiveChatType !== "p2p" && id && !senderName(message) && !isAppSender) {
        if (!unresolvedByChat.has(effectiveChatId)) unresolvedByChat.set(effectiveChatId, new Set());
        unresolvedByChat.get(effectiveChatId).add(id);
      }
    }

    const contacts = resolveContactNames(contactIds, opts, seed);
    const chatMembers = new Map();
    for (const [chat, ids] of unresolvedByChat.entries()) {
      const names = resolveChatMemberNames(chat, [...ids].filter((id) => !contacts.has(id)), opts);
      for (const [id, name] of names.entries()) chatMembers.set(`${chat}:${id}`, name);
    }
    const apps = resolveApplicationNames(appIds, opts);
    const appFallbacks = resolveChatBotAppFallbackNames(appIdsByChat, apps, opts);
    return {
      self: selfProfile || null,
      contacts,
      chat_members: chatMembers,
      apps,
      app_fallbacks: appFallbacks,
      userNames: contacts,
      chatMemberNames: chatMembers,
      appNames: apps,
      appFallbackNames: appFallbacks,
    };
  }

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
