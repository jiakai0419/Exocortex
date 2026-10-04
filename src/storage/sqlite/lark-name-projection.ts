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
) {
  const sameActor = `${existingActor} IS NOT NULL AND ${existingActor} <> ''
    AND ${existingActor} IS ${incomingActor}
    AND json_extract(old, '$.sender_id') IS ${existingActor}
    AND json_extract(next, '$.sender_id') IS ${incomingActor}`;
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
    stages.push(`n${index} AS MATERIALIZED (SELECT old, next,
      (${group.identity})
      AND (COALESCE(json_extract(next, '${group.name}'), '') = '' OR ${group.historical || '0'})
      AND COALESCE(json_extract(next, '${group.state}'), '') <> 'cleared'
      AND (COALESCE(json_extract(old, '${group.name}'), '') <> ''
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

export { mergeLarkNameProjectionSql };
