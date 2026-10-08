// @ts-check
import { classifyLarkFailure } from "../adapters/lark-im/transport.mjs";

/** Historical run outcomes are separate from current detail debt and transport retries.
 * Only the exact persisted internal type establishes incomplete merge-forward details;
 * arbitrary error prose or similarly named errors must not acquire that meaning.
 * @param {{error_type?: unknown, error_message?: unknown}} row
 */
export function classifySyncRunFailure(row) {
  if (row.error_type === "LarkDetailIncomplete") {
    return { kind: "detail_incomplete", transient: false, code: null };
  }
  return classifyLarkFailure(row.error_message || "");
}
