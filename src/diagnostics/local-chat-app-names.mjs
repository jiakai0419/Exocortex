// @ts-check

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { TextDecoder } from "node:util";
import { personName, senderIdentity, senderNameFromSource } from "../adapters/lark-im/sender-identity.mjs";
import { liveProbeContext } from "./live-probe-cache.mjs";
import { senderLabel } from "./messages-report.mjs";

const MAX_BYTES = 64 * 1024;
/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{kind: "user_screenshot", recorded_at: string, evidence_refs: string[]}} MappingSource */
/** @typedef {{tenant_key: string, chat_id: string, app_id: string, name: string, source: MappingSource}} MappingEntry */
/** @typedef {{dbPath: string, requestedDbPath: string, databaseKey: string, sidecarPath: string, file: import("node:fs").BigIntStats, entries: MappingEntry[]}} LocalChatAppNames */

/** Messages are deliberately fixed: filesystem errors and mapping values are private. */
class LocalChatAppNamesError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`local chat app names: ${code.replace(/^local_chat_app_names_/, "").replaceAll("_", " ")}`);
    this.name = "LocalChatAppNamesError";
    this.code = code;
  }
}

/** @param {string} reason @returns {never} */
function fail(reason) { throw new LocalChatAppNamesError(`local_chat_app_names_${reason}`); }
/** @param {unknown} value @returns {value is JsonObject} */
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
/** @param {unknown} value @param {string[]} keys @returns {value is JsonObject} */
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
/** @param {unknown} value @param {number} max @returns {value is string} */
function shortString(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
/** @param {unknown} value */
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** @param {unknown} value @param {string} databaseKey @returns {MappingEntry[]} */
function validate(value, databaseKey) {
  if (!exactKeys(value, ["kind", "context", "entries"]) || value.kind !== "lark_im_chat_app_names/v1"
      || !exactKeys(value.context, ["database_key", "source_id"]) || value.context.source_id !== "lark.im"
      || typeof value.context.database_key !== "string" || !/^[a-f0-9]{64}$/.test(value.context.database_key)
      || !Array.isArray(value.entries) || value.entries.length > 100) fail("invalid");
  if (value.context.database_key !== databaseKey) fail("database_mismatch");
  const seen = new Set();
  for (const entry of value.entries) {
    if (!exactKeys(entry, ["tenant_key", "chat_id", "app_id", "name", "source"])
        || ![entry.tenant_key, entry.chat_id, entry.app_id].every((id) => shortString(id, 128))
        || !shortString(entry.name, 128) || !personName(entry.name, [entry.tenant_key, entry.chat_id, entry.app_id])
        || !exactKeys(entry.source, ["kind", "recorded_at", "evidence_refs"])
        || entry.source.kind !== "user_screenshot" || !timestamp(entry.source.recorded_at)
        || !Array.isArray(entry.source.evidence_refs) || entry.source.evidence_refs.length < 1 || entry.source.evidence_refs.length > 8
        || !entry.source.evidence_refs.every((ref) => shortString(ref, 256))) fail("invalid");
    const key = JSON.stringify([entry.tenant_key, entry.chat_id, entry.app_id]);
    if (seen.has(key)) fail("invalid");
    seen.add(key);
  }
  return value.entries;
}

/** @param {import("node:fs").BigIntStats} file */
function safeFile(file) {
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || typeof process.getuid !== "function"
      || file.uid !== BigInt(process.getuid()) || (file.mode & 0o7777n) !== 0o600n) fail("unsafe_file");
  if (file.size > BigInt(MAX_BYTES)) fail("invalid");
}
/** @param {import("node:fs").BigIntStats} a @param {import("node:fs").BigIntStats} b */
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** @param {unknown} error @param {string} code */
function hasCode(error, code) { return object(error) && error.code === code; }

/** Read one private, bounded sidecar. Missing configuration preserves the original display.
 * The context binds a local database file, not an authenticated remote account.
 * @param {string} dbPath
 * @returns {LocalChatAppNames | null}
 */
function readLocalChatAppNames(dbPath) {
  let canonicalPath;
  try { canonicalPath = realpathSync(dbPath); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; fail("unreadable"); }
  const sidecarPath = `${canonicalPath}.chat-app-names.json`;
  let before;
  try { before = lstatSync(sidecarPath, { bigint: true }); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; fail("unreadable"); }
  safeFile(before);
  const context = liveProbeContext(dbPath);
  if (!context || context.database_key !== liveProbeContext(canonicalPath)?.database_key) fail("database_mismatch");
  let fd;
  try {
    // NONBLOCK prevents a raced FIFO/device from hanging before fstat rejects it.
    fd = openSync(sidecarPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    safeFile(opened);
    if (!sameFile(before, opened)) fail("changed");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_BYTES) fail("invalid");
    if (BigInt(count) !== opened.size || !sameFile(opened, fstatSync(fd, { bigint: true }))
        || !sameFile(opened, lstatSync(sidecarPath, { bigint: true }))) fail("changed");
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))); }
    catch { fail("invalid"); }
    const entries = validate(parsed, context.database_key);
    const state = { dbPath: canonicalPath, requestedDbPath: dbPath, databaseKey: context.database_key, sidecarPath, file: opened, entries };
    verifyBinding(state);
    return state;
  } catch (error) {
    if (error instanceof LocalChatAppNamesError) throw error;
    return fail("unreadable");
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { fail("unreadable"); } }
  }
}

