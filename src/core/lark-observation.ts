import { createHash } from "node:crypto";

/** A comparison of saved parsed-CLI evidence, never a client-state assertion. */
const OBSERVATION_POLICY = "lark_raw_observation/v1";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function stable(value: Json): string {
  return Array.isArray(value) ? `[${value.map(stable).join(",")}]` : object(value)
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
}

/** Refuse duplicate keys and numbers whose original value cannot be represented
 * exactly. Failure removes a proof; it never discards or rewrites raw evidence. */
function parseEvidence(text: string): Json {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) throw new Error("comparison_limit");
  let at = 0, nodes = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[at] || "x")) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at] === "\\") { at += 2; continue; }
      if (text[at++] === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error("invalid_json");
  };
  const value = (depth: number): Json => {
    if (++nodes > 20000 || depth > 64) throw new Error("comparison_limit");
    space(); const c = text[at];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      at++; const result: ObjectValue | Json[] = c === "{" ? Object.create(null) : [];
      const end = c === "{" ? "}" : "]"; space();
      if (text[at] === end) { at++; return result; }
      while (true) {
        space();
        if (Array.isArray(result)) result.push(value(depth + 1));
        else {
          if (text[at] !== '"') throw new Error("invalid_json");
          const key = string(); space();
          if (Object.hasOwn(result, key) || text[at++] !== ":") throw new Error("ambiguous_json");
          result[key] = value(depth + 1);
        }
        space(); if (text[at] === end) { at++; return result; }
        if (text[at++] !== ",") throw new Error("invalid_json");
      }
    }
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return result; }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0];
    if (!token) throw new Error("invalid_json");
    at += token.length;
    // Integer-only is deliberately conservative for source equivalence. Exact
    // byte equality still works for arbitrary valid legacy numeric payloads.
    if (!/^-?(?:0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(Number(token)) || Object.is(Number(token), -0)) throw new Error("unverified_number");
    return Number(token);
  };
  const parsed = value(0); space(); if (at !== text.length) throw new Error("invalid_json"); return parsed;
}

