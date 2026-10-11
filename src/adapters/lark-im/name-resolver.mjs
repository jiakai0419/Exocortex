// @ts-check

import { createHash } from "node:crypto";
import {
  chatId,
  senderId,
  senderName,
  senderType,
} from "./core.mjs";
import { displayNameFromUser, personName, senderAliasesByOpenId, senderIdentity, senderOpenId } from "./sender-identity.mjs";

/**
 * @typedef {Record<string, any>} JsonObject
 *
 * @typedef {object} AdapterRunOptions
 * @property {string[]=} redactedFlags
 * @property {number=} retries
 * @property {number=} retryDelayMs
 * @property {number=} retryBudgetMs
 * @property {number=} timeoutMs
 *
 * @typedef {(args: string[], options?: AdapterRunOptions) => JsonObject | null} LarkRunner
 *
 * @typedef {object} AdapterOptions
 * @property {number=} retries
 * @property {number=} retryDelayMs
 * @property {boolean=} forceRefresh Bypass name caches for an explicit probe.
 * @property {number=} memberPageLimit Optional tighter bound for an exact verification.
 * @property {number=} nameLookupDeadlineMs Shared absolute deadline for optional detail enrichment.
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
 * @property {Map<string, JsonObject>} sender_name_observations
 *
 * @typedef {object} NameResolver
 * @property {(openIds: unknown[], opts: AdapterOptions, seed?: Map<string, string>, aliases?: Map<string, string[]>) => Map<string, string>} resolveContactNames
 * @property {(chatIdValue: string, openIds: unknown[], opts: AdapterOptions, aliases?: Map<string, string[]>) => Map<string, string>} resolveChatMemberNames
 * @property {(appIds: unknown[], opts: AdapterOptions) => Map<string, string>} resolveApplicationNames
 * @property {(appIdsByChat: Map<string, Set<string>>, officialApps: Map<string, string>, opts: AdapterOptions) => Map<string, NameDetails>} resolveChatBotAppFallbackNames
 * @property {(message: JsonObject, adoptedName: unknown, selfProfile: SelfProfile, opts?: AdapterOptions) => JsonObject} verifySenderName
 * @property {(id: string, chat?: string) => JsonObject | null} senderNameObservation
 * @property {(messages: any[], opts: AdapterOptions, selfProfile: SelfProfile | null, scopeConfig?: JsonObject) => PeopleContext} buildPeopleContext
 */

/** @param {...unknown} values */
function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) || [];
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

// Optional enrichment yields to ingestion. This is an application budget,
// not an API rate limit; explicit enrichment keeps the same request bound.
const NAME_LOOKUP_RETRY_BUDGET_MS = 5000;

/**
 * @param {{run: LarkRunner, now?: () => number, onLookup?: (event: JsonObject) => void}} deps
 * @returns {NameResolver}
 */