/** Recheck after the message query so a replaced file cannot authorize the result.
 * @param {LocalChatAppNames} state
 */
function verifyBinding(state) {
  if (liveProbeContext(state.requestedDbPath)?.database_key !== state.databaseKey
      || liveProbeContext(state.dbPath)?.database_key !== state.databaseKey) fail("database_mismatch");
  try {
    const current = lstatSync(state.sidecarPath, { bigint: true });
    if (!sameFile(state.file, current)) fail("changed");
  } catch (error) {
    if (error instanceof LocalChatAppNamesError) throw error;
    fail("changed");
  }
}

/** Missing projections may be filled, but an observed disagreement never is.
 * @param {unknown[]} values @param {string} expected
 */
function agree(values, expected) { return values.every((value) => value === undefined || value === null || value === "" || value === expected); }

/** @param {import("./messages-report.mjs").EnrichedMessage} message @param {MappingEntry[]} entries */
function findEntry(message, entries) {
  const { raw, canonical, scope_config: config } = message;
  if (!object(raw) || !object(canonical) || !object(config) || message.record_type !== "lark.im.message") return null;
  if (Object.hasOwn(raw, "raw_api") && !object(raw.raw_api)) return null;
  const native = object(raw.raw_api) ? raw.raw_api : raw;
  const sender = object(native.sender) ? native.sender : {};
  const outerSender = object(raw.sender) ? raw.sender : {};
  const identity = senderIdentity(raw);
  if (!identity.verified || identity.conflict || identity.type !== "app_id"
      || !shortString(sender.tenant_key, 128) || !shortString(native.chat_id, 128)) return null;
  const entry = entries.find((item) => item.tenant_key === sender.tenant_key && item.chat_id === native.chat_id && item.app_id === identity.id);
  if (!entry || !personName(entry.name, identity.identifiers)
      || !agree([message.source_id, canonical.source_id, raw.source_id], "lark.im")
      || !agree([message.actor_id, canonical.sender_id, raw.sender_id], entry.app_id)
      || !agree([message.container_id, canonical.chat_id, raw.chat_id, config.chat_id, raw.chat?.chat_id], entry.chat_id)
      || !agree([canonical.sender_id_type, raw.sender_id_type, native.sender_id_type], "app_id")
      || !agree([canonical.sender_type, raw.sender_type, native.sender_type, sender.sender_type, outerSender.sender_type], "app")
      || !agree([canonical.tenant_key, raw.tenant_key, config.tenant_key, outerSender.tenant_key], entry.tenant_key)) return null;
  if (raw !== native) {
    const outerIdentity = senderIdentity({ sender: outerSender });
    const nested = object(outerSender.sender_id) ? outerSender.sender_id : {};
    const personNamespace = ["open_id", "user_id", "union_id"].some((type) =>
      [outerSender[type], nested[type]].some((value) => value !== undefined && value !== null && value !== ""));
    if (outerIdentity.conflict || personNamespace || !agree([outerIdentity.type], "app_id")
        || !agree(outerIdentity.identifiers, entry.app_id)) return null;
  }
  if ([canonical.sender_name_state, raw.sender_name_state, native.sender_name_state, sender.name_state, outerSender.name_state].includes("cleared")) return null;
  if (personName(canonical.sender_name, identity.identifiers) || senderNameFromSource(raw)
      || personName(outerSender.name, identity.identifiers) || personName(outerSender.display_name, identity.identifiers)) return null;
  return entry;
}

/** Apply to the display alone; stored/canonical fields retain their exact values.
 * @param {import("./messages-report.mjs").EnrichedMessage[]} messages
 * @param {LocalChatAppNames | null} state
 */
function applyLocalChatAppNames(messages, state) {
  if (!state) return messages;
  verifyBinding(state);
  return messages.map((message) => {
    const entry = findEntry(message, state.entries);
    if (!entry) return message;
    return { ...message, display: { ...message.display, sender: senderLabel(entry.name, entry.app_id, "app"),
      sender_name_source: { kind: "local_chat_app_name", source_kind: entry.source.kind,
        recorded_at: entry.source.recorded_at, evidence_refs: [...entry.source.evidence_refs] } } };
  });
}

export { applyLocalChatAppNames, LocalChatAppNamesError, readLocalChatAppNames };
