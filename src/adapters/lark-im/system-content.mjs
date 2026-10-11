// @ts-check

const PIN_TOPIC_TEMPLATE = "{name} clipped a topic to top.";
const PLACEHOLDER = /\{(\w+)\}/g;
// A closed semantic profile: this group parameter names the message container,
// not a renamed group, an invitation destination, or another historical group.
const CONTAINER_GROUP_TEMPLATES = new Set([
  "{name} joined {group_name}. New members can view all chat history.",
  "{to_chatters} joined {group_name}. New members can view all chat history.",
]);

/** @param {unknown} value @returns {string | null} */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

/** @param {unknown} value @param {string} key @returns {boolean} */
function hasOwnField(value, key) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key));
}

/** @param {unknown} value @param {string} key @returns {unknown} */
function ownField(value, key) {
  return hasOwnField(value, key)
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
 * @param {unknown} [context] Explicit source and temporal evidence. Event-time
 * group evidence can fill a missing historical parameter. A current_group
 * scope title only adds a separately labelled current-local context; neither
 * that title nor a message snapshot establishes the event-time group name.
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
  const containerGroupTemplate = CONTAINER_GROUP_TEMPLATES.has(template.trim());
  const group = ownField(context, "group");
  const groupName = ownField(group, "source") === "message_event" && ownField(group, "time_basis") === "event"
    && Number.isSafeInteger(ownField(context, "event_time_ms")) && Number(ownField(context, "event_time_ms")) >= 0
    && ownField(group, "effective_at_ms") === ownField(context, "event_time_ms")
    && ["group", "topic"].includes(String(ownField(group, "chat_type")))
    && nonEmptyString(ownField(context, "chat_id")) !== null && ownField(group, "chat_id") === ownField(context, "chat_id")
    ? nonEmptyString(ownField(group, "name")) : null;
  const currentGroup = ownField(context, "current_group");
  const currentGroupName = ownField(currentGroup, "source") === "scope_config"
    && ownField(currentGroup, "time_basis") === "current_local"
    && ownField(currentGroup, "observed_at") === null
    && (ownField(currentGroup, "chat_type") === "group" || ownField(currentGroup, "chat_type") === "topic")
    && nonEmptyString(ownField(context, "chat_id")) !== null
    && ownField(currentGroup, "chat_id") === ownField(context, "chat_id")
    ? nonEmptyString(ownField(currentGroup, "name")) : null;
  let currentContextApplied = false;
  const result = (text) => ({ text, status: missing.size ? "partial" : "rendered",
    reason: missing.size ? "system_parameters_missing" : null, version: 1,
    missing_parameters: [...missing], context_parameters: [...contextual],
    context_source: contextual.size ? "message_event" : null, context_time_basis: contextual.size ? "event" : null,
    context_status: contextual.size ? "applied" : currentContextApplied ? "current_context_applied"
      : ownField(group, "time_basis") === "message_snapshot" ? "snapshot_only" : "not_applied",
    current_group_context: currentContextApplied ? {
      chat_id: ownField(currentGroup, "chat_id"), chat_type: ownField(currentGroup, "chat_type"),
      name: currentGroupName, source: "scope_config", time_basis: "current_local", observed_at: null,
    } : null });

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
    if (key === "group_name" && containerGroupTemplate && !hasOwnField(parameters, key)) {
      if (groupName !== null) {
        contextual.add(key); return groupName;
      }
      if (currentGroupName !== null) {
        // This label describes the current local scope, not the unknown name
        // at the event's time. Keep the original missing-parameter debt.
        missing.add(key);
        currentContextApplied = true;
        return `this group (current local title: ${currentGroupName})`;
      }
    }
    missing.add(key); return `[未知参数：${key}]`;
  });
  return result(text);
}

/** Keep the ingestion API unchanged; contextual reprojection is display-only.
 * @param {unknown} content @param {unknown} [context] @returns {string | null} */
function renderSystemContent(content, context) { return renderSystemProjection(content, context)?.text ?? null; }

export { renderSystemContent, renderSystemProjection };
