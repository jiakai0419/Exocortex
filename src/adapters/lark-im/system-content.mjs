// @ts-check

const PIN_TOPIC_TEMPLATE = "{name} clipped a topic to top.";
const PLACEHOLDER = /\{(\w+)\}/g;

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
 * @returns {string | null} null means the caller should keep its existing body.
 */
function renderSystemContent(content) {
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

  // For this evidenced event only, the absent name is an unknown operator.
  // Other templates can use {name} for a group or another non-person value.
  if (template.trim() === PIN_TOPIC_TEMPLATE && parameterText(parameters, "name") === null) {
    return "未知操作者置顶了一个话题";
  }
  return template.replace(PLACEHOLDER, (_placeholder, key) =>
    parameterText(parameters, key) ?? `[未知参数：${key}]`);
}

export { renderSystemContent };