function timestamp(value: Json | undefined): Json | undefined {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const text = String(value);
  if (!/^\d+$/.test(text)) return value;
  const n = BigInt(text), ms = n < 10000000000n ? n * 1000n : n;
  return ms <= 253402300799999n ? ms.toString() : value;
}
function nativeStructure(raw: ObjectValue): ObjectValue {
  const result = { ...raw };
  for (const key of ["create_time", "update_time"]) if (Object.hasOwn(result, key)) result[key] = timestamp(result[key])!;
  if (object(raw.body) && Object.hasOwn(raw.body, "content") && typeof raw.body.content !== "string") throw new Error("unverified_content_shape");
  if (object(raw.body) && typeof raw.body.content === "string") {
    let content = parseEvidence(raw.body.content);
    if (raw.msg_type === "interactive" && object(content)) {
      content = { ...content };
      for (const key of ["json_card", "json_attachment"]) if (Object.hasOwn(content, key)) {
        const value = content[key];
        content[key] = typeof value === "string" ? ["encoded_json_document", parseEvidence(value)] : ["native_value", value];
      }
    }
    result.body = { ...raw.body, content: { encoded_json_document: content } };
  }
  if (Array.isArray(raw.raw_api_expansions)) result.raw_api_expansions = raw.raw_api_expansions.map(item => object(item) ? nativeStructure(item) : item);
  if (object(raw.raw_api_expansions) && object(raw.raw_api_expansions.merge_forward)
    && Array.isArray(raw.raw_api_expansions.merge_forward.items)) {
    const expansion = raw.raw_api_expansions.merge_forward;
    result.raw_api_expansions = { ...raw.raw_api_expansions, merge_forward: { ...expansion,
      items: (expansion.items as Json[]).map(item => object(item) ? nativeStructure(item) : item) } };
  }
  return result;
}
const keysWithin = (value: ObjectValue, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const namespaces = ["open_id", "user_id", "union_id", "app_id"];

/** A deliberately closed profile. A renderer can display more than this proof
 * understands. In particular, actions and unknown consumers are NOT ignored. */
function referenceNormalForm(raw: ObjectValue): ObjectValue | null {
  try {
    if (raw.msg_type !== "interactive" || !keysWithin(raw, ["message_id", "msg_type", "create_time", "update_time", "updated", "deleted",
      "sender", "chat_id", "root_id", "parent_id", "thread_id", "body", "mentions"]) || !object(raw.body)
      || !keysWithin(raw.body, ["content"]) || typeof raw.body.content !== "string" || !Array.isArray(raw.mentions)
      || raw.mentions.length > 100) return null;
    if (object(raw.sender) && !keysWithin(raw.sender, ["id", "id_type", "sender_type", "tenant_key"])) return null;
    const definitions = new Map<string, Json[]>(), typed = new Map<string, Json[][]>();
    const identities = new Set<string>();
    const mentions = raw.mentions.map(mention => {
      if (!object(mention) || !keysWithin(mention, ["key", "id", "id_type", "name", "tenant_key"]) || typeof mention.key !== "string"
        || !/^@_user_\d+$/.test(mention.key) || definitions.has(mention.key)) throw new Error("ambiguous_definition");
      let kind = mention.id_type, id = mention.id;
      if (object(id)) {
        const fields = Object.keys(id);
        if (fields.length !== 1 || !namespaces.includes(fields[0]) || kind !== undefined && kind !== fields[0]) throw new Error("ambiguous_identity");
        kind = fields[0]; id = id[fields[0]];
      }
      if (typeof kind !== "string" || !namespaces.includes(kind) || typeof id !== "string" || !id) throw new Error("unverified_identity");
      const target: Json[] = ["typed_identity", kind, id];
      if (identities.has(stable(target))) throw new Error("duplicate_identity");
      identities.add(stable(target)); definitions.set(mention.key, target);
      typed.set(id, [...(typed.get(id) || []), target]);
      return { ...mention, key: target };
    });
    if (!definitions.size) return null;
    let card = parseEvidence(raw.body.content);
    if (!object(card) || !keysWithin(card, ["json_card", "json_attachment"]) || !Object.hasOwn(card, "json_card")) return null;
    const attachment = typeof card.json_attachment === "string" ? parseEvidence(card.json_attachment) : card.json_attachment;
    if (!object(attachment) || !keysWithin(attachment, ["at_users"]) || !object(attachment.at_users)) return null;
    const aliases = new Map<string, Json[][]>();
    const users: ObjectValue = Object.create(null);
    for (const [alias, entry] of Object.entries(attachment.at_users)) {
      if (!object(entry) || !keysWithin(entry, ["mention_key", "user_id", "content"]) || typeof entry.mention_key !== "string") return null;
      const target = definitions.get(entry.mention_key); if (!target) return null;
      for (const label of [alias, entry.user_id].filter((x): x is string => typeof x === "string")) {
        aliases.set(label, [...(aliases.get(label) || []), target]);
      }
      users[alias] = { ...entry, mention_key: target };
    }
    const resolve = (label: Json): Json[] => {
      if (typeof label !== "string") throw new Error("invalid_reference");
      const candidates = [...(definitions.has(label) ? [definitions.get(label)!] : []), ...(typed.get(label) || []), ...(aliases.get(label) || [])];
      const unique = new Map(candidates.map(target => [stable(target), target]));
      if (unique.size !== 1) throw new Error("ambiguous_reference");
      return [...unique.values()][0];
    };
    let count = 0;
    const node = (input: Json, depth = 0): Json => {
      if (++count > 2048 || depth > 24 || !object(input) || typeof input.tag !== "string") throw new Error("unknown_consumer");
      if (input.tag === "at") {
        if (!keysWithin(input, ["tag", "property"]) || !object(input.property)) throw new Error("unknown_consumer");
        const fields = Object.keys(input.property);
        if (fields.length !== 1 || !["userID", "user_id"].includes(fields[0])) throw new Error("unknown_consumer");
        return { ...input, property: { [fields[0]]: resolve(input.property[fields[0]]) } };
      }
      if (["plain_text", "text", "markdown", "lark_md", "md"].includes(input.tag)) {
        if (!keysWithin(input, ["tag", "content", "text"])) throw new Error("unknown_consumer");
        for (const key of ["content", "text"]) if (Object.hasOwn(input, key)
          && (typeof input[key] !== "string" || /@_user_|<at\b/.test(String(input[key])))) throw new Error("unparsed_reference");
        return input;
      }
      if (["div", "note", "column", "column_set"].includes(input.tag) && keysWithin(input, ["tag", "elements", "text"])
        && (input.elements === undefined || Array.isArray(input.elements))) {
        return { ...input, ...(Array.isArray(input.elements) ? { elements: input.elements.map(child => node(child, depth + 1)) } : {}),
          ...(input.text === undefined ? {} : { text: node(input.text, depth + 1) }) };
      }
      throw new Error("unknown_consumer");
    };
    const inner = typeof card.json_card === "string" ? parseEvidence(card.json_card) : card.json_card;
    if (!object(inner) || !keysWithin(inner, ["elements"]) || !Array.isArray(inner.elements)) return null;
    const normalized = nativeStructure(raw);
    normalized.mentions = mentions.sort((a,b) => stable(a).localeCompare(stable(b)));
    normalized.body = { content: { reference_document: { json_card: { elements: inner.elements.map(child => node(child)) },
      json_attachment: { at_users: users } } } };
    return normalized;
  } catch { return null; }
}

type SourceProof = { policy: string; outer: string | null; structural: string | null; references: string | null; native: boolean };
function sourceProof(rawJson: string): SourceProof {
  const proof: SourceProof = { policy: OBSERVATION_POLICY, outer: null, structural: null, references: null, native: false };
  try {
    const raw = parseEvidence(rawJson);
    if (!object(raw) || typeof raw.message_id !== "string" || typeof raw.msg_type !== "string") return proof;
    proof.native = true;
    proof.outer = hash("outer:" + stable(raw));
    proof.structural = hash("native:" + stable(nativeStructure(raw)));
    const reference = referenceNormalForm(raw);
    if (reference) proof.references = hash(stable(reference));
  } catch { /* Exact evidence is still usable; no structural equivalence claim. */ }
  return proof;
}
type ObservationRecord = { source_id: string; external_id: string; external_version: string | null; record_type: string;
  occurred_at_ms: number; container_id: string | null; raw_json: string; body: string; canonical_json: string; title: string | null };
function isNativeRecord(record: ObservationRecord): boolean {
  try { return record.source_id === "lark.im" && record.record_type === "lark.im.message"
    && JSON.parse(record.canonical_json)?.source_api === "im.v1.messages" && typeof JSON.parse(record.raw_json)?.message_id === "string"; }
  catch { return false; }
}
type SourceRelation = "exact" | "json_representation" | "reference_rename" | "different" | "unverified";
function sourceRelation(before: string, incoming: string): SourceRelation {
  if (before === incoming) return "exact";
  const a = sourceProof(before), b = sourceProof(incoming);
  if (a.outer && a.outer === b.outer) return "json_representation";
  if (a.structural && a.structural === b.structural) return "json_representation";
  if (a.references && a.references === b.references) return "reference_rename";
  return a.structural && b.structural ? "different" : "unverified";
}
function compareObservation(before: ObservationRecord, incoming: ObservationRecord) {
  const identity = before.source_id === incoming.source_id && before.external_id === incoming.external_id
    && before.record_type === incoming.record_type && before.occurred_at_ms === incoming.occurred_at_ms
    && before.container_id === incoming.container_id ? "same" : "conflict";
  const a = before.external_version, b = incoming.external_version;
  const version = a === b ? "equal" : a !== null && b !== null && /^\d+$/.test(a) && /^\d+$/.test(b)
    ? BigInt(b) > BigInt(a) ? "newer" : "older" : "unordered";
  const representation = sourceRelation(before.raw_json, incoming.raw_json);
  return { policy: OBSERVATION_POLICY, identity, version, representation,
    equivalent: identity === "same" && ["exact", "json_representation", "reference_rename"].includes(representation),
    projection: before.body === incoming.body && before.title === incoming.title ? "equal" : "different" };
}

const DERIVED_CANONICAL_FIELDS = ["content", "content_rendering", "sender_name", "sender_name_state", "sender_name_source",
  "sender_name_confidence", "sender_name_resolution_status", "sender_name_resolution_reason", "chat_name", "chat_name_source", "chat_type"];
/** Keep one representative of an equivalent source; name merge remains SQL's
 * responsibility. Do not let alias allocation churn canonical source fields. */
function retainSourceRepresentation<T extends ObservationRecord & { content_hash: string }>(before: T, incoming: T): T {
  const old = JSON.parse(before.canonical_json), next = JSON.parse(incoming.canonical_json);
  if (!object(old) || !object(next)) return incoming;
  const canonical = { ...old, ...next };
  // Only these source representations are proven aliases of the retained raw.
  // Unknown canonical fields from either side must not disappear.
  for (const key of ["mentions", "create_time", "update_time"]) {
    if (Object.hasOwn(old, key)) canonical[key] = old[key];
  }
  for (const key of DERIVED_CANONICAL_FIELDS) {
    if (Object.hasOwn(next, key)) canonical[key] = next[key]; else delete canonical[key];
  }
  return { ...incoming, raw_json: before.raw_json, content_hash: before.content_hash, canonical_json: JSON.stringify(canonical) };
}

/** Approval proof binds every effective field and canonical dependency. Native
 * redundant mentions may be represented by the graph proof only when they equal
 * the actual raw definitions. Unknown canonical fields are always included. */
function recordProof(record: Record<string, any>) {
  const proof = sourceProof(record.raw_json);
  const exact = hash(stable(record));
  try {
    if (!isNativeRecord(record as ObservationRecord)) return { policy: OBSERVATION_POLICY, exact, structural: null, references: null };
    const raw = parseEvidence(record.raw_json), canonical = parseEvidence(record.canonical_json);
    if (!object(raw) || !object(canonical)) throw new Error("invalid_record");
    const base: Record<string, any> = { ...record, canonical_json: canonical };
    delete base.raw_json; delete base.content_hash;
    const source = proof.structural || proof.outer;
    const structural = source ? hash(stable({ fields: base, source })) : null;
    let references: string | null = null;
    if (proof.references && stable(canonical.mentions ?? []) === stable(raw.mentions ?? [])) {
      const projection = { ...canonical, mentions: { source_reference_proof: proof.references } };
      references = hash(stable({ fields: { ...base, canonical_json: projection }, source: proof.references }));
    }
    return { policy: OBSERVATION_POLICY, exact, structural, references };
  } catch { return { policy: OBSERVATION_POLICY, exact, structural: null, references: null }; }
}

export { recordProof, OBSERVATION_POLICY, parseEvidence, stable, sourceProof, sourceRelation, compareObservation, retainSourceRepresentation, isNativeRecord };
export type { ObservationRecord, SourceProof, SourceRelation };
