import { messageAccountRetentionStages } from './message-account-projection.js';
// Mirrors senderIdentity's finite source slots and string selection order.
// Keep this SQL-side contract covered through actual record/store/enrich tests.
const senderIdPaths = ['$.sender.id', '$.sender.open_id', '$.sender.sender_id.open_id',
    '$.sender.sender_id.user_id', '$.sender.sender_id.union_id', '$.sender.sender_id',
    '$.sender.user_id', '$.sender.union_id', '$.sender.app_id', '$.sender.sender_id.app_id'];
const typedSenderIdPaths = senderIdPaths.filter((path) => !['$.sender.id', '$.sender.sender_id'].includes(path));
const partnerIdPaths = senderIdPaths.map(path => path.replace('$.sender.', '$.'));
/** Empty values and every explicit source ID echo are unknown. This predicate
 * does not override the separate authoritative-clear rules in the merge. */
function larkSenderNameIsUnknownSql(canonical, raw, actor) {
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
function larkSenderNamespaceSql(canonical, raw, actor, allowLegacy = true) {
    const selectedId = `COALESCE(${senderIdPaths.map((path) => `CASE WHEN json_type(raw, '${path}') = 'text'
    THEN NULLIF(json_extract(raw, '${path}'), '') END`).join(', ')})`;
    const malformedId = ['$.sender.id', ...typedSenderIdPaths].map((path) => `json_type(raw, '${path}') NOT IN ('text', 'null')`).join(' OR ');
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
      COALESCE(NULLIF(json_extract(raw, '$.sender.sender_type'), ''), json_extract(raw, '$.sender.type')) AS actor_kind,
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
      OR actor_kind = 'app' AND source_type IS NOT NULL AND source_type <> 'app_id'
      OR actor_kind = 'user' AND source_type = 'app_id'
      OR canonical_type IS NOT NULL AND source_type IS NOT NULL AND canonical_type <> source_type
      THEN NULL
    WHEN source_type IS NOT NULL THEN 'typed:' || source_type
    ${allowLegacy ? `WHEN canonical_type IS NOT NULL THEN 'typed:' || canonical_type
    WHEN actor GLOB 'ou_*' THEN 'typed:open_id'
    WHEN actor GLOB 'cli_*' THEN 'typed:app_id'
    ELSE 'legacy:opaque'` : 'ELSE NULL'}
    END FROM resolved)`;
}
/** Compare explicit partner namespaces, never ID spelling. Each canonical/raw
 * declaration must be internally valid, and raw must agree with its canonical
 * partner when present. Shared typed aliases may prove identity; conflicting
 * aliases or the same bytes in different namespaces cannot. */
function larkPartnerIdentityMatchesSql(existing, incoming, existingRaw, incomingRaw) {
    const selected = `COALESCE(${partnerIdPaths.map(path => `CASE WHEN json_type(value, '${path}')='text'
    THEN NULLIF(json_extract(value, '${path}'), '') END`).join(',')})`;
    const aliases = ['open_id', 'user_id', 'union_id', 'app_id'].flatMap(type => [
        `SELECT side,origin,'${type}' AS type,json_extract(value,'$.${type}') AS id FROM partners`,
        `SELECT side,origin,'${type}' AS type,json_extract(value,'$.sender_id.${type}') AS id FROM partners`,
    ]).concat(`SELECT side,origin,json_extract(value,'$.id_type') AS type,json_extract(value,'$.id') AS id FROM partners`).join(' UNION ALL ');
    return `(WITH documents(side,canonical,raw) AS MATERIALIZED (
    SELECT 'old',${existing},CASE WHEN json_valid(${existingRaw}) THEN ${existingRaw} ELSE '{}' END
    UNION ALL SELECT 'next',${incoming},CASE WHEN json_valid(${incomingRaw}) THEN ${incomingRaw} ELSE '{}' END
  ), native AS MATERIALIZED (
    SELECT side,canonical,CASE WHEN json_type(raw,'$.raw_api')='object' THEN json_extract(raw,'$.raw_api') ELSE raw END AS raw FROM documents
  ), partners(side,origin,kind,value) AS MATERIALIZED (
    SELECT side,'canonical',json_type(canonical,'$.chat_partner'),
      CASE WHEN json_type(canonical,'$.chat_partner')='object' THEN json_extract(canonical,'$.chat_partner') ELSE '{}' END FROM native
    UNION ALL SELECT side,'raw',json_type(raw,'$.chat_partner'),
      CASE WHEN json_type(raw,'$.chat_partner')='object' THEN json_extract(raw,'$.chat_partner') ELSE '{}' END FROM native
  ), selected AS MATERIALIZED (SELECT *,${selected} AS partner_id FROM partners),
  resolved AS MATERIALIZED (SELECT *,${larkSenderNamespaceSql("'{}'", "json_object('sender',json(value))", 'partner_id', false)} AS namespace FROM selected),
  aliases AS MATERIALIZED (${aliases}), valid_aliases AS MATERIALIZED (
    SELECT * FROM aliases WHERE type IN ('open_id','user_id','union_id','app_id') AND typeof(id)='text' AND id<>''
  ) SELECT NOT EXISTS (SELECT 1 FROM resolved WHERE
      (origin='canonical' OR kind IS NOT NULL AND kind<>'null')
      AND (kind IS NOT 'object' OR COALESCE(namespace,'') NOT IN ('typed:open_id','typed:user_id','typed:union_id')))
    AND NOT EXISTS (SELECT 1 FROM valid_aliases GROUP BY type HAVING COUNT(DISTINCT id)>1)
    AND NOT EXISTS (SELECT 1 FROM partners p WHERE p.origin='raw' AND p.kind='object' AND NOT EXISTS (
      SELECT 1 FROM valid_aliases c JOIN valid_aliases r ON r.side=c.side AND r.type=c.type AND r.id=c.id
      WHERE c.side=p.side AND c.origin='canonical' AND r.origin='raw' AND c.type IN ('open_id','user_id','union_id')))
    AND EXISTS (SELECT 1 FROM valid_aliases a JOIN valid_aliases b ON b.type=a.type AND b.id=a.id
      WHERE a.side='old' AND b.side='next' AND a.type IN ('open_id','user_id','union_id'))) `;
}
function larkPartnerNameIsUnknownSql(canonical, raw) {
    const aliases = partnerIdPaths.map(path => `SELECT json_extract(value,'${path}') AS id,
    json_type(value,'${path}') AS kind FROM partners`).join(' UNION ALL ');
    return `(WITH source AS MATERIALIZED (SELECT ${canonical} AS canonical,
    CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END AS raw), native AS MATERIALIZED (
    SELECT canonical,CASE WHEN json_type(raw,'$.raw_api')='object' THEN json_extract(raw,'$.raw_api') ELSE raw END AS raw FROM source
  ), partners AS MATERIALIZED (
    SELECT CASE WHEN json_type(canonical,'$.chat_partner')='object' THEN json_extract(canonical,'$.chat_partner') ELSE '{}' END AS value FROM native
    UNION ALL SELECT CASE WHEN json_type(raw,'$.chat_partner')='object' THEN json_extract(raw,'$.chat_partner') ELSE '{}' END FROM native
  ), aliases AS MATERIALIZED (${aliases}) SELECT json_type(canonical,'$.chat_partner.name') IS NOT 'text'
    OR COALESCE(trim(json_extract(canonical,'$.chat_partner.name')),'')=''
    OR EXISTS (SELECT 1 FROM aliases WHERE kind='text' AND id<>'' AND id=trim(json_extract(canonical,'$.chat_partner.name')))
    FROM native)`;
}
/** Lossless removal for the rare account-marker conflict/replacement path.
 * The caller rejects duplicate root markers and caps input at 8 KiB. Materialize
 * a BLOB once so each scanner step reads one byte without rescanning UTF-8 text.
 * Only the final owned-member span is spliced; other bytes are never serialized. */
function removeChatAccountTextSql(text) {
    const character = 'substr(doc,pos,1)';
    const closingKey = `quoted AND NOT escaped AND ${character}=X'22' AND depth=1 AND reading_key`;
    return `(WITH RECURSIVE input AS MATERIALIZED (SELECT CAST(${text} AS BLOB) AS doc),
    scan(pos,depth,quoted,escaped,quote_start,reading_key,last_separator,member_start,remove_start,remove_end) AS (
      SELECT 1,0,0,0,0,0,0,0,0,0
      UNION ALL SELECT pos+1,
        depth + CASE WHEN quoted THEN 0 WHEN ${character} IN (X'7b',X'5b') THEN 1
          WHEN ${character} IN (X'7d',X'5d') THEN -1 ELSE 0 END,
        CASE WHEN quoted THEN CASE WHEN NOT escaped AND ${character}=X'22' THEN 0 ELSE 1 END
          WHEN ${character}=X'22' THEN 1 ELSE 0 END,
        CASE WHEN quoted AND NOT escaped AND ${character}=X'5c' THEN 1 ELSE 0 END,
        CASE WHEN NOT quoted AND ${character}=X'22' THEN pos ELSE quote_start END,
        CASE WHEN NOT quoted AND (${character}=X'7b' AND depth=0 OR ${character}=X'2c' AND depth=1) THEN 1
          WHEN NOT quoted AND ${character}=X'3a' AND depth=1 THEN 0 ELSE reading_key END,
        CASE WHEN NOT quoted AND (${character}=X'7b' AND depth=0 OR ${character}=X'2c' AND depth=1) THEN pos ELSE last_separator END,
        CASE WHEN ${closingKey} THEN CASE
          WHEN json_extract('[' || CAST(substr(doc,quote_start,pos-quote_start+1) AS TEXT) || ']', '$[0]')='chat_name_account_key'
          THEN quote_start ELSE member_start END ELSE member_start END,
        CASE WHEN NOT quoted AND depth=1 AND ${character} IN (X'2c',X'7d') AND member_start>0
          THEN CASE WHEN substr(doc,last_separator,1)=X'2c' THEN last_separator ELSE member_start END ELSE 0 END,
        CASE WHEN NOT quoted AND depth=1 AND ${character} IN (X'2c',X'7d') AND member_start>0
          THEN pos + CASE WHEN substr(doc,last_separator,1)=X'7b' AND ${character}=X'2c' THEN 1 ELSE 0 END ELSE 0 END
      FROM scan,input WHERE remove_end=0 AND pos<=length(doc) AND pos<=8192
    ), terminal AS MATERIALIZED (SELECT * FROM scan ORDER BY pos DESC LIMIT 1)
    SELECT CASE WHEN remove_end>0
      THEN CAST(substr(doc,1,remove_start-1) || substr(doc,remove_end) AS TEXT)
      ELSE json('json_patch_limit') END FROM terminal,input)`;
}
/** SQL-side name merge shared by ingestion and enrichment. A missing/empty name
 * is unknown, including failed lookups. Only name_state='cleared' is a clear.
 * Historical chat names may fill unknown fields, but cannot undo an explicit
 * clear or replace a known name. A fresh message name may do either.
 * Keep name provenance together, and never carry it across different identities.
 * Ingestion evaluates this inside its write transaction; enrichment evaluates
 * a snapshot and commits only if that exact snapshot still matches. */
function mergeLarkNameProjectionSql(existingJson, incomingJson, existingActor, incomingActor, existingContainer, incomingContainer, existingRaw = "'{}'", incomingRaw = "'{}'", accountRetention) {
    const actorMatches = (allowLegacy = true) => `${existingActor} IS NOT NULL AND ${existingActor} <> ''
    AND ${existingActor} IS ${incomingActor}
    AND json_extract(old, '$.sender_id') IS ${existingActor}
    AND json_extract(next, '$.sender_id') IS ${incomingActor}
    AND ${larkSenderNamespaceSql(existingJson, existingRaw, existingActor, allowLegacy)}
      = ${larkSenderNamespaceSql(incomingJson, incomingRaw, incomingActor, allowLegacy)}`;
    const sameActor = actorMatches();
    const sameContainer = `${existingContainer} IS NOT NULL AND ${existingContainer} <> ''
    AND ${existingContainer} IS ${incomingContainer}
    AND json_extract(old, '$.chat_id') IS ${existingContainer}
    AND json_extract(next, '$.chat_id') IS ${incomingContainer}`;
    // Legacy unknown account evidence remains compatible; two explicit, different
    // account markers cannot lend adopted names across a received-only old DB.
    const oldAccount = `COALESCE(json_extract(old, '$.sender_name_account_key'),
    json_extract(old, '$.sender_name_verification.account_key'))`;
    const nextAccount = `COALESCE(json_extract(next, '$.sender_name_account_key'),
    json_extract(next, '$.sender_name_verification.account_key'))`;
    const compatibleNameAccount = `(${oldAccount} IS NULL OR ${nextAccount} IS NULL OR ${oldAccount} IS ${nextAccount})`;
    const groups = [
        {
            identity: `(${sameActor}) AND (${sameContainer}) AND (${compatibleNameAccount})`,
            name: '$.sender_name', state: '$.sender_name_state',
            historical: `json_extract(next, '$.sender_name_source') IN ('local_history', 'chat_bot_unique')`,
            fields: ['$.sender_name', '$.sender_name_source', '$.sender_name_confidence',
                '$.sender_name_state', '$.sender_name_resolution_status', '$.sender_name_resolution_reason',
                '$.sender_name_authority_source', '$.sender_name_account_key', '$.sender_name_observed_at'],
        },
        {
            identity: sameContainer,
            name: '$.chat_name', state: '$.chat_name_state',
            historical: `json_extract(next, '$.chat_name_source') IN ('scope_config', 'local_history')`,
            fields: ['$.chat_name', '$.chat_name_state', '$.chat_name_source'],
        },
        {
            identity: `${sameContainer}
        AND ${larkPartnerIdentityMatchesSql('old', 'next', existingRaw, incomingRaw)}`,
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
            : group.name === '$.chat_partner.name' ? larkPartnerNameIsUnknownSql('next', incomingRaw)
                : `COALESCE(json_extract(next, '${group.name}'), '') = ''`;
        const oldUnknown = group.name === '$.sender_name'
            // An incoming source may reveal that the historical display was an ID.
            // Retain it only when neither source identifies it as an alias.
            ? `(${larkSenderNameIsUnknownSql('old', existingRaw, existingActor)}
        OR ${larkSenderNameIsUnknownSql('old', incomingRaw, incomingActor)})`
            : group.name === '$.chat_partner.name'
                ? `(${larkPartnerNameIsUnknownSql('old', existingRaw)} OR ${larkPartnerNameIsUnknownSql('old', incomingRaw)})`
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
    // A legacy guessed app display may remain on this exact record while it is
    // reverified. It cannot be introduced or transferred by a new projection.
    // Earlier stages restore a reliable predecessor if a caller submits a guess.
    const beforeGuessGuard = `n${index}`;
    index += 1;
    stages.push(`n${index} AS MATERIALIZED (SELECT old, CASE
    WHEN json_extract(next, '$.sender_name_source') = 'chat_bot_unique'
      AND NOT COALESCE((COALESCE(json_extract(old, '$.sender_name_source'), '') = 'chat_bot_unique'
        AND json_extract(old, '$.sender_name') IS json_extract(next, '$.sender_name')
        AND json_extract(old, '$.message_id') IS json_extract(next, '$.message_id')
        AND (${sameActor}) AND (${sameContainer}) AND (${compatibleNameAccount})),0)
    THEN json('unverified_app_name_projection') ELSE next END AS next FROM ${beforeGuessGuard})`);
    // A lookup failure preserves the adopted name but records its own latest
    // result. An absent lookup can retain an already account-bound diagnostic;
    // it never binds the incoming record to a new account or invents a time.
    // Inspect original incoming markers: name merging may already have restored
    // adopted fields, which must not hide an explicit incompatible marker.
    const adoptedAccount = `json_extract(old, '$.sender_name_account_key')`;
    const diagnosticAccountPaths = ['$.sender_name_account_key', '$.chat_name_account_key',
        '$.sender_name_verification.account_key'];
    const diagnosticAccountsMatch = ['old', incomingJson].flatMap(json => diagnosticAccountPaths.map(path => `(json_type(${json}, '${path}') IS NULL OR json_type(${json}, '${path}') = 'text'
      AND json_extract(${json}, '${path}') IS ${adoptedAccount})`)).join(' AND ');
    // Legacy diagnostics with no account anywhere remain unbound. Null, invalid
    // values, or a marker on only one side are not absence and cannot use this
    // compatibility branch to manufacture or borrow account evidence.
    const diagnosticAccountsAbsent = ['old', incomingJson].flatMap(json => diagnosticAccountPaths.map(path => `json_type(${json}, '${path}') IS NULL`)).join(' AND ');
    // A failed inline lookup has no adopted sender account to retain. Its safe
    // diagnostic can nevertheless survive a no-query replay of the exact source
    // version when an independent, already stored account anchor agrees. This
    // branch copies only the latest diagnostic, never an adoption/ownership key.
    const failureAccount = `json_extract(old, '$.sender_name_verification.account_key')`;
    const failurePath = '$.sender_name_verification.failure';
    const failureKinds = ['network_timeout', 'network_error', 'rate_limited', 'service_unavailable', 'internal_error',
        'restricted_mode', 'bot_user_out_of_chat', 'permission_denied', 'command_unavailable', 'spawn_error', 'unknown', 'budget_exhausted'];
    const failedDiagnosticAccounts = ['old', incomingJson].map(json => `(
    ${[...diagnosticAccountPaths, '$.message_account_evidence.account_key'].map(path => `(json_type(${json}, '${path}') IS NULL OR json_type(${json}, '${path}')='text'
        AND json_extract(${json}, '${path}') IS ${failureAccount})`).join(' AND ')}
    AND (json_type(${json}, '$.message_account_evidence') IS NULL
      OR json_type(${json}, '$.message_account_evidence')='object'
        AND json_extract(${json}, '$.message_account_evidence.account_key') IS ${failureAccount})
    AND NOT EXISTS (SELECT parent,key FROM json_tree(${json}) WHERE key IS NOT NULL
      GROUP BY parent,key HAVING COUNT(*)>1))`).join(' AND ');
    const sameDiagnosticVersion = accountRetention ? ['source_id', 'record_type', 'external_id', 'external_version',
        'actor_id', 'container_id', 'direction', 'occurred_at', 'occurred_at_ms', 'raw_json', 'content_hash'].map(column => `${accountRetention.existingAlias}.${column} IS ${accountRetention.incomingAlias}.${column}`).join(' AND ') : '0';
    const failedDiagnosticRetention = accountRetention ? `(
    ${['source_id', 'record_type', 'external_id', 'external_version', 'actor_id', 'container_id', 'direction',
        'occurred_at', 'occurred_at_ms', 'raw_json', 'content_hash'].map(column => `${accountRetention.existingAlias}.${column} IS ${accountRetention.incomingAlias}.${column}`).join(' AND ')}
    AND json_type(old, '$.sender_name_account_key') IS NULL AND json_type(next, '$.sender_name_account_key') IS NULL
    AND json_type(old, '$.sender_name_verification.account_key')='text'
    AND length(${failureAccount})=64 AND ${failureAccount} NOT GLOB '*[^0-9a-f]*'
    AND (json_extract(old, '$.chat_name_account_key') IS ${failureAccount}
      OR json_extract(old, '$.message_account_evidence.account_key') IS ${failureAccount})
    AND (${failedDiagnosticAccounts})
    AND json_extract(old, '$.sender_name_verification.status')='failed'
    AND json_extract(old, '$.sender_name_verification.reason') IN ('request_failed','budget_exhausted')
    AND json_type(old, '$.sender_name_verification.cached')='false'
    AND json_type(old, '$.sender_name_verification.observed_at')='text'
    AND NOT EXISTS (SELECT 1 FROM json_each(old, '$.sender_name_verification')
      WHERE key NOT IN ('status','reason','source','observed_at','cached','account_key','failure','pages_observed','route_failures'))
    AND (json_extract(old, '$.sender_id_type')='open_id'
        AND json_extract(old, '$.sender_name_verification.source') IN ('contact','chat_member')
      OR json_extract(old, '$.sender_id_type')='app_id'
        AND json_extract(old, '$.sender_name_verification.source') IN ('application_api','chat_bot_app_id'))
    AND json_type(old, '${failurePath}')='object'
    AND (SELECT COUNT(*) FROM json_each(old, '${failurePath}'))=5
    AND NOT EXISTS (SELECT 1 FROM json_each(old, '${failurePath}')
      WHERE key NOT IN ('version','operation','kind','code','stage'))
    AND json_type(old, '${failurePath}.version')='integer' AND json_extract(old, '${failurePath}.version')=1
    AND json_extract(old, '${failurePath}.operation')=CASE json_extract(old, '$.sender_name_verification.source')
      WHEN 'contact' THEN 'contact_search' WHEN 'chat_member' THEN 'chat_members'
      WHEN 'application_api' THEN 'application_info' WHEN 'chat_bot_app_id' THEN 'chat_bots' END
    AND json_extract(old, '${failurePath}.kind') IN (${failureKinds.map(kind => `'${kind}'`).join(',')})
    AND json_extract(old, '${failurePath}.stage') IN ('not_requested','response_error','request_error','unknown')
    AND (json_type(old, '${failurePath}.code')='null' AND json_extract(old, '${failurePath}.stage')<>'response_error'
      OR json_type(old, '${failurePath}.code')='integer' AND json_extract(old, '${failurePath}.code') BETWEEN 0 AND 9007199254740991
        AND json_extract(old, '${failurePath}.stage')='response_error')
    AND (json_extract(old, '${failurePath}.kind')='budget_exhausted'
        AND json_extract(old, '${failurePath}.stage')='not_requested'
        AND json_extract(old, '$.sender_name_verification.reason')='budget_exhausted'
      OR json_extract(old, '${failurePath}.kind')<>'budget_exhausted'
        AND json_extract(old, '$.sender_name_verification.reason')='request_failed')
  )` : '0';
    const diagnosticKeysUnique = ['old', incomingJson].map(json => `NOT EXISTS (
    SELECT key FROM json_each(${json})
    WHERE key IN ('message_id','sender_id','sender_id_type','chat_id','sender_name','sender_name_source',
      'sender_name_state','sender_name_account_key','chat_name_account_key','sender_name_verification')
    GROUP BY key HAVING COUNT(*) > 1) AND NOT EXISTS (
      SELECT key FROM json_each(CASE WHEN json_type(${json}, '$.sender_name_verification') = 'object'
        THEN json_extract(${json}, '$.sender_name_verification') ELSE '{}' END)
      WHERE key = 'account_key' GROUP BY key HAVING COUNT(*) > 1)`).join(' AND ');
    const diagnosticSourceKeys = [
        ['$', ['id', 'message_id', 'chat_id', 'sender_name_state', 'sender', 'chat', 'raw_api']],
        ['$.sender', ['id', 'id_type', 'sender_id', 'open_id', 'user_id', 'union_id', 'app_id', 'sender_type', 'type', 'name_state']],
        ['$.sender.sender_id', ['open_id', 'user_id', 'union_id', 'app_id']],
        ['$.chat', ['id', 'chat_id']],
    ];
    const diagnosticSourceMatches = [existingRaw, incomingRaw].map(raw => `(WITH source AS MATERIALIZED (
      SELECT CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END AS raw
    ), documents AS MATERIALIZED (
      SELECT raw AS document FROM source UNION ALL
      SELECT json_extract(raw, '$.raw_api') FROM source WHERE json_type(raw, '$.raw_api') = 'object'
    ) SELECT json_valid(${raw}) AND (SELECT json_type(raw) FROM source) = 'object'
      AND NOT EXISTS (SELECT 1 FROM documents WHERE
        COALESCE(json_extract(document, '$.sender_name_state'), '') = 'cleared'
        OR COALESCE(json_extract(document, '$.sender.name_state'), '') = 'cleared'
        OR ${diagnosticSourceKeys.map(([path, keys]) => `EXISTS (SELECT key FROM json_each(
          CASE WHEN json_type(document, '${path}') = 'object' THEN json_extract(document, '${path}') ELSE '{}' END)
          WHERE key IN (${keys.map(key => `'${key}'`).join(',')}) GROUP BY key HAVING COUNT(*) > 1)`).join(' OR ')}
        OR ${['$.message_id', '$.id'].map(path => `(json_type(document, '${path}') IS NOT NULL
          AND (json_type(document, '${path}') <> 'text' OR json_extract(document, '${path}') IS NOT json_extract(old, '$.message_id')))`)
        .concat(['$.chat_id', '$.chat.chat_id', '$.chat.id'].map(path => `(json_type(document, '${path}') IS NOT NULL
          AND (json_type(document, '${path}') <> 'text' OR json_extract(document, '${path}') IS NOT ${existingContainer}))`)).join(' OR ')}
      ))`).join(' AND ');
    // Flat materialized stages keep strict route JSON validation below SQLite's
    // parser-stack limit. Payloads are at most two finite route descriptors.
    const beforeRouteValidation = `n${index}`;
    stages.push(`nr_bundle AS MATERIALIZED (SELECT old,next,
    CASE WHEN json_type(old, '$.sender_name_verification.route_failures')='object'
      THEN json_extract(old, '$.sender_name_verification.route_failures') ELSE '{}' END AS bundle
    FROM ${beforeRouteValidation})`);
    stages.push(`nr_items AS MATERIALIZED (SELECT old,json_extract(bundle, '$.version') AS route_version, route.key AS position,route.type AS item_type,
    CASE WHEN route.type='object' THEN route.value ELSE '{}' END AS item
    FROM nr_bundle,json_each(bundle, '$.routes') AS route)`);
    stages.push(`nr_failure AS MATERIALIZED (SELECT *,
    CASE WHEN json_type(item, '$.failure')='object' THEN json_extract(item, '$.failure') ELSE '{}' END AS failure
    FROM nr_items)`);
    stages.push(`nr_valid AS MATERIALIZED (SELECT *,
    json_type(item, '$.failure')='object' AND (SELECT COUNT(*) FROM json_each(failure))=5
    AND NOT EXISTS (SELECT 1 FROM json_each(failure) WHERE key NOT IN ('version','operation','kind','code','stage'))
    AND json_type(failure, '$.version')='integer' AND json_extract(failure, '$.version')=1
    AND json_extract(failure, '$.operation') IS json_extract(item, '$.operation')
    AND json_extract(failure, '$.kind') IN (${failureKinds.map(kind => `'${kind}'`).join(',')})
    AND json_extract(failure, '$.stage') IN ('not_requested','response_error','request_error','unknown')
    AND (json_type(failure, '$.code')='null' AND json_extract(failure, '$.stage')<>'response_error'
      OR json_type(failure, '$.code')='integer' AND json_extract(failure, '$.code') BETWEEN 0 AND 9007199254740991
        AND json_extract(failure, '$.stage')='response_error')
    AND (json_extract(failure, '$.kind')<>'budget_exhausted' OR json_extract(failure, '$.stage')='not_requested') AS failure_valid
    FROM nr_failure)`);
    stages.push(`nr_routes AS MATERIALIZED (SELECT
    item_type='object' AND (SELECT COUNT(*) FROM json_each(item))=CASE route_version WHEN 2 THEN 4 ELSE 3 END
    AND NOT EXISTS (SELECT 1 FROM json_each(item) WHERE key NOT IN ('operation','status','failure')
      AND NOT (route_version=2 AND key='observed_at'))
    AND (route_version=1 OR (json_extract(item, '$.status')='unknown' AND json_type(item, '$.observed_at')='null'
      OR json_extract(item, '$.status')<>'unknown' AND json_type(item, '$.observed_at')='text'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(item, '$.observed_at'), '+0 seconds')=json_extract(item, '$.observed_at')
        AND julianday(json_extract(item, '$.observed_at')) BETWEEN 2440587.5 AND julianday('now')))
    AND json_extract(item, '$.operation')=CASE position WHEN 0 THEN 'application_info' ELSE 'chat_bots' END
    AND json_extract(item, '$.status') IN ('failed','unresolved','not_requested','unknown')
    AND (json_type(item, '$.failure')='null' OR json_extract(item, '$.status')='failed' AND failure_valid)
    AND (json_extract(item, '$.operation') IS NOT json_extract(old, '${failurePath}.operation')
      OR json_extract(item, '$.status')='failed'
        AND (route_version=1 OR json_extract(item, '$.observed_at') IS json_extract(old, '$.sender_name_verification.observed_at'))
        AND ${['version', 'operation', 'kind', 'code', 'stage'].map(key => `json_extract(failure, '$.${key}') IS json_extract(old, '${failurePath}.${key}')`).join(' AND ')}) AS valid
    FROM nr_valid)`);
    index += 1;
    stages.push(`n${index} AS MATERIALIZED (SELECT old,next,
    json_type(old, '$.sender_name_verification.route_failures') IS NULL OR (
      (${sameDiagnosticVersion}) AND (${failedDiagnosticAccounts})
      AND json_extract(old, '$.sender_id_type')='app_id'
      AND json_extract(old, '$.sender_name_verification.status')='failed'
      AND json_type(old, '$.sender_name_verification.cached')='false'
      AND json_extract(old, '$.sender_name_verification.source') IN ('application_api','chat_bot_app_id')
      AND json_type(old, '${failurePath}')='object'
      AND (SELECT COUNT(*) FROM json_each(old, '${failurePath}'))=5
      AND NOT EXISTS (SELECT 1 FROM json_each(old, '${failurePath}')
        WHERE key NOT IN ('version','operation','kind','code','stage'))
      AND json_extract(old, '${failurePath}.operation')=CASE json_extract(old, '$.sender_name_verification.source')
        WHEN 'application_api' THEN 'application_info' ELSE 'chat_bots' END
      AND (json_extract(old, '${failurePath}.kind')='budget_exhausted'
        AND json_extract(old, '$.sender_name_verification.reason')='budget_exhausted'
        OR json_extract(old, '${failurePath}.kind')<>'budget_exhausted'
          AND json_extract(old, '$.sender_name_verification.reason')='request_failed')
      AND json_type(old, '$.sender_name_verification.route_failures')='object'
      AND (SELECT COUNT(*) FROM json_each(bundle))=5
      AND NOT EXISTS (SELECT 1 FROM json_each(bundle) WHERE key NOT IN ('version','attempt_key','target_key','account_key','routes'))
      AND json_type(bundle, '$.version')='integer' AND json_extract(bundle, '$.version') IN (1,2)
      AND ${['attempt_key', 'target_key', 'account_key'].map(key => `(json_type(bundle, '$.${key}')='text'
        AND length(json_extract(bundle, '$.${key}'))=64 AND json_extract(bundle, '$.${key}') NOT GLOB '*[^0-9a-f]*')`).join(' AND ')}
      AND json_extract(bundle, '$.account_key') IS ${failureAccount}
      AND json_type(bundle, '$.routes')='array' AND json_array_length(bundle, '$.routes')=2
      AND NOT EXISTS (SELECT 1 FROM nr_routes WHERE NOT COALESCE(valid,0))
    ) AS route_diagnostic_valid FROM nr_bundle)`);
    const previous = `n${index}`;
    index += 1;
    stages.push(`n${index} AS MATERIALIZED (SELECT old, CASE
    WHEN (${actorMatches(false)}) AND (${sameContainer})
      AND json_type(old, '$.message_id') = 'text' AND json_extract(old, '$.message_id') <> ''
      AND json_extract(old, '$.message_id') IS json_extract(next, '$.message_id')
      AND json_type(next, '$.sender_name_verification') IS NULL
      AND json_type(old, '$.sender_name_verification') = 'object'
      AND COALESCE(json_extract(old, '$.sender_name_state'), '') <> 'cleared'
      AND COALESCE(json_extract(next, '$.sender_name_state'), '') <> 'cleared'
      AND json_extract(old, '$.sender_name') IS json_extract(next, '$.sender_name')
      AND json_extract(old, '$.sender_name_source') IS json_extract(next, '$.sender_name_source')
      AND ((json_type(old, '$.sender_name_account_key') = 'text'
        AND length(${adoptedAccount}) = 64 AND ${adoptedAccount} NOT GLOB '*[^0-9a-f]*'
        AND json_extract(old, '$.sender_name_verification.account_key') IS ${adoptedAccount}
        AND json_extract(next, '$.sender_name_account_key') IS ${adoptedAccount}
        AND (${diagnosticAccountsMatch}))
        OR ((${diagnosticAccountsAbsent}) AND json_type(next, '$.sender_name_account_key') IS NULL)
        OR ${failedDiagnosticRetention})
      AND (${diagnosticKeysUnique}) AND (${diagnosticSourceMatches}) AND route_diagnostic_valid
    THEN json_set(next, '$.sender_name_verification', json_extract(old, '$.sender_name_verification'))
    ELSE next END AS next FROM ${previous})`);
    // This marker is written only by the fenced current-chat observation task.
    // Reprojection must retain that independent account binding even when both
    // message titles are unknown. Incoming/source JSON cannot establish it: only
    // an already adopted marker may survive, under exact container and explicit
    // account compatibility. Inspect the original incoming projection, since the
    // preceding sender-name merge may have restored older account fields.
    const chatAccount = `json_extract(old, '$.chat_name_account_key')`;
    const accountPaths = ['$.chat_name_account_key', '$.sender_name_account_key',
        '$.sender_name_verification.account_key'];
    const accountCompatible = ['old', incomingJson].flatMap(json => accountPaths.map(path => `(json_type(${json}, '${path}') IS NULL OR json_type(${json}, '${path}') = 'null'
      OR json_type(${json}, '${path}') = 'text' AND json_extract(${json}, '${path}') IS ${chatAccount})`)).join(' AND ');
    const uniqueAccountKeys = ['old', incomingJson].map(json => `NOT EXISTS (
    SELECT key FROM json_each(${json})
    WHERE key IN ('chat_id','chat_name_account_key','sender_name_account_key','sender_name_verification')
    GROUP BY key HAVING COUNT(*) > 1) AND NOT EXISTS (
      SELECT key FROM json_each(CASE WHEN json_type(${json}, '$.sender_name_verification') = 'object'
        THEN json_extract(${json}, '$.sender_name_verification') ELSE '{}' END)
      WHERE key = 'account_key' GROUP BY key HAVING COUNT(*) > 1)`).join(' AND ');
    const rawChatMatches = [existingRaw, incomingRaw].map(raw => `(WITH raw_document AS MATERIALIZED (
      SELECT CASE WHEN json_valid(${raw}) THEN ${raw} ELSE '{}' END AS raw
    ), containers AS MATERIALIZED (
      SELECT raw AS value FROM raw_document UNION ALL
      SELECT json_extract(raw, '$.raw_api') FROM raw_document WHERE json_type(raw, '$.raw_api') = 'object'
    ) SELECT json_valid(${raw}) AND (SELECT json_type(raw) FROM raw_document) = 'object' AND NOT EXISTS (
      SELECT 1 FROM containers WHERE ${['$.chat_id', '$.chat.chat_id', '$.chat.id'].map(path => `(json_type(value, '${path}') IS NOT NULL AND json_type(value, '${path}') <> 'null'
          AND (json_type(value, '${path}') <> 'text' OR json_extract(value, '${path}') IS NOT ${existingContainer}))`).join(' OR ')}
    ))`).join(' AND ');
    const beforeChatAccount = `n${index}`;
    index += 1;
    stages.push(`n${index} AS MATERIALIZED (SELECT old,next,
    (${sameContainer}) AND json_type(old, '$.chat_name_account_key') = 'text'
      AND length(${chatAccount}) = 64 AND ${chatAccount} NOT GLOB '*[^0-9a-f]*'
      AND (${accountCompatible}) AND (${uniqueAccountKeys}) AND (${rawChatMatches}) AS keep_chat_account
    FROM ${beforeChatAccount})`);
    const decidedChatAccount = `n${index}`;
    index += 1;
    stages.push(`n${index} AS MATERIALIZED (SELECT old,next,keep_chat_account,
    CASE WHEN (SELECT count(*) FROM json_each(${incomingJson}) WHERE key='chat_name_account_key')>1
      OR (SELECT count(*) FROM json_each(next) WHERE key='chat_name_account_key')>1
    THEN json('json_patch_duplicate_key')
    WHEN json_type(next,'$.chat_name_account_key') IS NULL
      OR keep_chat_account AND json_type(next,'$.chat_name_account_key')='text'
        AND json_extract(next,'$.chat_name_account_key') IS ${chatAccount}
    THEN next WHEN length(CAST(next AS BLOB))<=8192 THEN ${removeChatAccountTextSql('next')}
    ELSE json('json_patch_limit') END AS without_chat_account
    FROM ${decidedChatAccount})`);
    const editedChatAccount = `n${index}`;
    index += 1;
    const lastBrace = `length(rtrim(without_chat_account,char(9)||char(10)||char(13)||' '))`;
    stages.push(`n${index} AS MATERIALIZED (SELECT old,CASE
    WHEN keep_chat_account AND json_type(without_chat_account,'$.chat_name_account_key') IS NULL
    THEN substr(without_chat_account,1,${lastBrace}-1)
      || CASE WHEN EXISTS(SELECT 1 FROM json_each(without_chat_account)) THEN ',' ELSE '' END
      || '"chat_name_account_key":' || json_quote(${chatAccount}) || substr(without_chat_account,${lastBrace})
    ELSE without_chat_account END AS next FROM ${editedChatAccount})`);
    // Restoring a previously absent field may move its JSON property position.
    // Compare paths and typed scalar values, so equivalent projections keep the
    // stored bytes and updated_at instead of recording a formatting-only update.
    // Numbers must use -> (JSON text), never atom/json_extract's numeric scalar:
    // distinct values outside int64 or decimal precision can otherwise compare
    // equal and cause a legitimate incoming unknown value to be discarded.
    const comparable = (json) => `SELECT fullkey, type,
    CASE WHEN type IN ('integer', 'real') THEN ${json} -> fullkey ELSE atom END
    FROM json_tree(${json})`;
    let resultStage = `n${index}`;
    if (accountRetention) {
        const retention = messageAccountRetentionStages(accountRetention.existingAlias, accountRetention.incomingAlias, resultStage);
        stages.push(...retention.stages);
        resultStage = retention.resultStage;
    }
    return `(WITH RECURSIVE ${stages.join(',\n')} SELECT CASE WHEN
    NOT EXISTS (${comparable('next')} EXCEPT ${comparable('old')})
    AND NOT EXISTS (${comparable('old')} EXCEPT ${comparable('next')})
    THEN old ELSE next END FROM ${resultStage})`;
}
export { larkSenderNameIsUnknownSql, larkSenderNamespaceSql, mergeLarkNameProjectionSql };
