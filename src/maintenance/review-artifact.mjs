// @ts-check
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readStableJsonFile } from '../diagnostics/private-json-file.mjs';
import { activityDatabaseKey } from '../diagnostics/lark-im-activity-evidence.mjs';
import { captureRemoteAccountBinding, readRemoteAccountBinding, readRemoteAccountBindingSidecar } from '../diagnostics/remote-account-binding.mjs';
import { readOnlySqliteJson } from '../storage/sqlite/readonly-query.mjs';
import { renderCardContent } from '../adapters/lark-im/card-content.mjs';
import { quoteSql, REVIEW_RECORD_COLUMNS, REVIEW_EFFECTIVE_COLUMNS } from '../../dist/storage/sqlite/ingestion-store.js';

const REVIEW_SCHEMA = 'exocortex_private_maintenance_review/v1';
const TEXT_REVIEW_SCHEMA = 'exocortex_private_maintenance_review/v2';
const TEXT_REVIEW_TYPES = new Set(['text', 'post', 'system', 'general_calendar', 'video_chat']);
const REVIEW_MAX_BYTES = 1024 * 1024;
const REVIEW_RECORD_BYTES = 256 * 1024;
const REVIEW_TOTAL_BYTES = 4 * 1024 * 1024;
const REVIEW_AGE_MS = 30 * 60 * 1000;
const SENDER_FIELDS = ['sender_id_type', 'sender_name', 'sender_name_state', 'sender_name_source', 'sender_name_confidence',
  'sender_name_resolution_status', 'sender_name_resolution_reason'];
const CANONICAL_FIELDS = ['msg_type', 'chat_id', 'chat_type', 'chat_name', 'chat_name_source', 'deleted', 'updated'];
const VISIBLE_FIELDS = ['source_id', 'first_seen_scope_id', 'external_id', 'external_version', 'record_type',
  'occurred_at', 'occurred_at_ms', 'actor_id', 'container_id', 'direction'];
const OPAQUE_FIELDS = ['title', 'body', 'canonical_json', 'raw_json', 'content_hash'];
const REVIEW_DISCLOSURE = { opaque_columns: OPAQUE_FIELDS,
  meaning: 'opaque_columns_are_digest_bound_not_fully_displayed',
  card_text: 'rendered_api_projection_not_the_stored_body_column_or_business_approval',
  omissions: 'interactive_values_and_url_credentials_are_intentionally_not_displayed' };
const TEXT_REVIEW_DISCLOSURE = { ...REVIEW_DISCLOSURE,
  non_card_text: 'exact_stored_title_and_body_not_client_state; private_text_is_not_redacted' };
const REASONS = new Set(['invalid_options', 'unsafe_path', 'invalid_file', 'approval_mismatch', 'expired', 'binding_unavailable',
  'binding_changed', 'snapshot_changed', 'proposal_changed', 'too_large', 'incomplete_card', 'no_changes', 'publish_failed']);
/** A finite local diagnostic; never expose file contents, IDs or filesystem errors. */
class MaintenanceReviewError extends Error {
  constructor(reason) { super(`maintenance review rejected: ${REASONS.has(reason) ? reason : 'invalid_file'}`); this.name = 'MaintenanceReviewError'; }
}
/** @param {string} reason @returns {never} */
function fail(reason) { throw new MaintenanceReviewError(reason); }
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.byteLength(value, 'utf8');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const equal = (a, b) => stable(a) === stable(b);
const digest = value => sha(stable(value));
const pick = (row, fields) => Object.fromEntries(fields.map(key => [key, row[key] ?? null]));
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const finite = value => Number.isSafeInteger(value) && value >= 0;
const scalar = value => value === null || typeof value === 'string' || Number.isFinite(value);

