// @ts-check
import { REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
import { nameRowBytesSql } from './name-work-common.mjs';

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const INDEXES = new Set(['records_recipient_sent_id', 'records_recipient_sent_container_id']);
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Read one bounded page of sent witnesses, not recipient identity evidence.
 * `where` is an internal, trusted SQL suffix (with quoted values), never a CLI
 * predicate. The caller wraps query in its one shared monotonic deadline.
 *
 * At most limit + 1 small id/byte headers establish the page and lookahead.
 * A second statement rechecks source eligibility and current byte lengths in
 * one SQLite snapshot. CASE projects complete original columns only while an
 * individual row is <= 2 MiB and its ordered prefix fits batchBytes <= 2 MiB.
 * Oversized rows count as capacityDeferred and may advance the cursor; they
 * never become fabricated/partial rows. The first ordinary row that cannot fit
 * stops the cursor, including if it grew between the two statements. Later
 * ordinary rows cannot leapfrog it. A deleted/no-longer-matching row may be
 * passed, with no witness returned. Every returned row still needs the caller's
 * identity validation and exact commit fence.
 *
 * after=0 starts either ordering; a positive after means id>after for ASC and
 * id<after for DESC. afterRecordId is the last consumed header, not MAX(id).
 * Empty headers preserve after and return hasMore=false/exhaustedBudget=false;
 * budget blocking returns hasMore=true/exhaustedBudget=true. bytesRead counts
 * original SQL column bytes, not JSON wire escaping or fixed header overhead.
 * No cursor or database mutation occurs here.
 * @param {(sql:string,label:string)=>Record<string,any>[]} query
 * @param {{where?:string,order:'ASC'|'DESC',limit:number,index:string,after?:number,batchBytes:number}} options
 */
function readRecipientWitnessPage(query, { where = '', order, limit, index, after = 0, batchBytes }) {
  if (typeof query !== 'function' || typeof where !== 'string' || where.includes('\0')
    || !['ASC', 'DESC'].includes(order) || !Number.isSafeInteger(limit) || limit < 1 || limit > 40
    || !INDEXES.has(index) || !integer(after) || !integer(batchBytes) || batchBytes > MAX_RECORD_BYTES) {
    throw new TypeError('invalid recipient discovery page');
  }
  const predicate = `source_id='lark.im' AND direction='sent' AND record_type='lark.im.message'
    ${where} ${after ? `AND id${order === 'ASC' ? '>' : '<'}${after}` : ''}`;
  const headers = query(`SELECT id,(${nameRowBytesSql()}) AS bytes FROM records INDEXED BY ${index}
    WHERE ${predicate} ORDER BY id ${order} LIMIT ${limit + 1};`, 'read recipient witness headers');
  let previous = after;
  if (!Array.isArray(headers) || headers.length > limit + 1 || headers.some(header => {
    if (!header || !integer(header.id) || header.id === 0 || !integer(header.bytes)
      || previous > 0 && (order === 'ASC' ? header.id <= previous : header.id >= previous)) return true;
    previous = header.id;
    return false;
  })) throw new Error('invalid recipient witness headers');
  const result = { rows: /** @type {Record<string,any>[]} */ ([]), afterRecordId: after,
    hasMore: headers.length > limit, capacityDeferred: 0, bytesRead: 0, exhaustedBudget: false };
  if (!headers.length) return result;
  const page = headers.slice(0, limit), ids = page.map(header => header.id);
  const fits = `b.bytes<=${MAX_RECORD_BYTES} AND b.total<=${batchBytes}`;
  const payloads = query(`WITH current AS MATERIALIZED (
      SELECT id,(${nameRowBytesSql()}) AS bytes FROM records WHERE id IN (${ids.join(',')}) AND ${predicate}
    ), bounded AS MATERIALIZED (
      SELECT id,bytes,SUM(CASE WHEN bytes<=${MAX_RECORD_BYTES} THEN bytes ELSE 0 END)
        OVER(ORDER BY id ${order}) AS total FROM current)
    SELECT b.id AS __recipient_id,b.bytes AS __recipient_bytes,
      CASE WHEN ${fits} THEN 1 ELSE 0 END AS __recipient_payload_ok,
      ${REVIEW_RECORD_COLUMNS.map(column => `CASE WHEN ${fits} THEN r.${column} ELSE NULL END AS ${column}`).join(',')}
    FROM bounded b JOIN records r ON r.id=b.id ORDER BY b.id ${order};`, 'read bounded recipient witness payloads');
  const byId = new Map();
  if (!Array.isArray(payloads) || payloads.length > page.length) throw new Error('invalid recipient witness payloads');
  for (const item of payloads) {
    if (!item || !ids.includes(item.__recipient_id) || byId.has(item.__recipient_id)
      || !integer(item.__recipient_bytes) || ![0, 1].includes(item.__recipient_payload_ok)) {
      throw new Error('invalid recipient witness payloads');
    }
    byId.set(item.__recipient_id, item);
  }
  for (const header of page) {
    const item = byId.get(header.id);
    if (item) {
      if (item.__recipient_bytes > MAX_RECORD_BYTES) result.capacityDeferred += 1;
      else if (!item.__recipient_payload_ok) {
        result.hasMore = true;
        result.exhaustedBudget = true;
        break;
      } else {
        if (item.id !== header.id || !REVIEW_RECORD_COLUMNS.every(column => Object.hasOwn(item, column))
          || result.bytesRead + item.__recipient_bytes > batchBytes) throw new Error('invalid recipient witness payload');
        result.rows.push(Object.fromEntries(REVIEW_RECORD_COLUMNS.map(column => [column, item[column]])));
        result.bytesRead += item.__recipient_bytes;
      }
    }
    result.afterRecordId = header.id;
  }
  return result;
}

export { readRecipientWitnessPage };
