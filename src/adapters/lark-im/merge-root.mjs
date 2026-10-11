// @ts-check
import { sourceRelation } from "../../../dist/core/lark-observation.js";
import { parseLarkTimeMs } from "./message-record.mjs";

/** Compare complete root evidence after only documented endpoint representation
 * differences. Missing/empty root parent metadata is equivalent; a real parent
 * identifier remains source evidence. This does not decide version admission.
 * @param {Record<string, any>} left @param {Record<string, any>} right
 */
function mergeRootRelation(left, right) {
  const source = (/** @type {Record<string, any>} */ root) => {
    const result = { ...root };
    for (const key of ["create_time", "update_time"]) {
      if (result[key] != null && result[key] !== "") result[key] = parseLarkTimeMs(result[key]);
    }
    if (result.update_time == null || result.update_time === "") result.update_time = null;
    if (result.upper_message_id == null || result.upper_message_id === "") delete result.upper_message_id;
    return JSON.stringify(result);
  };
  return sourceRelation(source(left), source(right));
}

export { mergeRootRelation };
