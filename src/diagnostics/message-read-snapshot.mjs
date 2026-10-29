// @ts-check
import { readOnlySqliteJson, SqliteReadError } from '../storage/sqlite/readonly-query.mjs';
import { sqliteReadDiagnostic } from './sqlite-read-diagnostic.mjs';
import { READINESS_CONTRACT_VERSION } from './message-readiness-ledger.mjs';
import { MESSAGE_READINESS_OBSERVATION_FIELDS, selectMessageReadinessObservations } from './message-completeness-summary.mjs';
import { larkSenderNameIsUnknownSql } from '../../dist/storage/sqlite/lark-name-projection.js';

const NAME_TABLE = 'lark_im_name_tasks', RECIPIENT_TABLE = 'lark_im_recipient_state', OBSERVATION_TABLE = 'lark_im_message_readiness';
const ROUTE_TABLE = 'lark_im_name_routes', ROUTE_INDEX = 'sqlite_autoindex_lark_im_name_routes_1';
const ROUTE_COLUMNS = ['source_id','account_key','route_key','operation','failure_kind','failure_code',
  'failures','last_attempt_at_ms','retry_at_ms','blocked','generation'];
const ROUTE_ACCOUNTS = 32, ROUTE_PER_ACCOUNT = 1024, ROUTE_ROWS = 2048;
const ROW_COLUMNS = ['id', 'source_id', 'direction', 'record_type', 'occurred_at', 'occurred_at_ms',
  'actor_id', 'container_id', 'external_id', 'external_version', 'content_hash', 'body', 'canonical_json', 'raw_json',
  'scope_config_json', 'type_scope_id', 'type_scope_source_id'];
const TASK_COLUMNS = ['source_id', 'account_key', 'task_key', 'kind', 'chat_id', 'actor_id', 'namespace',
  'evidence_json', 'outcome', 'latest_record_id', 'after_record_id', 'projection_horizon_record_id',
  'projection_deferred', 'witness_after_record_id', 'witness_horizon_record_id', 'retry_at_ms',
  'last_attempt_at_ms', 'failures', 'generation', 'attempt_token'];
const RECIPIENT_COLUMNS = ['source_id', 'account_key', 'chat_id', 'evidence_json', 'enqueued_at_ms',
  'last_attempt_at_ms', 'retry_at_ms', 'failures', 'record_after_id', 'generation', 'attempt_token',
  'attempt_evidence_json'];
const SCOPE_COLUMNS = ['id', 'source_id', 'config_json'];
const DONOR_INDEX = 'records_name_sender';
const DONOR_COLUMNS = ['id','source_id','record_type','external_id','external_version','actor_id','container_id',
  'direction','occurred_at','occurred_at_ms','content_hash','canonical_json','raw_json'];
const DONOR_ROWS = 1000, DONOR_BYTES = 8 * 1024 * 1024, DONOR_ROW_BYTES = 1024 * 1024;
// Filter only evidence-bearing candidates before applying the existing local
// history capacity. Ordinary unnamed or inherited messages do not use that
// capacity. No DISTINCT discards conflicting source bytes or names.
const donorCandidate = `CASE WHEN json_valid(d.canonical_json) AND json_valid(d.raw_json) THEN
  (json_extract(d.canonical_json,'$.sender_name_source') IN ('contact','self','chat_member','application_api','chat_bot_app_id')
    AND json_extract(d.canonical_json,'$.sender_name_confidence')='high'
    AND typeof(json_extract(d.canonical_json,'$.sender_name_account_key'))='text')
  OR json_extract(d.canonical_json,'$.sender_name_state')='cleared'
  OR json_extract(d.canonical_json,'$.sender_name_verification.status')='conflict'
  OR ${['$.sender_name_state','$.sender.name_state','$.raw_api.sender_name_state','$.raw_api.sender.name_state']
    .map(path=>`json_extract(d.raw_json,'${path}')='cleared'`).join(' OR ')}
  ELSE 1 END`;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const jsonObject = (columns, alias) => `json_object(${columns.flatMap(key => [quote(key), `${alias}.${key}`]).join(',')})`;