function reviewRequested(options) { return ['reviewOut', 'reviewIn', 'reviewSha256'].some(key => options[key] !== undefined); }
function validateReviewOptions(options, mode) {
  if (!reviewRequested(options)) return;
  const hasOut = options.reviewOut !== undefined, hasIn = options.reviewIn !== undefined, hasSha = options.reviewSha256 !== undefined;
  if (!['names', 'replay'].includes(mode) || options.unsafeDetails
    || mode === 'names' && (!options.namesOnly || !options.recordIds?.length)
    || mode === 'replay' && (!options.messageIds?.length || options.scopeIds?.length !== 1)
    || hasOut && (options.apply || hasIn || hasSha)
    || hasIn && (!options.apply || !hasSha || !hashValue(options.reviewSha256))
    || !hasOut && !hasIn || hasSha && !hasIn
    || !Number.isSafeInteger(options.maxCliAttempts) || options.maxCliAttempts < 1 || options.maxCliAttempts > 1000
    || !Number.isSafeInteger(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 180) fail('invalid_options');
  for (const path of [options.reviewOut, options.reviewIn].filter(path => path !== undefined)) if (typeof path !== 'string' || !path.trim()) fail('invalid_options');
}

function privatePath(path) {
  try {
    const target = resolve(path), parent = dirname(target), info = lstatSync(parent);
    if (realpathSync(parent) !== parent || !info.isDirectory() || info.isSymbolicLink()
      || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) fail('unsafe_path');
    return target;
  } catch { fail('unsafe_path'); }
}
function privateDestination(path) {
  const target = privatePath(path);
  try { lstatSync(target); fail('unsafe_path'); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') fail('unsafe_path');
  }
  return target;
}

function publish(path, artifact, { sync = fsyncSync } = {}) {
  const target = privateDestination(path);
  const output = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  if (output.length > REVIEW_MAX_BYTES) fail('too_large');
  const temporary = join(dirname(target), `.maintenance-review-${randomUUID()}.tmp`);
  let fd, identity, published = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    identity = fstatSync(fd);
    writeFileSync(fd, output); sync(fd); closeSync(fd); fd = undefined;
    linkSync(temporary, target); published = true; unlinkSync(temporary);
    const directory = openSync(dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { sync(directory); } finally { closeSync(directory); }
    return sha(output);
  } catch {
    if (published && identity) try {
      const current = lstatSync(target);
      if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(target);
    } catch { /* Never remove a replacement created by another process. */ }
    fail('publish_failed');
  }
  finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch { /* Own staging file only. */ } }
}

