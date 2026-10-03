// @ts-check

import {
  chatId,
  senderId,
  senderName,
  senderType,
} from "./core.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} AdapterRunOptions
 * @property {string[]=} redactedFlags
 * @property {number=} retries
 * @property {number=} retryDelayMs
 * @property {number=} retryBudgetMs
 *
 * @typedef {(args: string[], options?: AdapterRunOptions) => JsonObject | null} LarkRunner
 *
 * @typedef {object} AdapterOptions
 * @property {number=} retries
 * @property {number=} retryDelayMs
 *
 * @typedef {object} SelfProfile
 * @property {string} open_id
 * @property {string} name
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
 * @typedef {object} NameResolver
 * @property {(openIds: unknown[], opts: AdapterOptions, seed?: Map<string, string>) => Map<string, string>} resolveContactNames
 * @property {(chatIdValue: string, openIds: unknown[], opts: AdapterOptions) => Map<string, string>} resolveChatMemberNames
 * @property {(appIds: unknown[], opts: AdapterOptions) => Map<string, string>} resolveApplicationNames
 * @property {(appIdsByChat: Map<string, Set<string>>, officialApps: Map<string, string>, opts: AdapterOptions) => Map<string, NameDetails>} resolveChatBotAppFallbackNames
 * @property {(messages: any[], opts: AdapterOptions, selfProfile: SelfProfile | null, scopeConfig?: JsonObject) => PeopleContext} buildPeopleContext
 */

/** @param {...unknown} values */
function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
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
 * @param {{run: LarkRunner, now?: () => number}} deps
 * @returns {NameResolver}
 */
function createNameResolver({ run, now = Date.now }) {
  // Optional enrichment must yield to message ingestion. This retry budget is
  // an application priority policy, not an official API rate limit.
  const nameLookupRetryBudgetMs = 5000;
  // Resolver-local, positive-only cache: never persist profile data or retain
  // failed lookups. Reads refresh LRU order, not the five-minute rename TTL.
  const cacheTtlMs = 5 * 60 * 1000;
  const cacheMaxEntries = 1000;
  /** @type {Map<string, {name: string, expiresAt: number}>} */
  const nameCache = new Map();

  /** @param {string} key */
  function cachedName(key) {
    const entry = nameCache.get(key);
    if (!entry) return "";
    nameCache.delete(key);
    if (entry.expiresAt <= now()) return "";
    nameCache.set(key, entry);
    return entry.name;
  }

  /**
   * @param {string} key
   * @param {unknown} name
   */
  function cacheName(key, name) {
    if (typeof name !== "string" || !name.trim()) return;
    nameCache.delete(key);
    nameCache.set(key, { name, expiresAt: now() + cacheTtlMs });
    if (nameCache.size > cacheMaxEntries) {
      const oldestKey = nameCache.keys().next().value;
      if (oldestKey !== undefined) nameCache.delete(oldestKey);
    }
  }

  /**
   * @param {unknown[]} openIds
   * @param {AdapterOptions} opts
   * @param {Map<string, string>} [seed]
   */
  function resolveContactNames(openIds, opts, seed = new Map()) {
    const names = new Map(seed);
    const unresolved = uniqueOpenIds(openIds).filter((id) => {
      if (names.has(id)) return false;
      const name = cachedName(`user:${id}`);
      if (name) names.set(id, name);
      return !name;
    });
    // lark-cli +search-user returns at most 30 users per page. Keep each ID
    // batch within that page and request it explicitly rather than default 20.
    for (const ids of chunk(unresolved, 30)) {
      try {
        const json = run(
          [
            "contact",
            "+search-user",
            "--user-ids",
            ids.join(","),
            "--page-size",
            "30",
            "--as",
            "user",
            "--format",
            "json",
          ],
          {
            redactedFlags: ["--user-ids"],
            retries: opts.retries,
            retryDelayMs: opts.retryDelayMs,
            retryBudgetMs: nameLookupRetryBudgetMs,
          },
        );
        const users = firstArray(json?.users, json?.data?.users);
        for (const user of users) {
          const openId = user?.open_id;
          const name = displayNameFromUser(user);
          if (openId && name && !seed.has(openId)) {
            names.set(openId, name);
            // An ID echoed as a display fallback is not a resolved name.
            if (ids.includes(openId) && name !== openId) cacheName(`user:${openId}`, name);
          }
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

    for (const id of targetIds) {
      const name = cachedName(`member:${JSON.stringify([chatIdValue, id])}`);
      if (name) {
        names.set(id, name);
        targetIds.delete(id);
      }
    }

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
            retryBudgetMs: nameLookupRetryBudgetMs,
          },
        );
        const items = firstArray(json?.items, json?.data?.items);
        for (const item of items) {
          const memberId = item?.member_id;
          const name = item?.name || item?.localized_name || "";
          if (memberId && targetIds.has(memberId) && name) {
            names.set(memberId, name);
            cacheName(`member:${JSON.stringify([chatIdValue, memberId])}`, name);
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
      const cached = cachedName(`app:${appId}`);
      if (cached) {
        names.set(appId, cached);
        continue;
      }
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
            retryBudgetMs: nameLookupRetryBudgetMs,
          },
        );
        const app = json?.data?.app || json?.app;
        const name = app?.app_name || firstArray(app?.i18n).find((item) => item?.i18n_key === "zh_cn")?.name || "";
        if (name) {
          names.set(appId, name);
          cacheName(`app:${appId}`, name);
        }
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
            retryBudgetMs: nameLookupRetryBudgetMs,
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

  return {
    buildPeopleContext,
    resolveApplicationNames,
    resolveChatBotAppFallbackNames,
    resolveChatMemberNames,
    resolveContactNames,
  };
}

export {
  createNameResolver,
  displayNameFromUser,
  firstArray,
  uniqueAppIds,
  uniqueOpenIds,
};
