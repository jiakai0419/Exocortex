import { createHash } from "node:crypto";
import { quoteSql } from "./sqlite-executor.js";

export type LarkWriteAdmission = {
  sourceConfigJson: string;
  selfOpenId: string | null;
  accountKey: string | null;
  sentActor: string | null;
  requireVerified: boolean;
  sidecarVerified: boolean;
  scopes: Array<{ id: string; source_id: string; enabled: number; config_json: string }>;
};

function larkScopeAdmissionSql(scope: LarkWriteAdmission["scopes"][number] | undefined): string {
  if (!scope || typeof scope.id !== "string" || scope.source_id !== "lark.im" || ![0, 1].includes(scope.enabled) || typeof scope.config_json !== "string") {
    throw new Error("invalid Lark admission scope");
  }
  return `EXISTS(SELECT 1 FROM sync_scopes WHERE id=${quoteSql(scope.id)} AND source_id='lark.im'
    AND enabled=${scope.enabled} AND config_json IS ${quoteSql(scope.config_json)})`;
}

/** Database facts only. Files and remote identity are checked by the request
 * owner under its shared lease; this predicate never claims to fence files. */
function larkWriteAdmissionSql(value: LarkWriteAdmission, table = "__lark_account_admission"): string {
  if (!/^__[a-z_]+$/.test(table) || !value || typeof value.sourceConfigJson !== "string" ||
      typeof value.requireVerified !== "boolean" || typeof value.sidecarVerified !== "boolean" ||
      !(value.selfOpenId === null || /^ou_[A-Za-z0-9_-]+$/.test(value.selfOpenId)) ||
      !(value.sentActor === null || /^ou_[A-Za-z0-9_-]+$/.test(value.sentActor)) ||
      !(value.accountKey === null || /^[a-f0-9]{64}$/.test(value.accountKey)) || !Array.isArray(value.scopes)) {
    throw new Error("invalid Lark write admission");
  }
  const source = JSON.parse(value.sourceConfigJson);
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid Lark source admission");
  const expectedInitial = source.initial_account_binding;
  const accountKey = value.selfOpenId
    ? createHash("sha256").update(`lark.im\0${value.selfOpenId}`).digest("hex") : value.accountKey;
  if (value.accountKey && value.accountKey !== accountKey) throw new Error("Lark request account changed");
  const actor = value.selfOpenId || value.sentActor;
  const sent = "source_id='lark.im' AND direction='sent'";
  const sentGuard = actor === null ? `NOT EXISTS (SELECT 1 FROM records WHERE ${sent})`
    : `NOT EXISTS (SELECT 1 FROM records WHERE ${sent} AND (
        actor_id IS NOT ${quoteSql(actor)} OR canonical_json IS NOT NULL AND (
          NOT json_valid(canonical_json) OR
          json_extract(canonical_json,'$.sender_id') IS NOT NULL AND json_extract(canonical_json,'$.sender_id') IS NOT actor_id OR
          json_extract(canonical_json,'$.sender_id_type') IS NOT NULL AND json_extract(canonical_json,'$.sender_id_type') IS NOT 'open_id')))`;
  const initial = "json_extract(src.config_json,'$.initial_account_binding')";
  const field = (name: string) => `json_extract(${initial},'$.${name}')`;
  const validTime = (expression: string) => `(typeof(${expression})='text' AND strftime('%Y-%m-%dT%H:%M:%fZ',${expression}) IS ${expression}
    AND julianday(${expression}) >= julianday('1970-01-01T00:00:00.000Z') AND julianday(${expression}) <= julianday('now'))`;
  // Confirmation is the one allowed source mutation during a same-account
  // request. Other source fields remain a text-preserving JSON comparison.
  const initialGuard = `(json_type(src.config_json,'$.initial_account_binding') IS NULL AND ${expectedInitial === undefined ? "1" : "0"}
    OR json_type(src.config_json,'$.initial_account_binding')='object' AND ${accountKey ? "1" : "0"}
      AND ${field("kind")} IS 'lark_im_initial_account/v1' AND ${field("account_key")} IS ${quoteSql(accountKey)}
      AND ${validTime(field("reserved_at"))}
      AND (json_type(${initial},'$.confirmed_at')='null' OR ${validTime(field("confirmed_at"))}
        AND julianday(${field("confirmed_at")}) >= julianday(${field("reserved_at")}))
      ${expectedInitial === undefined ? "" : `AND ${field("reserved_at")} IS ${quoteSql(expectedInitial.reserved_at)}
        AND json_remove(${initial},'$.confirmed_at') IS json_remove(json_extract(${quoteSql(value.sourceConfigJson)},'$.initial_account_binding'),'$.confirmed_at')
        ${expectedInitial.confirmed_at === null ? "" : `AND ${field("confirmed_at")} IS ${quoteSql(expectedInitial.confirmed_at)}`}`})`;
  const verified = value.requireVerified ? `AND CASE WHEN json_type(src.config_json,'$.initial_account_binding') IS NOT NULL
    THEN json_type(${initial},'$.confirmed_at')='text'
    ELSE ${value.sidecarVerified ? "1" : `EXISTS (SELECT 1 FROM records WHERE ${sent})`} END` : "";
  return `CREATE TEMP TABLE ${table}(allowed INTEGER NOT NULL CHECK(allowed=1));
    INSERT INTO ${table} SELECT CASE WHEN EXISTS(SELECT 1 FROM sources src WHERE src.id='lark.im' AND src.enabled=1
      AND json_remove(src.config_json,'$.initial_account_binding') IS json_remove(${quoteSql(value.sourceConfigJson)},'$.initial_account_binding')
      AND ${initialGuard} AND (${sentGuard}) ${verified}) THEN 1 ELSE 0 END;
    ${value.scopes.map(scope => `INSERT INTO ${table} SELECT CASE WHEN ${larkScopeAdmissionSql(scope)} THEN 1 ELSE 0 END;`).join("\n")}`;
}

export { larkWriteAdmissionSql, larkScopeAdmissionSql };