function validateArtifact(value, now) {
  const textReview = value?.schema === TEXT_REVIEW_SCHEMA;
  if (!exactKeys(value, ['schema', 'mode', 'created_at_ms', 'expires_at_ms', 'disclosure', 'binding', 'constraints', 'records'])
    || ![REVIEW_SCHEMA, TEXT_REVIEW_SCHEMA].includes(value.schema) || !['names', 'replay'].includes(value.mode)
    || textReview && value.mode !== 'replay'
    || !equal(value.disclosure, textReview ? TEXT_REVIEW_DISCLOSURE : REVIEW_DISCLOSURE)
    || !finite(value.created_at_ms) || value.expires_at_ms !== value.created_at_ms + REVIEW_AGE_MS) fail('invalid_file');
  if (now < value.created_at_ms || now >= value.expires_at_ms) fail('expired');
  if (!exactKeys(value.binding, ['database_key', 'source_id', 'source_config_sha256', 'baseline', 'local_account_key', 'scopes', 'verified_self_sha256'])
    || value.binding.source_id !== 'lark.im' || !hashValue(value.binding.database_key) || !hashValue(value.binding.source_config_sha256)
    || !hashValue(value.binding.local_account_key) || !finite(value.binding.baseline)
    || !(value.binding.verified_self_sha256 === null || hashValue(value.binding.verified_self_sha256))
    || !Array.isArray(value.binding.scopes) || value.binding.scopes.length > 100) fail('invalid_file');
  for (const scope of value.binding.scopes) if (!exactKeys(scope, ['id', 'source_id', 'enabled', 'config_sha256'])
    || typeof scope.id !== 'string' || scope.source_id !== 'lark.im' || ![0, 1].includes(scope.enabled) || !hashValue(scope.config_sha256)) fail('invalid_file');
  const c = value.constraints;
  if (!exactKeys(c, ['targets', 'scope_ids', 'start_ms', 'end_ms', 'max_cli_attempts', 'max_seconds'])
    || !Array.isArray(c.targets) || c.targets.length < 1 || c.targets.length > 100 || new Set(c.targets).size !== c.targets.length
    || c.targets.some(target => value.mode === 'names' ? !Number.isSafeInteger(target) || target < 1 : typeof target !== 'string' || !target || target.length > 512)
    || !Array.isArray(c.scope_ids) || (value.mode === 'names' ? c.scope_ids.length !== 0 || c.start_ms !== null || c.end_ms !== null
      : c.scope_ids.length !== 1 || typeof c.scope_ids[0] !== 'string' || !finite(c.start_ms) || !finite(c.end_ms) || c.end_ms <= c.start_ms)
    || !Number.isSafeInteger(c.max_cli_attempts) || c.max_cli_attempts < 1 || c.max_cli_attempts > 1000
    || !Number.isSafeInteger(c.max_seconds) || c.max_seconds < 1 || c.max_seconds > 180) fail('invalid_file');
  if (!Array.isArray(value.records) || value.records.length !== c.targets.length) fail('invalid_file');
  for (const record of value.records) {
    if (!exactKeys(record, ['id', 'external_id', 'outcome', 'exclusion', 'before_sha256', 'proposal_sha256', 'observed_sha256', 'changed_fields', 'display', 'opaque'])
      || !Number.isSafeInteger(record.id) || record.id < 1 || typeof record.external_id !== 'string'
      || !['update', 'duplicate', 'conflict', 'unchanged', 'excluded', 'unresolved'].includes(record.outcome)
      || ![null, 'system_message', 'explicitly_cleared', 'known_name', 'unverified_identity'].includes(record.exclusion)
      || !['before_sha256', 'proposal_sha256', 'observed_sha256'].every(key => hashValue(record[key]))
      || !Array.isArray(record.changed_fields) || record.changed_fields.some(key => !REVIEW_EFFECTIVE_COLUMNS.includes(key))
      || !exactKeys(record.display, ['before', 'after']) || !exactKeys(record.opaque, ['before', 'after', 'changed_fields'])
      || !Array.isArray(record.opaque.changed_fields) || record.opaque.changed_fields.some(field => !OPAQUE_FIELDS.includes(field))) fail('invalid_file');
    for (const side of ['before', 'after']) {
      const display = record.display[side];
      if (!exactKeys(display, ['fields', 'sender', 'canonical', 'card', ...(textReview ? ['non_card'] : [])]) || !exactKeys(display.fields, VISIBLE_FIELDS)
        || !Object.values(display.fields).every(scalar) || !exactKeys(display.sender, SENDER_FIELDS)
        || !exactKeys(display.canonical, CANONICAL_FIELDS)) fail('invalid_file');
      for (const [group, allowBoolean] of [[display.sender, false], [display.canonical, true]]) {
        for (const entry of Object.values(group)) if (!exactKeys(entry, ['present', 'value']) || typeof entry.present !== 'boolean'
          || !entry.present && entry.value !== null || !(entry.value === null || typeof entry.value === 'string' && bytes(entry.value) <= 1024
            || allowBoolean && typeof entry.value === 'boolean')) fail('invalid_file');
      }
      const nonCard = textReview && TEXT_REVIEW_TYPES.has(display.canonical.msg_type.value);
      if (nonCard) {
        if (display.card !== null || !exactKeys(display.non_card, ['title', 'body'])
          || !Object.values(display.non_card).every(text => text === null || typeof text === 'string' && bytes(text) <= REVIEW_RECORD_BYTES)) fail('invalid_file');
      } else {
        if (textReview && display.non_card !== null) fail('invalid_file');
        if (value.mode === 'names' ? display.card !== null : display.canonical.msg_type.value !== 'interactive'
          || !exactKeys(display.card, ['text', 'status', 'reason', 'version', 'omitted_actions'])
          || display.card.status !== 'rendered' || display.card.reason !== null || display.card.version !== 3
          || typeof display.card.text !== 'string' || !finite(display.card.omitted_actions)) fail('invalid_file');
      }
      if (!exactKeys(record.opaque[side], OPAQUE_FIELDS)) fail('invalid_file');
      for (const field of OPAQUE_FIELDS) if (!exactKeys(record.opaque[side][field], ['sha256', 'bytes'])
        || !hashValue(record.opaque[side][field].sha256) || !finite(record.opaque[side][field].bytes)) fail('invalid_file');
    }
  }
  if (textReview && !value.records.some(record => record.display.before.non_card !== null || record.display.after.non_card !== null)) fail('invalid_file');
  return value;
}