function createNameResolver({ run, now = Date.now, onLookup }) {
  /** @param {string[]} args @param {AdapterRunOptions} options @param {AdapterOptions} opts */
  function lookup(args, options, opts) {
    if (opts.nameLookupDeadlineMs === undefined) return run(args, options);
    const remaining = Math.floor(opts.nameLookupDeadlineMs - Date.now());
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('optional name lookup budget exhausted');
    const budget = Math.min(NAME_LOOKUP_RETRY_BUDGET_MS, remaining);
    return run(args, { ...options, timeoutMs: budget, retryBudgetMs: budget });
  }
  // An explicit observer receives private lookup evidence for its own report.
  // Nothing is logged here; observer failures cannot affect name resolution.
  const reportLookup = (/** @type {JsonObject} */ event) => {
    try { onLookup?.(event); } catch { /* Diagnostics are optional. */ }
  };
  // Resolver-local, positive-only cache: never persist profile data or retain
  // failed lookups. Reads refresh LRU order, not the five-minute rename TTL.
  const cacheTtlMs = 5 * 60 * 1000;
  const cacheMaxEntries = 1000;
  /** @type {Map<string, {name: string, expiresAt: number, observed_at: string}>} */
  const nameCache = new Map();
  let contextAccount = '';
  // One bounded latest result per lookup route, not a profile history. Cache
  // reuse carries the original observation time and is never a fresh check.
  /** @type {Map<string, JsonObject>} */
  const observations = new Map();
  /** @param {string} key @param {JsonObject} value */
  function observe(key, value) {
    observations.delete(key);
    observations.set(key, { observed_at: new Date(now()).toISOString(), cached: false,
      ...(contextAccount ? { account_key: createHash('sha256').update(`lark.im\0${contextAccount}`).digest('hex') } : {}), ...value });
    if (observations.size > cacheMaxEntries) { const oldest = observations.keys().next().value; if (oldest !== undefined) observations.delete(oldest); }
  }
  /** @param {string} id @param {string} [chat] */
  function senderNameObservation(id, chat = '') {
    const keys = id.startsWith('cli_') ? [`app:${id}`, `bot:${JSON.stringify([chat, id])}`]
      : [`user:${id}`, `member:${JSON.stringify([chat, id])}`];
    const values = keys.map(key => observations.get(key)).filter(Boolean);
    const selected = values.find(value => value?.status === 'conflict')
      || values.find(value => value?.status === 'resolved')
      || values.find(value => value?.status === 'failed') || values.at(-1);
    return selected ? { ...selected } : null;
  }

  /** @param {string} key */
  function cachedName(key) {
    const entry = nameCache.get(key);
    if (!entry) return "";
    nameCache.delete(key);
    if (entry.expiresAt <= now()) return "";
    nameCache.set(key, entry);
    observe(key, { status: 'resolved', name: entry.name, source: key.startsWith('user:') ? 'contact' : key.startsWith('member:') ? 'chat_member' : 'application_api', observed_at: entry.observed_at, cached: true });
    return entry.name;
  }

  /**
   * @param {string} key
   * @param {unknown} name
   */
  function cacheName(key, name) {
    if (typeof name !== "string" || !name.trim()) return;
    nameCache.delete(key);
    nameCache.set(key, { name, expiresAt: now() + cacheTtlMs, observed_at: new Date(now()).toISOString() });
    if (nameCache.size > cacheMaxEntries) {
      const oldestKey = nameCache.keys().next().value;
      if (oldestKey !== undefined) nameCache.delete(oldestKey);
    }
  }

  /**
   * @param {unknown[]} openIds
   * @param {AdapterOptions} opts
   * @param {Map<string, string>} [seed]
   * @param {Map<string, string[]>} [aliases]
   */
  function resolveContactNames(openIds, opts, seed = new Map(), aliases = new Map()) {
    const names = new Map([...seed].filter(([id, name]) => personName(name, [id, ...(aliases.get(id) || [])])));
    const unresolved = uniqueOpenIds(openIds).filter((id) => {
      if (names.has(id)) return false;
      if (opts.forceRefresh) nameCache.delete(`user:${id}`);
      const name = personName(cachedName(`user:${id}`), [id, ...(aliases.get(id) || [])]);
      if (name) names.set(id, name);
      else nameCache.delete(`user:${id}`);
      return !name;
    });
    // lark-cli +search-user returns at most 30 users per page. Keep each ID
    // batch within that page and request it explicitly rather than default 20.
    for (const ids of chunk(unresolved, 30)) {
      try {
        const json = lookup(
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
            retryBudgetMs: NAME_LOOKUP_RETRY_BUDGET_MS,
          },
          opts,
        );
        const users = firstArray(json?.users, json?.data?.users);
        /** @type {Map<string, string | null>} */
        const responseNames = new Map();
        const conflicts = new Set();
        for (const user of users) {
          const openId = user?.open_id;
          if (!ids.includes(openId)) continue;
          const name = displayNameFromUser(user, aliases.get(openId));
          const previous = responseNames.get(openId);
          if (responseNames.has(openId) && previous !== name) conflicts.add(openId);
          responseNames.set(openId, !name || responseNames.has(openId) && previous !== name ? null : name);
        }
        for (const openId of ids) {
          const name = responseNames.get(openId);
          observe(`user:${openId}`, { status: name ? 'resolved' : conflicts.has(openId) ? 'conflict' : 'unresolved', source: 'contact', ...(name ? { name } : {}) });
          if (!name) { nameCache.delete(`user:${openId}`); continue; }
          names.set(openId, name);
          cacheName(`user:${openId}`, name);
        }
      } catch {
        for (const id of ids) observe(`user:${id}`, { status: 'failed', source: 'contact' });
        // Name enrichment is best-effort; message sync correctness must not depend on it.
      }
    }
    return names;
  }

  /**
   * @param {string} chatIdValue
   * @param {unknown[]} openIds
   * @param {AdapterOptions} opts
   * @param {Map<string, string[]>} [aliases]
   */
  function resolveChatMemberNames(chatIdValue, openIds, opts, aliases = new Map()) {
    const targetIds = new Set(uniqueOpenIds(openIds).filter(id => observations.get(`user:${id}`)?.status !== 'conflict'));
    const names = new Map();
    if (!chatIdValue || targetIds.size === 0) return names;

    for (const id of targetIds) {
      const key = `member:${JSON.stringify([chatIdValue, id])}`;
      if (opts.forceRefresh) nameCache.delete(key);
      const name = personName(cachedName(key), [id, ...(aliases.get(id) || [])]);
      if (name) {
        names.set(id, name);
        targetIds.delete(id);
      } else nameCache.delete(key);
    }

    let pageToken = "";
    const requestedIds = new Set(targetIds);
    /** @type {Map<string, string | null>} */
    const responseNames = new Map();
    const conflicts = new Set();
    for (const id of requestedIds) observe(`member:${JSON.stringify([chatIdValue, id])}`, { status: 'unresolved', source: 'chat_member' });
    for (let page = 0; page < Math.min(50, opts.memberPageLimit ?? 50) && targetIds.size > 0; page += 1) {
      const params = {
        chat_id: chatIdValue,
        member_id_type: "open_id",
        page_size: 100,
      };
      if (pageToken) params.page_token = pageToken;
      try {
        const json = lookup(
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
            retryBudgetMs: NAME_LOOKUP_RETRY_BUDGET_MS,
          },
          opts,
        );
        const items = firstArray(json?.items, json?.data?.items);
        for (const item of items) {
          const memberId = item?.member_id;
          if (!requestedIds.has(memberId)) continue;
          const name = item?.member_id_type && item.member_id_type !== "open_id" ? ""
            : displayNameFromUser(item, aliases.get(memberId));
          const previous = responseNames.get(memberId);
          if (item?.member_id_type && item.member_id_type !== 'open_id'
            || responseNames.has(memberId) && previous !== name) conflicts.add(memberId);
          responseNames.set(memberId, !name || responseNames.has(memberId) && previous !== name ? null : name);
        }
        for (const [memberId, name] of responseNames) {
          const key = `member:${JSON.stringify([chatIdValue, memberId])}`;
          observe(key, { status: name ? 'resolved' : conflicts.has(memberId) ? 'conflict' : 'unresolved', source: 'chat_member', ...(name ? { name } : {}) });
          if (!name) { names.delete(memberId); nameCache.delete(key); targetIds.add(memberId); continue; }
          names.set(memberId, name);
          cacheName(key, name);
          targetIds.delete(memberId);
        }
        const hasMore = Boolean(json?.has_more ?? json?.data?.has_more);
        pageToken = json?.page_token || json?.data?.page_token || "";
        if (!hasMore || !pageToken) break;
      } catch {
        for (const id of targetIds) {
          const key = `member:${JSON.stringify([chatIdValue, id])}`;
          if (observations.get(key)?.status !== 'conflict') observe(key, { status: 'failed', source: 'chat_member' });
        }
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
      if (opts.forceRefresh) nameCache.delete(`app:${appId}`);
      const cached = personName(cachedName(`app:${appId}`), [appId]);
      if (cached) {
        names.set(appId, cached);
        reportLookup({ kind: "application", app_id: appId, status: "resolved", name: cached, cached: true });
        continue;
      }
      try {
        const json = lookup(
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
            retryBudgetMs: NAME_LOOKUP_RETRY_BUDGET_MS,
          },
          opts,
        );
        const app = json?.data?.app || json?.app;
        const identityConflict = [app?.app_id, app?.application_id].some(id => id != null && id !== appId);
        const name = identityConflict ? '' : [app?.app_name,
          firstArray(app?.i18n).find((item) => item?.i18n_key === "zh_cn")?.name]
          .map(value => personName(value, [appId])).find(Boolean) || '';
        observe(`app:${appId}`, { status: identityConflict ? 'conflict' : name ? 'resolved' : 'unresolved',
          source: 'application_api', ...(name ? { name } : {}) });
        if (name) {
          names.set(appId, name);
          cacheName(`app:${appId}`, name);
          reportLookup({ kind: "application", app_id: appId, status: "resolved", name, cached: false });
        } else {
          reportLookup({ kind: "application", app_id: appId, status: "missing_name", cached: false });
        }
      } catch (error) {
        observe(`app:${appId}`, { status: 'failed', source: 'application_api' });
        reportLookup({ kind: "application", app_id: appId, status: "failed", error, cached: false });
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
      const pendingIds = uniqueAppIds([...ids]).filter((id) => !personName(officialApps.get(id), [id])
        && observations.get(`app:${id}`)?.status !== 'conflict');
      if (pendingIds.length === 0) continue;
      try {
        const json = lookup(
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
            retryBudgetMs: NAME_LOOKUP_RETRY_BUDGET_MS,
          },
          opts,
        );
        const bots = firstArray(json?.items, json?.data?.items).filter((bot) => personName(botName(bot), [botAppId(bot), bot?.bot_id, bot?.open_id]));
        const directMatches = new Set();
        const conflicting = new Set();
        for (const appId of pendingIds) {
          const matching = bots.filter(bot => botAppId(bot) === appId);
          const candidates = new Set(matching.map(bot => personName(botName(bot), [appId])));
          const key = `bot:${JSON.stringify([chatIdValue, appId])}`;
          if (candidates.size > 1) {
            conflicting.add(appId);
            observe(key, { status: 'conflict', source: 'chat_bot_app_id' });
          } else if (candidates.size === 1) {
            const name = [...candidates][0];
            directMatches.add(appId);
            names.set(`${chatIdValue}:${appId}`, { name, source: 'chat_bot_app_id', confidence: 'high' });
            observe(key, { status: 'resolved', name, source: 'chat_bot_app_id' });
          } else observe(key, { status: 'unresolved', source: 'chat_bot_app_id' });
        }

        const remainingIds = pendingIds.filter((id) => !directMatches.has(id) && !conflicting.has(id));
        const remainingBots = bots.filter((bot) => !directMatches.has(botAppId(bot)) && !conflicting.has(botAppId(bot)));
        const uniqueFallback = remainingIds.length === 1 && remainingBots.length === 1
          && Boolean(personName(botName(remainingBots[0]), [remainingIds[0]]));
        if (uniqueFallback) {
          names.set(`${chatIdValue}:${remainingIds[0]}`, {
            name: botName(remainingBots[0]),
            source: "chat_bot_unique",
            confidence: "medium",
          });
        }
        const ambiguous = remainingIds.length > 0 && remainingBots.length > 0 && !uniqueFallback;
        reportLookup({ kind: "chat_bots", chat_id: chatIdValue,
          status: ambiguous ? "ambiguous" : directMatches.size > 0 || uniqueFallback ? "resolved" : "unresolved",
          pending_app_ids: remainingIds.length, bot_candidates: remainingBots.length });
      } catch (error) {
        for (const id of pendingIds) observe(`bot:${JSON.stringify([chatIdValue, id])}`, { status: 'failed', source: 'chat_bot_app_id' });
        reportLookup({ kind: "chat_bots", chat_id: chatIdValue, status: "failed", error });
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
    // A resolver may be reused in one process; never attribute another account's
    // cached authority to the current sync account when persisting provenance.
    observations.clear();
    const account = selfProfile?.open_id || '';
    if (account !== contextAccount) { nameCache.clear(); contextAccount = account; }
    const aliases = senderAliasesByOpenId(messages);
    const seed = new Map();
    if (selfProfile?.open_id && selfProfile?.name) seed.set(selfProfile.open_id, selfProfile.name);

    const contactIds = [];
    const unresolvedByChat = new Map();
    const appIds = [];
    const appIdsByChat = new Map();
    for (const message of messages) {
      const id = senderId(message);
      const isAppSender = senderType(message) === "app" || String(id || "").startsWith("cli_");
      const openId = senderOpenId(message);
      if (openId && !senderName(message) && !isAppSender) contactIds.push(openId);
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
      if (effectiveChatId && effectiveChatType !== "p2p" && openId && !senderName(message) && !isAppSender) {
        if (!unresolvedByChat.has(effectiveChatId)) unresolvedByChat.set(effectiveChatId, new Set());
        unresolvedByChat.get(effectiveChatId).add(openId);
      }
    }

    const contacts = resolveContactNames(contactIds, opts, seed, aliases);
    const chatMembers = new Map();
    for (const [chat, ids] of unresolvedByChat.entries()) {
      const names = resolveChatMemberNames(chat, [...ids].filter((id) => !contacts.has(id)), opts, aliases);
      for (const [id, name] of names.entries()) chatMembers.set(`${chat}:${id}`, name);
    }
    const apps = resolveApplicationNames(appIds, opts);
    const appFallbacks = resolveChatBotAppFallbackNames(appIdsByChat, apps, opts);
    /** @type {Map<string, JsonObject>} */
    const senderObservations = new Map();
    for (const message of messages) {
      const id = senderId(message), chat = chatId(message) || scopeConfig.chat_id || '';
      const observation = senderNameObservation(id, chat);
      if (!observation) continue;
      if (senderObservations.size < cacheMaxEntries) senderObservations.set(JSON.stringify([chat, id]), observation);
      if (observation.status === 'conflict') {
        contacts.delete(id); chatMembers.delete(`${chat}:${id}`); apps.delete(id); appFallbacks.delete(`${chat}:${id}`);
      }
    }
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
      sender_name_observations: senderObservations,
    };
  }

  /** Exact, read-only verification using existing lookup routes. No scan, no
   * persistence, no inferred identity and no unbound/unique bot inference.
   * @param {JsonObject} message @param {unknown} adoptedName @param {SelfProfile} selfProfile @param {AdapterOptions} [opts] */
  function verifySenderName(message, adoptedName, selfProfile, opts = {}) {
    const identity = senderIdentity(message);
    const native = message.raw_api && typeof message.raw_api === 'object' && !Array.isArray(message.raw_api) ? message.raw_api : message;
    const chat = chatId(native);
    if (chatId(message) && chatId(message) !== chat
      || !/^ou_[A-Za-z0-9_-]+$/.test(selfProfile?.open_id || '')
      || !identity.verified || identity.conflict || !['open_id', 'app_id'].includes(identity.type || '')) {
      return { status: 'conflict', reason: 'unverified_identity', adopted_name: adoptedName, observation: null };
    }
    observations.clear();
    if (contextAccount !== selfProfile.open_id) nameCache.clear();
    contextAccount = selfProfile.open_id;
    const bounded = { ...opts, forceRefresh: true, retries: 0, retryDelayMs: 0, memberPageLimit: 2,
      nameLookupDeadlineMs: Math.min(opts.nameLookupDeadlineMs ?? Infinity, Date.now() + 15_000) };
    if (identity.type === 'open_id') {
      const aliases = senderAliasesByOpenId([message]);
      const contacts = resolveContactNames([identity.id], bounded, new Map(), aliases);
      if (!contacts.has(identity.id) && chat && (native.chat_type || native.chat?.chat_type) !== 'p2p')
        resolveChatMemberNames(chat, [identity.id], bounded, aliases);
    } else {
      const apps = resolveApplicationNames([identity.id], bounded);
      if (!apps.has(identity.id) && chat)
        resolveChatBotAppFallbackNames(new Map([[chat, new Set([identity.id])]]), apps, bounded);
    }
    const observation = senderNameObservation(identity.id, chat);
    return { status: observation?.status === 'resolved'
      ? observation.name === adoptedName ? 'same' : 'changed' : observation?.status || 'unresolved',
    adopted_name: adoptedName, observation };
  }

  return {
    buildPeopleContext,
    resolveApplicationNames,
    resolveChatBotAppFallbackNames,
    resolveChatMemberNames,
    resolveContactNames,
    senderNameObservation,
    verifySenderName,
  };
}

export {
  NAME_LOOKUP_RETRY_BUDGET_MS,
  createNameResolver,
  displayNameFromUser,
  firstArray,
  uniqueAppIds,
  uniqueOpenIds,
};
