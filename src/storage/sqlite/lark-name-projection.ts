// Mirrors senderIdentity's finite source slots and string selection order.
// Keep this SQL-side contract covered through actual record/store/enrich tests.
const senderIdPaths = ['$.sender.id', '$.sender.open_id', '$.sender.sender_id.open_id',
  '$.sender.sender_id.user_id', '$.sender.sender_id.union_id', '$.sender.sender_id',
  '$.sender.user_id', '$.sender.union_id', '$.sender.app_id', '$.sender.sender_id.app_id'];
const typedSenderIdPaths = senderIdPaths.filter((path) => !['$.sender.id', '$.sender.sender_id'].includes(path));

/** Empty values and every explicit source ID echo are unknown. This predicate
 * does not override the separate authoritative-clear rules in the merge. */
function larkSenderNameIsUnknownSql(canonical: string, raw: string, actor: string) {
  const pairs = senderIdPaths.map((path) => `SELECT json_extract(raw, '${path}') AS value,
    json_type(raw, '${path}') AS kind FROM native`).join(' UNION ALL ');
  return `(WITH source AS MATERIALIZED (
    SELECT ${canonical} AS canonical, ${actor} AS actor,
      CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END AS raw
  ), native AS MATERIALIZED (
    SELECT canonical, actor, CASE WHEN json_type(raw, '$.raw_api') = 'object'
      THEN json_extract(raw, '$.raw_api') ELSE raw END AS raw FROM source
  ), ids AS MATERIALIZED (${pairs})
  SELECT COALESCE(trim(json_extract(canonical, '$.sender_name')), '') = ''
    OR trim(json_extract(canonical, '$.sender_name')) IS actor
    OR EXISTS (SELECT 1 FROM ids WHERE kind = 'text' AND value <> ''
      AND value = trim(json_extract(canonical, '$.sender_name')))
    FROM native)`;
}

/** Resolve source namespaces before comparing names. Legacy prefixes are only
 * an inheritance compatibility rule, never permission to perform a lookup.
 * Explicit raw evidence wins over a missing canonical type; contradictory
 * explicit evidence cannot inherit a name, even when the ID bytes match. */
function larkSenderNamespaceSql(canonical: string, raw: string, actor: string, allowLegacy = true) {
  const selectedId = `COALESCE(${senderIdPaths.map((path) => `CASE WHEN json_type(raw, '${path}') = 'text'
    THEN NULLIF(json_extract(raw, '${path}'), '') END`).join(', ')})`;
  const malformedId = ['$.sender.id', ...typedSenderIdPaths].map((path) =>
    `json_type(raw, '${path}') NOT IN ('text', 'null')`).join(' OR ');
  const pairs = ['open_id', 'user_id', 'union_id', 'app_id'].flatMap((type) => [
    `SELECT '${type}' AS type, json_extract(raw, '$.sender.${type}') AS value, 'direct' AS origin FROM native`,
    `SELECT '${type}' AS type, json_extract(raw, '$.sender.sender_id.${type}') AS value, 'nested' AS origin FROM native`,
  ]).join(' UNION ALL ');
  return `(WITH source AS MATERIALIZED (
    SELECT ${canonical} AS canonical, ${actor} AS actor,
      CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END AS raw
  ), native AS MATERIALIZED (
    SELECT canonical, actor, CASE WHEN json_type(raw, '$.raw_api') = 'object'
      THEN json_extract(raw, '$.raw_api') ELSE raw END AS raw FROM source
  ), evidence AS MATERIALIZED (${pairs}), types AS MATERIALIZED (
    SELECT *, NULLIF(json_extract(canonical, '$.sender_id_type'), '') AS canonical_type,
      NULLIF(json_extract(raw, '$.sender.id_type'), '') AS declared_type,
      CASE WHEN json_type(raw, '$.sender.id') = 'text' THEN NULLIF(json_extract(raw, '$.sender.id'), '') END AS raw_id,
      ${selectedId} AS selected_id,
      (SELECT COUNT(DISTINCT type) FROM evidence WHERE value = native.actor) AS matching_types,
      (SELECT MIN(type) FROM evidence WHERE value = native.actor) AS matching_type
    FROM native
  ), resolved AS MATERIALIZED (
    SELECT *, COALESCE(declared_type, CASE WHEN matching_types = 1 THEN matching_type END) AS source_type
    FROM types
  ) SELECT CASE
    WHEN COALESCE(actor, '') = '' OR canonical_type = 'conflicting'
      OR json_type(canonical, '$.sender_id_type') NOT IN ('text', 'null')
      OR json_type(raw, '$.sender.id_type') NOT IN ('text', 'null')
      OR (${malformedId})
      OR json_type(raw, '$.sender.sender_id') NOT IN ('text', 'object', 'null')
      OR json_type(raw, '$.sender.sender_id') = 'object' AND NOT EXISTS (
        SELECT 1 FROM evidence WHERE origin = 'nested' AND typeof(value) = 'text' AND value <> '')
      OR selected_id IS NOT NULL AND selected_id <> actor
      OR raw_id IS NOT NULL AND raw_id <> actor
      OR declared_type IS NULL AND matching_types > 1
      OR source_type IS NULL AND EXISTS (
        SELECT 1 FROM evidence WHERE typeof(value) = 'text' AND value <> '')
      OR EXISTS (SELECT 1 FROM evidence WHERE typeof(value) = 'text' AND value <> ''
        GROUP BY type HAVING COUNT(DISTINCT value) > 1)
      OR source_type IS NOT NULL AND EXISTS (
        SELECT 1 FROM evidence WHERE type = source_type AND typeof(value) = 'text' AND value <> '' AND value <> actor)
      OR declared_type IS NOT NULL AND raw_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM evidence WHERE type = declared_type AND value = actor)
      OR canonical_type IS NOT NULL AND source_type IS NOT NULL AND canonical_type <> source_type
      THEN NULL
    WHEN source_type IS NOT NULL THEN 'typed:' || source_type
    ${allowLegacy ? `WHEN canonical_type IS NOT NULL THEN 'typed:' || canonical_type
    WHEN actor GLOB 'ou_*' THEN 'typed:open_id'
    WHEN actor GLOB 'cli_*' THEN 'typed:app_id'
    ELSE 'legacy:opaque'` : 'ELSE NULL'}
    END FROM resolved)`;
}

