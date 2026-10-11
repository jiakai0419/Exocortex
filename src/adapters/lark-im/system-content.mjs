// @ts-check

const PIN_TOPIC_TEMPLATE = "{name} clipped a topic to top.";
const PLACEHOLDER = /\{(\w+)\}/g;
// A closed semantic profile: this group parameter names the message container,
// not a renamed group, an invitation destination, or another historical group.
const CONTAINER_GROUP_TEMPLATES = new Set([
  "{name} joined {group_name}. New members can view all chat history.",
]);

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function ownField(value, key) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.prototype.hasOwnProperty.call(value, key)
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : undefined;
}

/** @param {unknown} parameters @param {string} key @returns {string | null} */
function parameterText(parameters, key) {
  const value = ownField(parameters, key);
  const text = nonEmptyString(value);
  if (text !== null) return text;
  // These are the structured parameter forms used by the official CLI's
  // system converter. Do not stringify objects or guess a person's identity.
  if ((key === "from_user" || key === "to_chatters") && Array.isArray(value)
      && value.length > 0 && value.every((entry) => nonEmptyString(entry) !== null)) {
    return value.join(", ");
  }
  if (key === "divider_text") return nonEmptyString(ownField(value, "text"));
  return null;
}

/**
 * Render display text for system messages only. Accepts the CLI's flattened
 * content or an API body.content object/JSON string. Parameters are display
 * text, never evidence of sender/actor identity. No input is mutated.
 *
 * @param {unknown} content
 * @param {unknown} [context] Explicit source and temporal evidence; a message
 * snapshot alone is not evidence of the group name at the event's time.
 */
function renderSystemProjection(content, context) {
  let parameters = content;
  if (typeof content === "string") {
    try {
      parameters = JSON.parse(content);
    } catch {
      // CLI output is normally already plain text.
    }
  }
  const structuredTemplate = ownField(parameters, "template");
  const template = typeof structuredTemplate === "string"
    ? structuredTemplate
    : typeof parameters === "string" ? parameters : null;
  if (template === null) return null;

  const missing = new Set();
  const contextual = new Set();
  const group = ownField(context, "group");
  const groupName = ownField(group, "source") === "message_event" && ownField(group, "time_basis") === "event"
    && Number.isSafeInteger(ownField(context, "event_time_ms")) && Number(ownField(context, "event_time_ms")) >= 0
    && ownField(group, "effective_at_ms") === ownField(context, "event_time_ms")
    && ["group", "topic"].includes(String(ownField(group, "chat_type")))
    && nonEmptyString(ownField(context, "chat_id")) !== null && ownField(group, "chat_id") === ownField(context, "chat_id")
    ? nonEmptyString(ownField(group, "name")) : null;
  const result = (text) => ({ text, status: missing.size ? "partial" : "rendered",
    reason: missing.size ? "system_parameters_missing" : null, version: 1,
    missing_parameters: [...missing], context_parameters: [...contextual],
    context_source: contextual.size ? "message_event" : null, context_time_basis: contextual.size ? "event" : null,
    context_status: contextual.size ? "applied" : ownField(group, "time_basis") === "message_snapshot" ? "snapshot_only" : "not_applied" });

  // For this evidenced event only, the absent name is an unknown operator.
  // Other templates can use {name} for a group or another non-person value.
  if (template.trim() === PIN_TOPIC_TEMPLATE && parameterText(parameters, "name") === null) {
    missing.add("name");
    return result("未知操作者置顶了一个话题");
  }
  const text = template.replace(PLACEHOLDER, (_placeholder, key) => {
    const explicit = parameterText(parameters, key);
    if (explicit !== null) return explicit;
    // An explicit malformed/empty field is not permission to replace it with
    // unrelated context. Only the absent container-group parameter may borrow.
    if (key === "group_name" && CONTAINER_GROUP_TEMPLATES.has(template.trim())
      && ownField(parameters, key) === undefined && groupName !== null) {
      contextual.add(key); return groupName;
    }
    missing.add(key); return `[未知参数：${key}]`;
  });
  return result(text);
}

/** Keep the ingestion API unchanged; contextual reprojection is display-only.
 * @param {unknown} content @param {unknown} [context] @returns {string | null} */
function renderSystemContent(content, context) { return renderSystemProjection(content, context)?.text ?? null; }

export { renderSystemContent, renderSystemProjection };
