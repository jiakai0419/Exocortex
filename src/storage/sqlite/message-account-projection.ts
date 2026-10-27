const MEMBER = 'message_account_evidence';
const PROOF_PATH = `$.${MEMBER}`;
const PROOF_KEYS = ['schema', 'source_id', 'account_key', 'external_id', 'container_id',
  'source_hash', 'source_version', 'acquired_at'];
const ACCOUNT_PATHS = ['$.sender_name_account_key', '$.chat_name_account_key',
  '$.sender_name_verification.account_key', '$.message_account_evidence.account_key'];

/** Return the exact member key/value span, including whitespace and escapes.
 * The caller has validated JSON, unique keys and an object-valued member.
 * BLOB scanning keeps byte offsets linear even when earlier text is non-ASCII;
 * nothing outside this member is parsed into JS or reserialized by SQLite. */
function proofObjectStages(decision: string, prefix: string): string[] {
  const input = `${prefix}_scan_input`, scan = `${prefix}_scan`, terminal = `${prefix}_scan_terminal`;
  const byte = 'substr(doc,pos,1)';
  const closingKey = `quoted AND NOT escaped AND ${byte}=X'22' AND depth=1 AND reading_key`;
  return [`${input} AS MATERIALIZED (SELECT CAST(old_doc AS BLOB) AS doc FROM ${decision} WHERE keep)`,
    `${scan}(pos,depth,quoted,escaped,quote_start,reading_key,wanted,member_start,value_start,value_end,doc) AS (
      SELECT 1,0,0,0,0,0,0,0,0,0,doc FROM ${input}
      UNION ALL SELECT pos+1,
        depth + CASE WHEN quoted THEN 0 WHEN ${byte} IN (X'7b',X'5b') THEN 1
          WHEN ${byte} IN (X'7d',X'5d') THEN -1 ELSE 0 END,
        CASE WHEN quoted THEN CASE WHEN NOT escaped AND ${byte}=X'22' THEN 0 ELSE 1 END
          WHEN ${byte}=X'22' THEN 1 ELSE 0 END,
        CASE WHEN quoted AND NOT escaped AND ${byte}=X'5c' THEN 1 ELSE 0 END,
        CASE WHEN NOT quoted AND ${byte}=X'22' THEN pos ELSE quote_start END,
        CASE WHEN NOT quoted AND (${byte}=X'7b' AND depth=0 OR ${byte}=X'2c' AND depth=1) THEN 1
          WHEN NOT quoted AND ${byte}=X'3a' AND depth=1 THEN 0 ELSE reading_key END,
        CASE WHEN ${closingKey} THEN
          json_extract('[' || CAST(substr(doc,quote_start,pos-quote_start+1) AS TEXT) || ']', '$[0]')='${MEMBER}'
          ELSE wanted END,
        CASE WHEN ${closingKey} AND
          json_extract('[' || CAST(substr(doc,quote_start,pos-quote_start+1) AS TEXT) || ']', '$[0]')='${MEMBER}'
          THEN quote_start ELSE member_start END,
        CASE WHEN wanted AND NOT quoted AND NOT reading_key AND depth=1 AND ${byte}=X'7b'
          THEN pos ELSE value_start END,
        CASE WHEN value_start>0 AND NOT quoted AND depth=2 AND ${byte}=X'7d' THEN pos ELSE value_end END,doc
      FROM ${scan} WHERE value_end=0 AND pos<=length(doc)
    )`, `${terminal} AS MATERIALIZED (SELECT * FROM ${scan} ORDER BY pos DESC LIMIT 1)`,
    `${prefix}_value AS MATERIALIZED (SELECT CASE WHEN member_start>0 AND value_start>member_start AND value_end>=value_start
      THEN CAST(substr(doc,member_start,value_end-member_start+1) AS TEXT) ELSE NULL END AS value
      FROM ${terminal})`];
}

function uniqueKeysSql(document: string): string {
  return `NOT EXISTS (SELECT parent,key FROM json_tree(${document}) WHERE typeof(key)='text'
    GROUP BY parent,key HAVING COUNT(*)>1)`;
}