function readApproval(options, now) {
  const loaded = readStableJsonFile(privatePath(options.reviewIn), { maxBytes: REVIEW_MAX_BYTES });
  if (loaded.status !== 'ready') fail('invalid_file');
  if (loaded.sha256 !== options.reviewSha256) fail('approval_mismatch');
  return validateArtifact(loaded.value, now);
}

function captureBinding(db, scopes) {
  try {
    const databaseKey = activityDatabaseKey(db);
    const source = readOnlySqliteJson(db, "SELECT enabled,config_json FROM sources WHERE id='lark.im';", 'read maintenance review source')[0];
    const baseline = JSON.parse(source?.config_json).initial_sync_start_ms;
    if (!databaseKey || source?.enabled !== 1 || !Number.isSafeInteger(baseline) || baseline < 100_000_000_000) fail('binding_unavailable');
    const captured = captureRemoteAccountBinding({ db });
    if (!captured || captured.conflict || captured.database_key !== databaseKey) fail('binding_unavailable');
    const sidecar = readRemoteAccountBindingSidecar(db, Date.now());
    let accountKey = captured.initial_account?.confirmed_at ? captured.initial_account.account_key : null;
    if (captured.sent_actor) {
      const admission = /** @type {Record<string,any>} */ (readRemoteAccountBinding({ db, selfOpenId: captured.sent_actor }));
      if (admission.state !== 'verified' || accountKey && admission.account_key !== accountKey) fail('binding_unavailable');
      accountKey = admission.account_key;
    }
    if (sidecar) {
      if (sidecar.database_key !== databaseKey || accountKey && sidecar.account_key !== accountKey) fail('binding_unavailable');
      accountKey ||= sidecar.account_key;
    }
    if (!hashValue(accountKey) || captured.initial_account && captured.initial_account.account_key !== accountKey) fail('binding_unavailable');
    const actualScopes = scopes.length ? readOnlySqliteJson(db, `SELECT id,source_id,enabled,config_json FROM sync_scopes WHERE id IN (${scopes.map(s => quoteSql(s.id)).join(',')});`, 'read maintenance review scopes') : [];
    if (actualScopes.length !== scopes.length || !equal([...actualScopes].sort((a,b) => a.id.localeCompare(b.id)), [...scopes].sort((a,b) => a.id.localeCompare(b.id)))) fail('binding_changed');
    if (activityDatabaseKey(db) !== databaseKey) fail('binding_changed');
    return { sourceConfigJson: source.config_json, sentActor: captured.sent_actor || null, binding: { database_key: databaseKey, source_id: 'lark.im',
      source_config_sha256: sha(source.config_json), baseline, local_account_key: accountKey,
      scopes: [...scopes].sort((a,b) => a.id.localeCompare(b.id)).map(s => ({ id:s.id, source_id:s.source_id, enabled:s.enabled, config_sha256:sha(s.config_json) })),
      verified_self_sha256: null } };
  } catch (error) { if (error instanceof MaintenanceReviewError) throw error; fail('binding_unavailable'); }
}

function recordSnapshot(row) {
  if (REVIEW_RECORD_COLUMNS.some(key => !Object.hasOwn(row, key))) fail('snapshot_changed');
  return pick(row, REVIEW_RECORD_COLUMNS);
}
function effectiveRecord(row) { return pick(row, REVIEW_EFFECTIVE_COLUMNS); }
function constraints(options, mode) {
  return { targets: [...(mode === 'names' ? options.recordIds : options.messageIds)].sort((a,b) => String(a).localeCompare(String(b))),
    scope_ids: mode === 'replay' ? [...options.scopeIds] : [], start_ms: mode === 'replay' ? options.startMs : null,
    end_ms: mode === 'replay' ? options.endMs : null, max_cli_attempts: options.maxCliAttempts, max_seconds: options.maxSeconds };
}