/** SQL-side name merge shared by ingestion and enrichment. A missing/empty name
 * is unknown, including failed lookups. Only name_state='cleared' is a clear.
 * Historical chat names may fill unknown fields, but cannot undo an explicit
 * clear or replace a known name. A fresh message name may do either.
 * Keep name provenance together, and never carry it across different identities.
 * Ingestion evaluates this inside its write transaction; enrichment evaluates
 * a snapshot and commits only if that exact snapshot still matches. */
function mergeLarkNameProjectionSql(
  existingJson: string,
  incomingJson: string,
  existingActor: string,
  incomingActor: string,
  existingContainer: string,
  incomingContainer: string,
  existingRaw = "'{}'",
  incomingRaw = "'{}'",
) {
  const sameActor = `${existingActor} IS NOT NULL AND ${existingActor} <> ''
    AND ${existingActor} IS ${incomingActor}
    AND json_extract(old, '$.sender_id') IS ${existingActor}
    AND json_extract(next, '$.sender_id') IS ${incomingActor}
    AND ${larkSenderNamespaceSql(existingJson, existingRaw, existingActor)}
      = ${larkSenderNamespaceSql(incomingJson, incomingRaw, incomingActor)}`;
  const sameContainer = `${existingContainer} IS NOT NULL AND ${existingContainer} <> ''
    AND ${existingContainer} IS ${incomingContainer}
    AND json_extract(old, '$.chat_id') IS ${existingContainer}
    AND json_extract(next, '$.chat_id') IS ${incomingContainer}`;
  const groups = [
    {
      identity: `(${sameActor}) AND (${sameContainer})`,
      name: '$.sender_name', state: '$.sender_name_state',
      fields: ['$.sender_name', '$.sender_name_source', '$.sender_name_confidence',
        '$.sender_name_state', '$.sender_name_resolution_status', '$.sender_name_resolution_reason'],
    },
    {
      identity: sameContainer,
      name: '$.chat_name', state: '$.chat_name_state',
      historical: `json_extract(next, '$.chat_name_source') IN ('scope_config', 'local_history')`,
      fields: ['$.chat_name', '$.chat_name_state', '$.chat_name_source'],
    },
    {
      identity: `${sameContainer}
        AND COALESCE(json_extract(old, '$.chat_partner.open_id'), '') <> ''
        AND json_extract(old, '$.chat_partner.open_id') IS json_extract(next, '$.chat_partner.open_id')`,
      name: '$.chat_partner.name', state: '$.chat_partner.name_state',
      fields: ['$.chat_partner.name', '$.chat_partner.name_state'],
    },
  ];
  const stages = [`n0 AS MATERIALIZED (SELECT ${existingJson} AS old, ${incomingJson} AS next)`];
  let index = 0;
  for (const group of groups) {
    const before = `n${index}`;
    index += 1;
    const nextUnknown = group.name === '$.sender_name'
      ? larkSenderNameIsUnknownSql('next', incomingRaw, incomingActor)
      : `COALESCE(json_extract(next, '${group.name}'), '') = ''`;
    const oldUnknown = group.name === '$.sender_name'
      ? larkSenderNameIsUnknownSql('old', existingRaw, existingActor)
      : `COALESCE(json_extract(old, '${group.name}'), '') = ''`;
    stages.push(`n${index} AS MATERIALIZED (SELECT old, next,
      (${group.identity})
      AND (${nextUnknown} OR ${group.historical || '0'})
      AND COALESCE(json_extract(next, '${group.state}'), '') <> 'cleared'
      AND (NOT (${oldUnknown})
        OR json_extract(old, '${group.state}') = 'cleared') AS keep
      FROM ${before})`);
    for (const field of group.fields) {
      const previous = `n${index}`;
      index += 1;
      // Preserve absence as well as null; failed lookups must not create a
      // phantom update by adding/removing a provenance property.
      stages.push(`n${index} AS MATERIALIZED (SELECT old, keep, CASE WHEN keep THEN
        CASE WHEN json_type(old, '${field}') IS NULL THEN json_remove(next, '${field}')
          ELSE json_set(next, '${field}', json_extract(old, '${field}')) END
        ELSE next END AS next FROM ${previous})`);
    }
  }
  // Restoring a previously absent field may move its JSON property position.
  // Compare paths and typed scalar values, so equivalent projections keep the
  // stored bytes and updated_at instead of recording a formatting-only update.
  return `(WITH ${stages.join(',\n')} SELECT CASE WHEN
    NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(next)
      EXCEPT SELECT fullkey, type, atom FROM json_tree(old))
    AND NOT EXISTS (SELECT fullkey, type, atom FROM json_tree(old)
      EXCEPT SELECT fullkey, type, atom FROM json_tree(next))
    THEN old ELSE next END FROM n${index})`;
}

export { larkSenderNameIsUnknownSql, larkSenderNamespaceSql, mergeLarkNameProjectionSql };