function equivalenceStages(inserted: string, prefix: string): string[] {
  // The retained member includes its original escaped key spelling, so its
  // fullkey stays stable. Avoid recursive path normalization in correlated
  // store expressions: it repeatedly materializes the entire upstream chain.
  const comparable = `${prefix}_comparable`;
  return [`${comparable}(side,path,type,value) AS MATERIALIZED (
      SELECT 'old',j.fullkey,j.type,CASE WHEN j.type IN ('integer','real') THEN old_doc -> j.fullkey ELSE j.atom END
        FROM ${inserted} CROSS JOIN json_tree(old_doc) j
      UNION ALL SELECT 'next',j.fullkey,j.type,CASE WHEN j.type IN ('integer','real') THEN retained -> j.fullkey ELSE j.atom END
        FROM ${inserted} CROSS JOIN json_tree(retained) j)`,
    `${prefix}_equal AS MATERIALIZED (SELECT CASE
      WHEN NOT EXISTS (SELECT path,type,value FROM ${comparable} WHERE side='old'
        EXCEPT SELECT path,type,value FROM ${comparable} WHERE side='next')
      AND NOT EXISTS (SELECT path,type,value FROM ${comparable} WHERE side='next'
        EXCEPT SELECT path,type,value FROM ${comparable} WHERE side='old')
      THEN old_doc ELSE retained END AS next FROM ${inserted})`];
}

/** Preserve already-attested acquisition ownership on an exact no-proof replay,
 * or keep the entire old canonical when the sole new fact is a later acquisition
 * clock for the identical source/identity/projection. This is first retained
 * evidence, not an assertion of the message's true first acquisition. Other new
 * or explicitly null evidence wins. The reader separately hashes exact raw.
 * Alias/expression arguments are trusted SQL fragments supplied by the store. */