/** All content is an internally computed projection; nothing from the input
 * artifact is used as SQL, a filename, an API parameter or a proposed value.
 * @param {Record<string,any>} options
 * @param {{db:string,mode:string,rows:Record<string,any>[],scopes?:Array<{id:string,source_id:string,enabled:number,config_json:string}>,now?:()=>number}} context */
function beginMaintenanceReview(options, { db, mode, rows, scopes = [], now = Date.now }) {
  if (!reviewRequested(options)) return null;
  validateReviewOptions(options, mode);
  const approval = options.reviewIn ? readApproval(options, now()) : null;
  if (options.reviewOut) privateDestination(options.reviewOut);
  const snapshots = rows.map(recordSnapshot).sort((a,b) => a.id - b.id);
  if (!snapshots.length || snapshots.length > 100 || new Set(snapshots.map(r => r.id)).size !== snapshots.length) fail('snapshot_changed');
  const sizes = snapshots.map(row => bytes(stable(row)));
  if (sizes.some(size => size > REVIEW_RECORD_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > REVIEW_TOTAL_BYTES) fail('too_large');
  const control = captureBinding(db, scopes);
  const selection = constraints(options, mode);
  if (approval) {
    if (approval.mode !== mode || !equal(approval.constraints, selection)) fail('approval_mismatch');
    const oldBinding = { ...approval.binding, verified_self_sha256: null };
    if (!equal(oldBinding, control.binding)) fail('binding_changed');
    const old = new Map(approval.records.map(row => [row.id, row]));
    if (snapshots.some(row => old.get(row.id)?.before_sha256 !== digest(row)) || old.size !== snapshots.length) fail('snapshot_changed');
  }
  let self = null;
  function verifySelf(value) {
    if (mode !== 'replay' || !hashValue(value)) fail('binding_unavailable');
    if (approval && approval.binding.verified_self_sha256 !== value) fail('binding_changed');
    self = value;
  }
  function finish(decisions) {
    if (mode === 'replay' && !self) fail('binding_unavailable');
    const current = readOnlySqliteJson(db, `SELECT * FROM records WHERE id IN (${snapshots.map(row => row.id).join(',')});`, 'recheck review snapshot')
      .map(recordSnapshot).sort((a,b) => a.id - b.id);
    if (!equal(current, snapshots)) fail('snapshot_changed');
    const fresh = captureBinding(db, scopes);
    if (!equal(fresh.binding, control.binding)) fail('binding_changed');
    let total = 0;
    const entries = decisions.map(({ before, after, observed = after, outcome, exclusion = null }) => {
      const original = recordSnapshot(before), effective = effectiveRecord(after);
      const size = bytes(stable(original)) + bytes(stable(effective)) + (mode === 'replay' ? bytes(stable(effectiveRecord(observed))) : 0);
      total += size;
      if (size > REVIEW_RECORD_BYTES || total > REVIEW_TOTAL_BYTES) fail('too_large');
      const display = row => {
        let canonical; try { canonical = JSON.parse(row.canonical_json ?? '{}') ?? {}; } catch { fail('invalid_file'); }
        if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) fail('invalid_file');
        const projection = (fields, allowBoolean = false) => Object.fromEntries(fields.map(key => {
          const present = Object.hasOwn(canonical, key), value = present ? canonical[key] : null;
          if (!(value === null || typeof value === 'string' && bytes(value) <= 1024 || allowBoolean && typeof value === 'boolean')) fail('too_large');
          return [key, { present, value }];
        }));
        const sender = projection(SENDER_FIELDS);
        let card = null, nonCard = null;
        if (mode === 'replay' && TEXT_REVIEW_TYPES.has(canonical.msg_type)) {
          let raw; try { raw = JSON.parse(row.raw_json); } catch { fail('invalid_file'); }
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_file');
          const native = raw.raw_api && typeof raw.raw_api === 'object' ? raw.raw_api : raw;
          if ((native.msg_type || native.message_type) !== canonical.msg_type) fail('invalid_file');
          nonCard = pick(row, ['title', 'body']);
          if (!Object.values(nonCard).every(text => text === null || typeof text === 'string')) fail('invalid_file');
        } else if (mode === 'replay') {
          let raw; try { raw = JSON.parse(row.raw_json); } catch { fail('incomplete_card'); }
          const native = raw.raw_api && typeof raw.raw_api === 'object' ? raw.raw_api : raw;
          if (canonical.msg_type !== 'interactive') fail('incomplete_card');
          const rendered = renderCardContent(native.body?.content ?? native.content, native.mentions);
          if (rendered.status !== 'rendered') fail('incomplete_card');
          card = { text: rendered.text, status: rendered.status, reason: rendered.reason, version: rendered.version, omitted_actions: rendered.omitted_actions || 0 };
        }
        return { fields: pick(row, VISIBLE_FIELDS), sender, canonical: projection(CANONICAL_FIELDS, true), card,
          ...(nonCard ? { non_card: nonCard } : {}) };
      };
      const opaque = row => Object.fromEntries(OPAQUE_FIELDS.map(key => {
        const text = typeof row[key] === 'string' ? row[key] : JSON.stringify(row[key] ?? null);
        return [key, { sha256: sha(text), bytes: bytes(text) }];
      }));
      return { id: original.id, external_id: original.external_id, outcome, exclusion,
        before_sha256: digest(original), proposal_sha256: digest(effective), observed_sha256: digest(effectiveRecord(observed)),
        changed_fields: REVIEW_EFFECTIVE_COLUMNS.filter(key => !equal(original[key] ?? null, effective[key])),
        display: { before: display(original), after: display(effective) }, opaque: { before: opaque(original), after: opaque(effective),
          changed_fields: OPAQUE_FIELDS.filter(key => !equal(original[key] ?? null, effective[key])) } };
    }).sort((a,b) => a.id - b.id);
    if (entries.length !== snapshots.length || entries.some((entry,i) => entry.id !== snapshots[i].id || entry.before_sha256 !== digest(snapshots[i]))) fail('snapshot_changed');
    const textReview = entries.some(entry => entry.display.before.non_card || entry.display.after.non_card);
    if (textReview) for (const entry of entries) for (const side of ['before', 'after']) entry.display[side].non_card ??= null;
    const binding = { ...control.binding, verified_self_sha256: self };
    const created = approval?.created_at_ms ?? now();
    const artifact = { schema: textReview ? TEXT_REVIEW_SCHEMA : REVIEW_SCHEMA, mode, created_at_ms: created, expires_at_ms: created + REVIEW_AGE_MS,
      disclosure: textReview ? TEXT_REVIEW_DISCLOSURE : REVIEW_DISCLOSURE,
      binding, constraints: selection, records: entries };
    validateArtifact(artifact, now());
    if (bytes(`${JSON.stringify(artifact, null, 2)}\n`) > REVIEW_MAX_BYTES) fail('too_large');
    const changes = entries.filter(entry => entry.outcome === 'update').length;
    if (approval) {
      if (!equal(approval, artifact)) fail('proposal_changed');
      if (!changes) fail('no_changes');
    }
    const hash = approval ? options.reviewSha256 : publish(options.reviewOut, artifact);
    const assertBinding = () => {
      validateArtifact(artifact, Date.now());
      const latest = captureBinding(db, scopes);
      if (!equal(latest.binding, control.binding)) fail('binding_changed');
    };
    return { summary: { schema: artifact.schema, sha256: hash, records: entries.length, changes, expires_at_ms: artifact.expires_at_ms,
      raw_policy: 'opaque_digest_only', card_policy: 'api_snapshot_not_business_approval' },
      assertBinding: approval ? assertBinding : undefined,
      fence: approval ? { createdAtMs: artifact.created_at_ms, expiresAtMs: artifact.expires_at_ms,
        sourceConfigJson: control.sourceConfigJson, sentActor: fresh.sentActor, records: snapshots, scopes } : undefined };
  }
  return { finish, verifySelf };
}

export { beginMaintenanceReview, validateReviewOptions, reviewRequested, MaintenanceReviewError, recordSnapshot,
  effectiveRecord, publish as publishReviewArtifact, REVIEW_SCHEMA, REVIEW_MAX_BYTES, REVIEW_RECORD_BYTES, REVIEW_TOTAL_BYTES, REVIEW_AGE_MS };
