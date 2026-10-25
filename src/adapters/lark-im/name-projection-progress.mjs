import { REVIEW_RECORD_COLUMNS } from '../../../dist/storage/sqlite/ingestion-store.js';
import { nameRowBytesSql } from './name-work-common.mjs';

// Evidence freshness and record application are independent. An active sweep
// keeps its horizon even if newer messages arrive or its evidence is refreshed.
// Only a completed sweep can revisit skipped records from the beginning.
function nameProjectionState(task) {
  const horizon = Number(task.projection_horizon_record_id || task.latest_record_id);
  const complete = Number(task.after_record_id || 0) >= horizon;
  return {
    after: complete ? 0 : Number(task.after_record_id || 0),
    horizon: complete ? task.latest_record_id : horizon,
    capacityDeferred: !complete && Boolean(task.projection_deferred),
  };
}

// Only bounded row headers are inspected before reading payloads. Advance over
// an individually oversized row, but never over a row excluded by the remaining
// batch budget. That row is first in the next page, rather than silently lost.
function readNameRecordPage(query, { after, horizon, predicate, index, recordBytes = 2097152,
  batchBytes = 2097152, label }) {
  const headers = query(`SELECT id,(${nameRowBytesSql()}) AS bytes FROM records INDEXED BY ${index}
    WHERE ${predicate} AND id>${after} AND id<=${horizon} ORDER BY id LIMIT 20;`, `scan bounded ${label}`);
  const ids = [];
  let bytes = 0, nextAfter = after, capacityDeferred = false;
  for (const header of headers) {
    if (header.bytes > recordBytes) { capacityDeferred = true; nextAfter = header.id; continue; }
    if (bytes + header.bytes > batchBytes) break;
    bytes += header.bytes; ids.push(header.id); nextAfter = header.id;
  }
  if (!headers.length) nextAfter = horizon;
  // Recheck capacity in the payload read as well: a concurrent record change
  // must not turn a previously small header into an unbounded materialization.
  const rows = ids.length ? query(`WITH candidates AS MATERIALIZED (
      SELECT id,(${nameRowBytesSql()}) AS bytes FROM records WHERE id IN (${ids.join(',')})
    ), bounded AS MATERIALIZED (
      SELECT id,bytes,SUM(CASE WHEN bytes<=${recordBytes} THEN bytes ELSE 0 END) OVER(ORDER BY id) AS total FROM candidates)
    SELECT ${REVIEW_RECORD_COLUMNS.map(column=>`r.${column}`).join(',')} FROM bounded b JOIN records r ON r.id=b.id
      WHERE b.bytes<=${recordBytes} AND b.total<=${batchBytes} ORDER BY r.id;`, `read bounded ${label}`) : [];
  if (rows.length !== ids.length) capacityDeferred = true;
  return { rows, after: nextAfter, horizon, more: nextAfter < horizon, capacityDeferred };
}

function readNameProjectionPage(task, query, options) {
  const state = nameProjectionState(task);
  const page = readNameRecordPage(query, { ...options, after: state.after, horizon: state.horizon });
  return { ...page, capacityDeferred: state.capacityDeferred || page.capacityDeferred };
}

export { nameProjectionState, readNameRecordPage, readNameProjectionPage };