function messageAccountRetentionStages(existingAlias: string, incomingAlias: string,
  previousStage: string, prefix = 'acquisition'): { stages: string[]; resultStage: string } {
  const incoming = `${incomingAlias}.canonical_json`;
  const sameColumns = ['source_id', 'record_type', 'external_id', 'actor_id', 'container_id',
    'raw_json', 'content_hash', 'external_version'].map(column =>
    `${existingAlias}.${column} IS ${incomingAlias}.${column}`).join(' AND ');
  const account = `json_extract(proof,'$.account_key')`;
  const accountCompatible = ['old_doc', 'incoming_doc', 'next_doc', 'old_raw', 'incoming_raw', 'old_native', 'incoming_native']
    .flatMap(document => ACCOUNT_PATHS.map(path =>
    `(json_type(${document},'${path}') IS NULL OR json_type(${document},'${path}')='text'
      AND json_extract(${document},'${path}') IS ${account})`)).join(' AND ');
  const uniqueDocuments = ['old_doc', 'incoming_doc', 'next_doc', 'old_raw', 'incoming_raw']
    .map(uniqueKeysSql).join(' AND ');
  const acquiredAt = `json_extract(proof,'$.acquired_at')`;
  const lastBrace = `length(rtrim(next_doc,char(9)||char(10)||char(13)||' '))`;
  const input = `${prefix}_input`, eligible = `${prefix}_eligible`, documents = `${prefix}_documents`;
  const basis = `${prefix}_basis`, decision = `${prefix}_decision`, validated = `${prefix}_validated`;
  const inserted = `${prefix}_inserted`, refreshed = `${prefix}_refreshed`, refreshComparable = `${prefix}_refresh_comparable`;
  const resultStage = `${prefix}_result`;
  const stages = [`${input} AS MATERIALIZED (
      SELECT old AS old_doc,${incoming} AS incoming_doc,next AS next_doc FROM ${previousStage})`,
    `${eligible} AS MATERIALIZED (SELECT *,CASE
      WHEN NOT json_valid(old_doc) OR NOT json_valid(incoming_doc) OR NOT json_valid(next_doc) THEN 0
      WHEN old_doc IS next_doc OR json_type(old_doc,'${PROOF_PATH}') IS NOT 'object' THEN 0
      WHEN json_type(incoming_doc,'${PROOF_PATH}') IS NULL AND json_type(next_doc,'${PROOF_PATH}') IS NULL THEN 1
      WHEN json_type(incoming_doc,'${PROOF_PATH}')='object' AND json_type(next_doc,'${PROOF_PATH}')='object' THEN 2
      ELSE 0 END AS eligible FROM ${input})`,
    `${documents} AS MATERIALIZED (
        SELECT old_doc,incoming_doc,next_doc,eligible,
          CASE WHEN json_valid(${existingAlias}.raw_json) THEN ${existingAlias}.raw_json ELSE '{}' END AS old_raw,
          CASE WHEN json_valid(${incomingAlias}.raw_json) THEN ${incomingAlias}.raw_json ELSE '{}' END AS incoming_raw,
          json_extract(old_doc,'${PROOF_PATH}') AS proof,
          json_extract(incoming_doc,'${PROOF_PATH}') AS incoming_proof,
          json_extract(next_doc,'${PROOF_PATH}') AS next_proof
        FROM ${eligible} WHERE eligible)`,
    `${basis} AS MATERIALIZED (
        SELECT *,CASE WHEN json_type(old_raw,'$.raw_api')='object'
          THEN json_extract(old_raw,'$.raw_api') ELSE old_raw END AS old_native,
          CASE WHEN json_type(incoming_raw,'$.raw_api')='object'
          THEN json_extract(incoming_raw,'$.raw_api') ELSE incoming_raw END AS incoming_native
        FROM ${documents})`,
    `${decision} AS MATERIALIZED (
        SELECT *,${sameColumns}
          AND ${existingAlias}.source_id='lark.im' AND ${existingAlias}.record_type='lark.im.message'
          AND typeof(${existingAlias}.external_id)='text' AND length(trim(${existingAlias}.external_id))>0
          AND typeof(${existingAlias}.container_id)='text' AND length(trim(${existingAlias}.container_id))>0
          AND instr(${existingAlias}.external_id,char(0))=0 AND instr(${existingAlias}.container_id,char(0))=0
          AND ${existingAlias}.external_id NOT GLOB '*['||char(1)||'-'||char(31)||char(127)||']*'
          AND ${existingAlias}.container_id NOT GLOB '*['||char(1)||'-'||char(31)||char(127)||']*'
          AND typeof(${existingAlias}.content_hash)='text' AND length(${existingAlias}.content_hash)=64
          AND ${existingAlias}.content_hash NOT GLOB '*[^0-9a-f]*'
          AND json_type(old_doc)='object' AND json_type(incoming_doc)='object' AND json_type(next_doc)='object'
          AND json_valid(${existingAlias}.raw_json) AND json_valid(${incomingAlias}.raw_json)
          AND json_type(old_raw)='object' AND json_type(incoming_raw)='object'
          AND (json_type(old_raw,'$.raw_api') IS NULL OR json_type(old_raw,'$.raw_api') IN ('object','null'))
          AND (json_type(incoming_raw,'$.raw_api') IS NULL OR json_type(incoming_raw,'$.raw_api') IN ('object','null'))
          AND (SELECT count(*) FROM json_each(proof))=8
          AND NOT EXISTS(SELECT 1 FROM json_each(proof) WHERE key NOT IN (${PROOF_KEYS.map(key => `'${key}'`).join(',')}))
          AND json_type(proof,'$.schema')='text' AND json_extract(proof,'$.schema')='lark_message_acquisition/v1'
          AND json_type(proof,'$.source_id')='text' AND json_extract(proof,'$.source_id') IS ${existingAlias}.source_id
          AND json_type(proof,'$.account_key')='text' AND length(${account})=64 AND ${account} NOT GLOB '*[^0-9a-f]*'
          AND json_type(proof,'$.external_id')='text' AND json_extract(proof,'$.external_id') IS ${existingAlias}.external_id
          AND json_type(proof,'$.container_id')='text' AND json_extract(proof,'$.container_id') IS ${existingAlias}.container_id
          AND json_type(proof,'$.source_hash')='text' AND json_extract(proof,'$.source_hash') IS ${existingAlias}.content_hash
          AND (json_type(proof,'$.source_version')='null' AND ${existingAlias}.external_version IS NULL
            OR json_type(proof,'$.source_version')='text' AND typeof(${existingAlias}.external_version)='text'
              AND length(${existingAlias}.external_version)>0
              AND json_extract(proof,'$.source_version') IS ${existingAlias}.external_version)
          AND json_type(proof,'$.acquired_at')='text' AND length(${acquiredAt})=24
          AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(${acquiredAt})) IS ${acquiredAt}
          AND ${acquiredAt}>='1970-01-01T00:00:00.000Z'
          AND ${acquiredAt}<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND (${accountCompatible}) AND (${uniqueDocuments}) AS valid
        FROM ${basis})`,
    `${validated} AS MATERIALIZED (SELECT *,eligible=1 AND valid AS keep FROM ${decision})`];
  stages.push(...proofObjectStages(validated, prefix));
  stages.push(`${inserted} AS MATERIALIZED (
          SELECT old_doc,CASE WHEN value IS NULL THEN next_doc ELSE substr(next_doc,1,${lastBrace}-1)
            || CASE WHEN EXISTS(SELECT 1 FROM json_each(next_doc)) THEN ',' ELSE '' END
            || value || substr(next_doc,${lastBrace}) END AS retained
          FROM ${validated},${prefix}_value)`);
  stages.push(...equivalenceStages(inserted, prefix));
  const nextTime = `json_extract(next_proof,'$.acquired_at')`;
  const sameProof = PROOF_KEYS.filter(field => field !== 'acquired_at').map(field =>
    `json_type(next_proof,'$.${field}') IS json_type(proof,'$.${field}')
      AND json_extract(next_proof,'$.${field}') IS json_extract(proof,'$.${field}')`).join(' AND ');
  const incomingMatches = PROOF_KEYS.map(field =>
    `json_type(incoming_proof,'$.${field}') IS json_type(next_proof,'$.${field}')
      AND json_extract(incoming_proof,'$.${field}') IS json_extract(next_proof,'$.${field}')`).join(' AND ');
  stages.push(`${refreshed} AS MATERIALIZED (
    SELECT old_doc,next_doc,
      (SELECT fullkey FROM json_each(old_doc) WHERE key='${MEMBER}') AS old_proof_path,
      (SELECT fullkey FROM json_each(next_doc) WHERE key='${MEMBER}') AS next_proof_path
    FROM ${validated} WHERE eligible=2 AND valid
      AND ${['direction', 'body', 'title', 'occurred_at', 'occurred_at_ms'].map(column =>
        `${existingAlias}.${column} IS ${incomingAlias}.${column}`).join(' AND ')}
      AND (SELECT count(*) FROM json_each(next_proof))=8 AND (SELECT count(*) FROM json_each(incoming_proof))=8
      AND (${sameProof}) AND (${incomingMatches})
      AND json_type(next_proof,'$.acquired_at')='text' AND length(${nextTime})=24
      AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(${nextTime})) IS ${nextTime}
      AND ${nextTime}>=${acquiredAt} AND ${nextTime}<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  // Proof fields are a closed, flat schema. Normalize only that owned path;
  // preserve every unrelated path and numeric token in the equality test.
  const comparableRefresh = (side: string, document: string, proofPath: string) => `SELECT '${side}',
    CASE WHEN j.fullkey=${proofPath} THEN '$.message_account_evidence'
      WHEN j.path=${proofPath} THEN '$.message_account_evidence.'||json_quote(j.key) ELSE j.fullkey END,
    j.type,CASE WHEN j.type IN ('integer','real') THEN ${document} -> j.fullkey ELSE j.atom END
    FROM ${refreshed} CROSS JOIN json_tree(${document}) j
    WHERE NOT (j.path=${proofPath} AND j.key='acquired_at')`;
  stages.push(`${refreshComparable}(side,path,type,value) AS MATERIALIZED (
    ${comparableRefresh('old', 'old_doc', 'old_proof_path')}
    UNION ALL ${comparableRefresh('next', 'next_doc', 'next_proof_path')})`);
  stages.push(`${prefix}_refresh_equal AS MATERIALIZED (SELECT old_doc AS next FROM ${refreshed}
    WHERE NOT EXISTS (SELECT path,type,value FROM ${refreshComparable} WHERE side='old'
      EXCEPT SELECT path,type,value FROM ${refreshComparable} WHERE side='next')
      AND NOT EXISTS (SELECT path,type,value FROM ${refreshComparable} WHERE side='next'
      EXCEPT SELECT path,type,value FROM ${refreshComparable} WHERE side='old'))`);
  stages.push(`${resultStage} AS MATERIALIZED (SELECT old_doc AS old,
    COALESCE((SELECT next FROM ${prefix}_equal),(SELECT next FROM ${prefix}_refresh_equal),next_doc) AS next FROM ${input})`);
  return { stages, resultStage };
}

/** Standalone expression for callers without an existing projection stage
 * chain. The store uses the flat-stage API to avoid wrapping its large name
 * merge expression in another deeply nested WITH/CASE expression. */
function retainMessageAccountEvidenceSql(existingAlias: string, incomingAlias: string,
  mergedCanonicalExpression: string): string {
  const seed = `acquisition_seed AS MATERIALIZED (SELECT ${existingAlias}.canonical_json AS old,
    ${mergedCanonicalExpression} AS next)`;
  const { stages, resultStage } = messageAccountRetentionStages(existingAlias, incomingAlias, 'acquisition_seed');
  return `(WITH RECURSIVE ${[seed, ...stages].join(',\n')} SELECT next FROM ${resultStage})`;
}

export { messageAccountRetentionStages, retainMessageAccountEvidenceSql };