// Keep each wire value bounded by one source row. A giant aggregate JSON TEXT
// makes the SQLite CLI re-escape the whole page as one string, which is
// disproportionately expensive on supported SQLite shells. All branches still
// execute in one statement/snapshot; TEXT source tokens are never parsed here.
const rowQuery = (kind, columns, query, order) => `SELECT ${quote(kind)} AS kind,
  ROW_NUMBER() OVER (ORDER BY ${order}) AS position,${jsonObject(columns, 'item')} AS payload,
  NULL AS total,NULL AS evaluated,NULL AS not_evaluated,NULL AS source_max_record_id,
  NULL AS read_at,NULL AS schema_consistent FROM (${query}) item`;
const existsTable = table => `EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=${quote(table)})`;
const routeIndexColumns = `(SELECT group_concat(name,',') FROM pragma_index_info(${quote(ROUTE_INDEX)}))='source_id,account_key,route_key'`;
const existsRouteIndex = `EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name=${quote(ROUTE_INDEX)} AND ${routeIndexColumns})`;
const invalid = () => new SqliteReadError('invalid_response', 'read message snapshot returned invalid data',
  sqliteReadDiagnostic({ stage: 'snapshot_validate', kind: 'invalid_shape' }));

/**
 * A bounded page and its evidence share one read transaction/statement. The
 * earlier schema-only query chooses optional legacy-table branches; it never
 * reads message/evidence data. Schema races fail closed instead of falling back
 * to independently timed reads. Account and exact scope identity validation is
 * the projection caller's responsibility.
 *
 * @param {string} db
 * @param {{direction?:'all'|'sent'|'received',limit?:number,search?:string,recordIds?:number[]}} [options]
 * @param {{sqliteJson?:(db:string,sql:string,label:string)=>Record<string,any>[]}} [deps]
 */
