// @ts-check

const PERSON_TYPES = new Set(["open_id", "user_id", "union_id"]);
const ID_TYPES = [...PERSON_TYPES, "app_id"];
/** @param {unknown} value @returns {value is Record<string, any>} */
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const nonempty = (value) => typeof value === "string" && value.length > 0;

/** @param {unknown} message */
function sourceSender(message) {
  const item = object(message) ? message : {};
  const raw = object(item.raw_api) ? item.raw_api : item;
  return object(raw.sender) ? raw.sender : {};
}

/** Source identity only. An identifier's spelling never supplies its namespace.
 * @param {unknown} message
 * @returns {{id: string, type: string | null, verified: boolean, conflict: boolean, identifiers: string[]}}
 */
function senderIdentity(message) {
  const sender = sourceSender(message);
  const nested = object(sender.sender_id) ? sender.sender_id : {};
  // Preserve the existing string selection order before adding previously
  // unhandled typed slots. Never return a sender_id object as an actor.
  const id = [sender.id, sender.open_id, nested.open_id, nested.user_id,
    nested.union_id, sender.sender_id, sender.user_id, sender.union_id,
    sender.app_id, nested.app_id].find(nonempty) || "";
  const identityValues = [sender.id, ...ID_TYPES.flatMap((type) => [sender[type], nested[type]])];
  const identifiers = [...new Set([sender.sender_id, ...identityValues].filter(nonempty))];
  const declared = nonempty(sender.id_type) ? sender.id_type : null;
  /** @type {Map<string, Set<string>>} */
  const evidence = new Map();
  /** @param {string} type @param {unknown} value */
  const add = (type, value) => {
    if (!nonempty(value)) return;
    if (!evidence.has(type)) evidence.set(type, new Set());
    evidence.get(type)?.add(value);
  };
  if (declared) add(declared, sender.id);
  for (const type of ID_TYPES) { add(type, sender[type]); add(type, nested[type]); }
  let conflict = sender.id_type != null && typeof sender.id_type !== "string"
    || identityValues.some((value) => value != null && typeof value !== "string")
    || sender.sender_id != null && typeof sender.sender_id !== "string" && !object(sender.sender_id)
    || object(sender.sender_id) && !ID_TYPES.some((type) => nonempty(nested[type]))
    || [...evidence.values()].some((values) => values.size > 1);
  const matches = [...evidence].filter(([, values]) => values.has(id)).map(([type]) => type);
  const type = declared || (matches.length === 1 ? matches[0] : null);
  if (!declared && matches.length > 1) conflict = true;
  if (type && (!id || !evidence.get(type)?.has(id))) conflict = true;
  if (id && evidence.size > 0 && matches.length === 0) conflict = true;
  return { id, type, conflict, verified: !conflict && Boolean(type && ID_TYPES.includes(type)), identifiers };
}

/** Validate a source display name against every supplied identity alias.
 * @param {unknown} message
 */
function senderNameFromSource(message) {
  const identity = senderIdentity(message);
  if (identity.conflict) return "";
  const sender = sourceSender(message);
  return personName(sender.name, identity.identifiers) || personName(sender.display_name, identity.identifiers);
}

/** Additional source evidence for optional person-name lookups. These aliases
 * only reject ID echoes; they never authorize querying another namespace.
 * @param {unknown[]} messages
 * @returns {Map<string, string[]>}
 */
function senderAliasesByOpenId(messages) {
  /** @type {Map<string, Set<string>>} */
  const aliases = new Map();
  for (const message of messages) {
    const identity = senderIdentity(message);
    if (!identity.verified || identity.type !== "open_id") continue;
    if (!aliases.has(identity.id)) aliases.set(identity.id, new Set());
    const ids = aliases.get(identity.id);
    for (const id of identity.identifiers) ids?.add(id);
  }
  return new Map([...aliases].map(([id, ids]) => [id, [...ids]]));
}

/** @param {unknown} message */
function senderOpenId(message) {
  const identity = senderIdentity(message);
  return identity.verified && identity.type === "open_id" && identity.id.startsWith("ou_") ? identity.id : "";
}

/** Empty values and echoed identifiers are unknown, never resolved names.
 * @param {unknown} value @param {unknown[]} [identifiers]
 */
function personName(value, identifiers = []) {
  if (typeof value !== "string" || !value.trim()) return "";
  const name = value.trim();
  return identifiers.some((id) => typeof id === "string" && id === name) ? "" : name;
}

/** @param {unknown} user @param {unknown[]} [aliases] */
function displayNameFromUser(user, aliases = []) {
  if (!object(user)) return "";
  const ids = [user.open_id, user.user_id, user.union_id, user.member_id, ...aliases];
  for (const value of [user.localized_name, user.name, user.display_name, user.en_name]) {
    const name = personName(value, ids);
    if (name) return name;
  }
  return "";
}

export { displayNameFromUser, personName, senderAliasesByOpenId, senderIdentity, senderNameFromSource, senderOpenId };