function readMessageSnapshot(db, options = {}, deps = {}) {
  const { direction = 'all', limit = 30, search = '' } = options;
  if (!['all', 'sent', 'received'].includes(direction) || !Number.isSafeInteger(limit) || limit < 1
    || typeof search !== 'string' || search.includes('\0')) throw new TypeError('invalid message snapshot options');
  if (options.recordIds!==undefined && (!Array.isArray(options.recordIds) || options.recordIds.length>40
    || options.recordIds.some(id=>!Number.isSafeInteger(id) || id<1)
    || new Set(options.recordIds).size!==options.recordIds.length)) throw new TypeError('invalid internal message selection');
  const query = deps.sqliteJson || readOnlySqliteJson;
  const optionalTables = [NAME_TABLE, RECIPIENT_TABLE, OBSERVATION_TABLE, ROUTE_TABLE];
  const schema = query(db, `SELECT name FROM sqlite_schema WHERE (type='table'
    AND name IN (${optionalTables.map(quote).join(',')})) OR (type='index' AND (name=${quote(DONOR_INDEX)}
      OR name=${quote(ROUTE_INDEX)} AND ${routeIndexColumns})) ORDER BY name;`, 'read message snapshot schema');
  if (!Array.isArray(schema) || schema.some(row => ![...optionalTables,DONOR_INDEX,ROUTE_INDEX].includes(row.name))) throw invalid();
  const donorIndex = schema.some(row => row.name === DONOR_INDEX);
  const routeTable = schema.some(row => row.name === ROUTE_TABLE), routeIndex = schema.some(row => row.name === ROUTE_INDEX);
  const routesAvailable = routeTable && routeIndex;
  const available = { names: schema.some(row => row.name === NAME_TABLE), recipients: schema.some(row => row.name === RECIPIENT_TABLE),
    observations: schema.some(row => row.name === OBSERVATION_TABLE) };
  const filters = ["r.source_id='lark.im'", "r.record_type='lark.im.message'"];
  if (direction !== 'all') filters.push(`r.direction=${quote(direction)}`);
  if (search) filters.push(`r.body LIKE ${quote(`%${search}%`)}`);
  if (options.recordIds!==undefined) filters.push(options.recordIds.length?`r.id IN (${options.recordIds.join(',')})`:'0');
  const ordering = 'occurred_at_ms DESC,external_id DESC';
  const names = available.names ? rowQuery('nameTask', TASK_COLUMNS, `SELECT t.* FROM ${NAME_TABLE} t
    WHERE t.source_id='lark.im' AND (
      t.kind='chat' AND t.chat_id IN (SELECT container_id FROM containers)
      OR t.kind='sender' AND EXISTS (SELECT 1 FROM selected p WHERE p.container_id=t.chat_id AND p.actor_id=t.actor_id))
    `, 'account_key,task_key') : null;
  const recipients = available.recipients ? rowQuery('recipient', RECIPIENT_COLUMNS, `SELECT s.* FROM ${RECIPIENT_TABLE} s
    WHERE s.source_id='lark.im' AND s.chat_id IN (SELECT container_id FROM containers)`, 'account_key,chat_id') : null;
  // Count every v1 observer BEFORE checking its source epoch or validity. One
  // account's stale/bad row must not make another account appear unambiguous.
  // Only unique candidates become wire payloads, bounding this branch by the
  // selected page even if an invalid legacy table has many duplicate observers.
  const observations = available.observations ? rowQuery('observation', MESSAGE_READINESS_OBSERVATION_FIELDS,
    `SELECT o.* FROM ${OBSERVATION_TABLE} o JOIN (
      SELECT h.record_id FROM ${OBSERVATION_TABLE} h JOIN selected_ids p ON p.id=h.record_id
      WHERE h.source_id='lark.im' AND h.contract_version=${READINESS_CONTRACT_VERSION}
      GROUP BY h.record_id HAVING COUNT(*)=1
    ) unique_observer ON unique_observer.record_id=o.record_id
    WHERE o.source_id='lark.im' AND o.contract_version=${READINESS_CONTRACT_VERSION}
      AND length(CAST(o.reasons_json AS BLOB))<=4096 AND length(o.observer_account_key)=64
      AND length(o.source_version_key)=64 AND length(o.state)<=16`, 'record_id') : null;
  // Indexed actor prefixes are finite even when an actor has years of history.
  // Do not choose a first valid name from a truncated set: completeness below
  // makes an overflow explicit and lets ordinary authority repair handle it.
  const donorCtes = donorIndex ? `donor_actors AS MATERIALIZED (
      SELECT actor_id,MIN(id) AS selected_id FROM selected WHERE typeof(actor_id)='text' AND actor_id<>''
        AND CASE WHEN json_valid(canonical_json) THEN
          json_extract(canonical_json,'$.sender_id_type') IN ('open_id','app_id')
          AND NOT (json_extract(canonical_json,'$.sender_name_confidence') IS 'high'
            AND (json_extract(canonical_json,'$.sender_id_type')='open_id'
              AND COALESCE(CASE WHEN json_extract(canonical_json,'$.sender_name_source')='local_history'
                THEN json_extract(canonical_json,'$.sender_name_authority_source')
                ELSE json_extract(canonical_json,'$.sender_name_source') END,'') IN ('contact','self','chat_member')
              OR json_extract(canonical_json,'$.sender_id_type')='app_id'
              AND COALESCE(CASE WHEN json_extract(canonical_json,'$.sender_name_source')='local_history'
                THEN json_extract(canonical_json,'$.sender_name_authority_source')
                ELSE json_extract(canonical_json,'$.sender_name_source') END,'') IN ('application_api','chat_bot_app_id'))
            AND typeof(json_extract(canonical_json,'$.sender_name_account_key'))='text'
            AND length(json_extract(canonical_json,'$.sender_name_account_key'))=64
            AND json_extract(canonical_json,'$.sender_name_account_key') NOT GLOB '*[^a-f0-9]*'
            AND typeof(json_extract(canonical_json,'$.sender_name'))='text'
            AND NOT ${larkSenderNameIsUnknownSql('selected.canonical_json','selected.raw_json','selected.actor_id')}) ELSE 0 END
      GROUP BY actor_id ORDER BY selected_id DESC LIMIT 100
    ), donor_prefixes AS MATERIALIZED (
      SELECT actor_id,(SELECT json_group_array(id) FROM (
        SELECT id FROM records d INDEXED BY ${DONOR_INDEX} WHERE source_id='lark.im'
          AND record_type='lark.im.message' AND actor_id=a.actor_id AND (${donorCandidate}) LIMIT ${DONOR_ROWS + 1}
      )) AS ids FROM donor_actors a
    ), donor_ids AS MATERIALIZED (
      SELECT p.actor_id,j.value AS id,ROW_NUMBER() OVER(PARTITION BY p.actor_id ORDER BY j.key) AS actor_position,
        json_array_length(p.ids) AS actor_count FROM donor_prefixes p,json_each(p.ids) j
    ), donor_ranked AS MATERIALIZED (
      SELECT *,ROW_NUMBER() OVER(ORDER BY actor_position,actor_id) AS payload_position FROM donor_ids
    ), donor_sizes AS MATERIALIZED (
      SELECT d.*,CASE WHEN payload_position<=${DONOR_ROWS} THEN
        length(CAST(COALESCE(r.canonical_json,'') AS BLOB))+length(CAST(COALESCE(r.raw_json,'') AS BLOB))
        ELSE 0 END AS bytes FROM donor_ranked d JOIN records r ON r.id=d.id
    ), donor_budget AS MATERIALIZED (
      SELECT *,SUM(CASE WHEN bytes<=${DONOR_ROW_BYTES} AND payload_position<=${DONOR_ROWS} THEN bytes ELSE 0 END)
        OVER(ORDER BY payload_position) AS payload_bytes FROM donor_sizes
    ), donor_groups AS MATERIALIZED (
      SELECT actor_id,MIN(CASE WHEN actor_count<=${DONOR_ROWS} AND bytes<=${DONOR_ROW_BYTES}
        AND payload_position<=${DONOR_ROWS} AND payload_bytes<=${DONOR_BYTES} THEN 1 ELSE 0 END) AS complete
      FROM donor_budget GROUP BY actor_id
    ),` : '';
  const donorRows = donorIndex ? rowQuery('senderDonor', DONOR_COLUMNS,
    `SELECT ${DONOR_COLUMNS.map(key=>`r.${key}`).join(',')} FROM donor_budget b JOIN records r ON r.id=b.id
      JOIN donor_groups g ON g.actor_id=b.actor_id WHERE g.complete=1`, 'actor_id,id') : null;
  const donorGroups = donorIndex ? rowQuery('senderDonorGroup', ['actor_id','complete'],
    'SELECT * FROM donor_groups','actor_id') : null;
  // Hashes cannot be guessed in SQL or fetched in a later data snapshot. Read
  // bounded PK prefixes for selected acquisition-account candidates; consumers
  // revalidate proof and recompute exact keys. Prefixes include successes and
  // transient/unrelated routes so recovery is never hidden by denial filtering.
  const routeCtes = routesAvailable ? `route_account_candidates AS MATERIALIZED (
      SELECT id,CASE WHEN json_valid(canonical_json) THEN
        json_extract(canonical_json,'$.message_account_evidence.account_key') END AS account_key FROM selected
    ), route_accounts AS MATERIALIZED (
      SELECT account_key,MIN(id) AS selected_id FROM route_account_candidates
      WHERE typeof(account_key)='text' AND length(account_key)=64 AND account_key NOT GLOB '*[^a-f0-9]*'
      GROUP BY account_key ORDER BY selected_id DESC LIMIT ${ROUTE_ACCOUNTS}
    ), route_prefixes AS MATERIALIZED (
      SELECT account_key,(SELECT json_group_array(rowid) FROM (
        SELECT rowid FROM ${ROUTE_TABLE} r INDEXED BY ${ROUTE_INDEX}
        WHERE source_id='lark.im' AND r.account_key=a.account_key ORDER BY route_key LIMIT ${ROUTE_PER_ACCOUNT + 1}
      )) AS ids FROM route_accounts a
    ), route_ranked AS MATERIALIZED (
      SELECT p.account_key,j.value AS row_id,json_array_length(p.ids) AS route_count,
        ROW_NUMBER() OVER(ORDER BY p.account_key,j.key) AS payload_position FROM route_prefixes p,json_each(p.ids) j
    ), route_bounded AS MATERIALIZED (
      SELECT p.*,CASE WHEN typeof(r.route_key)='text' AND length(CAST(r.route_key AS BLOB))=64
        AND typeof(r.operation)='text' AND length(CAST(r.operation AS BLOB))<=32
        AND (r.failure_kind IS NULL OR typeof(r.failure_kind)='text' AND length(CAST(r.failure_kind AS BLOB))<=32)
        AND (r.failure_code IS NULL OR typeof(r.failure_code)='integer' AND r.failure_code BETWEEN 0 AND 9007199254740991)
        AND ${['failures','last_attempt_at_ms','retry_at_ms','blocked','generation'].map(key=>`typeof(r.${key})='integer' AND r.${key} BETWEEN 0 AND 9007199254740991`).join(' AND ')}
        THEN 1 ELSE 0 END AS serializable FROM route_ranked p JOIN ${ROUTE_TABLE} r ON r.rowid=p.row_id
    ), route_groups AS MATERIALIZED (
      SELECT account_key,MIN(CASE WHEN route_count<=${ROUTE_PER_ACCOUNT} AND payload_position<=${ROUTE_ROWS}
        AND serializable=1 THEN 1 ELSE 0 END) AS complete FROM route_bounded GROUP BY account_key
    ),` : '';
  const routeRows = routesAvailable ? rowQuery('nameRoute', ROUTE_COLUMNS,
    `SELECT ${ROUTE_COLUMNS.map(key=>`r.${key}`).join(',')} FROM route_bounded p JOIN ${ROUTE_TABLE} r ON r.rowid=p.row_id
      JOIN route_groups g ON g.account_key=p.account_key WHERE g.complete=1`, 'account_key,route_key') : null;
  const routeGroups = routesAvailable ? rowQuery('nameRouteGroup', ['account_key','complete'],
    'SELECT * FROM route_groups','account_key') : null;
  const dataBranches = [rowQuery('row', ROW_COLUMNS, 'SELECT * FROM selected', ordering),
    rowQuery('scope', SCOPE_COLUMNS, `SELECT s.id,s.source_id,s.config_json FROM sync_scopes s
      WHERE s.source_id='lark.im' AND CASE WHEN json_valid(s.config_json)
        THEN json_extract(s.config_json,'$.chat_id') END IN (SELECT container_id FROM containers)`, 'id'),
    names, recipients, observations, donorRows, donorGroups, routeRows, routeGroups].filter(Boolean).join('\nUNION ALL\n');
  const result = query(db, `WITH
    matched AS MATERIALIZED (
      SELECT r.id,r.occurred_at_ms,r.external_id FROM records r WHERE ${filters.join(' AND ')}
    ), selected_ids AS MATERIALIZED (
      SELECT id FROM matched ORDER BY ${ordering} LIMIT ${limit}
    ), selected AS MATERIALIZED (
      SELECT r.id,r.source_id,r.direction,r.record_type,r.occurred_at,r.occurred_at_ms,
        r.actor_id,r.container_id,r.external_id,r.external_version,r.content_hash,r.body,r.canonical_json,r.raw_json,
        s.config_json AS scope_config_json,s.id AS type_scope_id,s.source_id AS type_scope_source_id
      FROM selected_ids p JOIN records r ON r.id=p.id
      LEFT JOIN sync_scopes s ON s.id=r.first_seen_scope_id
    ), containers AS MATERIALIZED (
      SELECT DISTINCT container_id FROM selected WHERE typeof(container_id)='text' AND container_id<>''
    ), ${donorCtes} ${routeCtes} population AS MATERIALIZED (
      SELECT COUNT(*) AS total,(SELECT COUNT(*) FROM selected_ids) AS evaluated FROM matched
    ) SELECT 'metadata' AS kind,0 AS position,NULL AS payload,
      total,evaluated,total-evaluated AS not_evaluated,
      COALESCE((SELECT MAX(id) FROM records WHERE source_id='lark.im' AND record_type='lark.im.message'),0) AS source_max_record_id,
      strftime('%Y-%m-%dT%H:%M:%fZ','now') AS read_at,
      (${existsTable(NAME_TABLE)}=${Number(available.names)}
        AND ${existsTable(RECIPIENT_TABLE)}=${Number(available.recipients)}
        AND ${existsTable(OBSERVATION_TABLE)}=${Number(available.observations)}
        AND ${existsTable(ROUTE_TABLE)}=${Number(routeTable)} AND ${existsRouteIndex}=${Number(routeIndex)}
        AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name=${quote(DONOR_INDEX)})=${Number(donorIndex)}) AS schema_consistent
    FROM population
    UNION ALL
    ${dataBranches}
    ORDER BY kind,position;`, 'read message snapshot');
  if (!Array.isArray(result) || result.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw invalid();
  const metadata = result.filter(row => row.kind === 'metadata');
  if (metadata.length !== 1 || metadata[0].position !== 0 || metadata[0].payload !== null) throw invalid();
  const value = metadata[0];
  if (value.schema_consistent !== 1) throw invalid();
  /** @type {Record<string, Record<string,any>[]>} */
  const groups = { row: [], scope: [], nameTask: [], recipient: [], observation: [], senderDonor: [], senderDonorGroup: [],
    nameRoute: [], nameRouteGroup: [] };
  for (const item of result) {
    if (item.kind === 'metadata') continue;
    try {
      if (!Object.hasOwn(groups, item.kind) || typeof item.payload !== 'string'
        || item.position !== groups[item.kind].length + 1) throw invalid();
      const parsed = JSON.parse(item.payload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
      groups[item.kind].push(parsed);
    } catch { throw invalid(); }
  }
  const { row: rows, scope: scopes, nameTask: nameTasks, recipient: savedRecipients, observation: history } = groups;
  if (!['total', 'evaluated', 'not_evaluated', 'source_max_record_id'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.evaluated !== rows.length || value.evaluated > limit
    || value.total !== value.evaluated + value.not_evaluated
    || typeof value.read_at !== 'string' || !Number.isFinite(Date.parse(value.read_at))) throw invalid();
  const senderDonors = groups.senderDonorGroup.map(group => ({actor_id:group.actor_id,complete:group.complete===1,
    rows:groups.senderDonor.filter(row=>row.actor_id===group.actor_id)}));
  const nameRoutes = { available: routesAvailable, accounts: groups.nameRouteGroup.map(group => ({
    account_key: group.account_key, complete: group.complete === 1,
    rows: groups.nameRoute.filter(row => row.account_key === group.account_key) })) };
  return { rows, scopes, nameTasks, recipients: savedRecipients, available, senderDonors, nameRoutes,
    observations: selectMessageReadinessObservations(rows, history, Date.parse(value.read_at)),
    population: { total: value.total, evaluated: value.evaluated, not_evaluated: value.not_evaluated },
    as_of: { read_at: value.read_at, source_max_record_id: value.source_max_record_id } };
}

export { readMessageSnapshot };
