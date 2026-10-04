"""Check retained Lark IM run coverage from the persisted source baseline.

No project helpers, recovery, source calls, message reads, business-data writes,
or permission changes. SQLite may update WAL shared-memory reader coordination.
Completion proves retained successful-run coverage, not remote completeness.
"""
import argparse
import datetime
import json
import math
import re
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
UTC = datetime.timezone.utc
MINUTE_MS = 60_000
# Match the store's modern epoch-millisecond contract; never guess seconds.
MIN_EPOCH_MS = 100_000_000_000
MAX_EPOCH_MS = 253_402_300_799_999
MAX_SAFE_INTEGER = 9_007_199_254_740_991
ISO_WITH_ZONE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$'
)
SENT_ID = 'lark.im.sent_by_me'
RECEIVED_PREFIX = 'lark.im.received.chat.'
DISCOVERY_ID = 'lark.im.unmuted_chat_discovery'


def parse_json(value):
    try:
        return json.loads(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def integer_ms(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not 0 <= value <= MAX_SAFE_INTEGER or not math.isfinite(value) or value != int(value):
        return None
    return int(value)


def iso_ms(value):
    if not isinstance(value, str) or not ISO_WITH_ZONE.fullmatch(value):
        return None
    if not value.endswith('Z'):
        # fromisoformat normalizes e.g. +08:60; reject that invalid offset.
        if int(value[-5:-3]) > 23 or int(value[-2:]) > 59:
            return None
    try:
        # Python 3.9 accepts exactly 3 or 6 fractional digits, so normalize
        # valid ISO tenths/hundredths to milliseconds before parsing.
        normalized = re.sub(r'\.(\d{1,2})(?=Z|[+-])',
                            lambda match: '.' + match.group(1).ljust(3, '0'), value)
        stamp = datetime.datetime.fromisoformat(normalized.replace('Z', '+00:00'))
        if stamp.tzinfo is None or stamp.utcoffset() is None or stamp.microsecond % 1000:
            return None
        delta = stamp.astimezone(UTC) - datetime.datetime(1970, 1, 1, tzinfo=UTC)
        # Integer arithmetic avoids floating-point rounding of milliseconds.
        value_ms = delta.days * 86_400_000 + delta.seconds * 1000 + delta.microseconds // 1000
        return integer_ms(value_ms) if 0 <= value_ms <= MAX_EPOCH_MS else None
    except (ValueError, TypeError, OverflowError):
        return None


def utc_text(value):
    try:
        return (datetime.datetime(1970, 1, 1, tzinfo=UTC) + datetime.timedelta(milliseconds=value)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def cursor_ms(value):
    cursor = parse_json(value)
    if not isinstance(cursor, dict) or cursor.get('kind') != 'time_message_cursor/v1':
        return None
    return integer_ms(cursor.get('created_at_ms'))


def unsupported_class(reason):
    if reason == 'restricted_mode':
        return 'restricted_mode'
    if reason in ('out_of_chat', 'bot_user_out_of_chat'):
        return 'out_of_chat'
    return 'ordinary' if reason is None else 'other_unsupported'


def successful_interval(run):
    """Validate actual completed window against its before/after cursors.

    A null before is valid for the initial scan. The runner starts at before;
    its minute after is floor(actual window_end), never the requested end.
    Count only this conservative committed prefix.
    """
    if run['status'] != 'succeeded':
        return None, 'not_succeeded'
    if run['skipped'] == 1:
        return None, 'skipped'
    if run['window_complete'] == 0 or run['details_complete'] == 0 or run['list_complete'] == 0:
        return None, 'incomplete_window'
    if run['coverage_mode'] == 'list_checkpoint_and_details':
        if (run['list_complete_type'] != 'true' or run['details_complete_type'] != 'true'
                or run['pending_detail_count_type'] != 'integer' or run['pending_detail_count'] != 0):
            return None, 'invalid_detail_closure'
        if (integer_ms(run['window_start_ms']) != iso_ms(run['window_start'])
                or integer_ms(run['window_end_ms']) != iso_ms(run['window_end'])):
            return None, 'invalid_detail_closure'
    elif run['coverage_mode'] is not None:
        return None, 'unsupported_coverage_mode'
    elif (run['list_complete_type'] is not None or run['details_complete_type'] is not None
          or run['list_window_start_type'] is not None or run['list_window_end_type'] is not None):
        return None, 'list_only_window'
    start = iso_ms(run['window_start'])
    end = iso_ms(run['window_end'])
    if start is None or end is None or end < start:
        return None, 'invalid_window'
    after = cursor_ms(run['cursor_after_json'])
    if after is None or after != (end // MINUTE_MS) * MINUTE_MS:
        return None, 'invalid_cursor_after'
    before_raw = run['cursor_before_json']
    initial = before_raw is None or before_raw.strip() == 'null'
    before = None if initial else cursor_ms(before_raw)
    if not initial and (before is None or before != start or after < before):
        return None, 'invalid_cursor_before'
    if after < start:
        return None, 'invalid_cursor_after'
    return (start, min(end, after)), None


def detail_progress(con, target_ms):
    """Separate list checkpoints from unresolved detail debt in this snapshot.

    Legacy databases have no detail ledger. A partially present/new unreadable
    schema is an inspection failure, never an empty backlog.
    """
    tables = {row['name'] for row in con.execute("""
        SELECT name FROM sqlite_schema WHERE type='table'
          AND name IN ('lark_im_list_progress','lark_im_detail_tasks','schema_migrations')
    """)}
    migrated = ('schema_migrations' in tables and con.execute(
        "SELECT 1 FROM schema_migrations WHERE version='009'").fetchone() is not None)
    tables.discard('schema_migrations')
    if not tables and not migrated:
        return ({'evidence': 'legacy_unavailable', 'pending_count': None,
                 'due_count': None, 'scopes_pending': None,
                 'pending_at_or_before_target': None, 'oldest_pending_ms': None,
                 'next_retry_at': None},
                {'evidence': 'legacy_unavailable', 'scopes': None,
                 'at_target': None, 'invalid_cursor_scopes': None, 'oldest_cursor_ms': None})
    if len(tables) != 2:
        raise ValueError('incomplete message detail progress schema')
    enabled = """s.source_id='lark.im' AND s.enabled=1
        AND (s.id='lark.im.sent_by_me' OR s.id LIKE 'lark.im.received.chat.%')"""
    pending = list(con.execute(f"""
        SELECT t.occurred_at_ms,t.retry_at FROM lark_im_detail_tasks t
        JOIN sync_scopes s ON s.id=t.scope_id WHERE {enabled} AND t.status='pending'
    """))
    times = [integer_ms(row['occurred_at_ms']) for row in pending]
    retries = [iso_ms(row['retry_at']) for row in pending]
    if any(value is None for value in times + retries):
        raise ValueError('invalid pending message detail evidence')
    pending_scopes = con.execute(f"""
        SELECT COUNT(DISTINCT t.scope_id) FROM lark_im_detail_tasks t
        JOIN sync_scopes s ON s.id=t.scope_id WHERE {enabled} AND t.status='pending'
    """).fetchone()[0]
    now_ms = int(datetime.datetime.now(UTC).timestamp() * 1000)
    cursors = [cursor_ms(row['cursor_json']) for row in con.execute(f"""
        SELECT p.cursor_json FROM lark_im_list_progress p
        JOIN sync_scopes s ON s.id=p.scope_id WHERE {enabled}
    """)]
    valid_cursors = [value for value in cursors if value is not None]
    return ({'evidence': 'available', 'pending_count': len(pending),
             'due_count': sum(value <= now_ms for value in retries),
             'scopes_pending': pending_scopes,
             'pending_at_or_before_target': sum(value <= target_ms for value in times),
             'oldest_pending_ms': min(times) if times else None,
             'next_retry_at': utc_text(min(retries)) if retries else None},
            {'evidence': 'available', 'scopes': len(cursors),
             'at_target': sum(value >= target_ms for value in valid_cursors),
             'invalid_cursor_scopes': len(cursors) - len(valid_cursors),
             'oldest_cursor_ms': min(valid_cursors) if valid_cursors else None})


def interval_coverage(intervals, start, target):
    """Union intervals; overlap/replay cannot fill an unobserved gap."""
    if start is None or target is None or target <= start:
        raise ValueError("target must be strictly after the persisted baseline")
    clipped = sorted((max(start, left), min(target, right))
                     for left, right in intervals if left < target and right > start)
    merged = []
    for left, right in clipped:
        if right <= left:
            continue
        if merged and left <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], right)
        else:
            merged.append([left, right])
    missing_start = not merged or merged[0][0] > start
    missing_end = not merged or merged[-1][1] < target
    covered_ms = sum(right - left for left, right in merged)
    return {
        'complete': not missing_start and not missing_end and len(merged) == 1,
        'missing_start': missing_start,
        'missing_end': missing_end,
        'internal_gaps': max(0, len(merged) - 1),
        'covered_ms': covered_ms,
        'missing_ms': target - start - covered_ms,
        'contiguous_end_ms': start if missing_start else merged[0][1],
    }


def inspect_connection(con, target_ms):
    """Read one caller-owned snapshot and return aggregates, never scope IDs."""
    if integer_ms(target_ms) is None or target_ms > MAX_EPOCH_MS:
        raise ValueError("invalid target timestamp")
    source = con.execute("""
        SELECT enabled, json_valid(config_json) AS config_valid,
          json_type(CASE WHEN json_valid(config_json) THEN config_json ELSE 'null' END) AS config_type,
          json_type(CASE WHEN json_valid(config_json) THEN config_json ELSE '{}' END,
                    '$.initial_sync_start_ms') AS baseline_type,
          json_extract(CASE WHEN json_valid(config_json) THEN config_json ELSE '{}' END,
                       '$.initial_sync_start_ms') AS baseline_ms
        FROM sources WHERE id='lark.im'
    """).fetchone()
    baseline_ms = integer_ms(source['baseline_ms']) if source else None
    if source is None:
        baseline_status = 'source_missing'
    elif source['enabled'] != 1:
        baseline_status = 'source_disabled'
    elif not source['config_valid'] or source['config_type'] != 'object':
        baseline_status = 'invalid_source_config'
    elif source['baseline_type'] is None:
        baseline_status = 'initial_sync_start_missing'
    elif (source['baseline_type'] not in ('integer', 'real') or baseline_ms is None
          or not MIN_EPOCH_MS <= baseline_ms <= MAX_EPOCH_MS):
        baseline_status = 'initial_sync_start_invalid'
    else:
        baseline_status = 'ok'
    start_ms = baseline_ms if (baseline_ms is not None and MIN_EPOCH_MS <= baseline_ms <= MAX_EPOCH_MS
                              and source['baseline_type'] in ('integer', 'real')) else None
    range_status = ('baseline_unavailable' if start_ms is None else
                    'target_not_after_baseline' if target_ms <= start_ms else 'ok')
    range_valid = range_status == 'ok'
    detail_state, list_progress = detail_progress(con, target_ms)

    scopes = [dict(row) for row in con.execute("""
        SELECT id, enabled, cursor_json,
          json_extract(CASE WHEN json_valid(config_json) THEN config_json ELSE '{}' END,
                       '$.unsupported_reason') AS unsupported_reason
        FROM sync_scopes WHERE source_id='lark.im'
          AND (id='lark.im.sent_by_me' OR id LIKE 'lark.im.received.chat.%')
    """)]
    enabled = {row['id']: row for row in scopes if row['enabled'] == 1}
    received = [row for row in enabled.values() if row['id'].startswith(RECEIVED_PREFIX)]
    sent = enabled.get(SENT_ID)
    received_cursors = [cursor_ms(row['cursor_json']) for row in received]
    valid_received_cursors = [value for value in received_cursors if value is not None]
    sent_cursor = cursor_ms(sent['cursor_json']) if sent else None
    sent_at_target = sent_cursor is not None and sent_cursor >= target_ms

    discovery = []
    discovery_done = False
    for row in con.execute("""
        SELECT id, cursor_json FROM sync_scopes WHERE source_id='lark.im'
          AND id IN ('lark.im.unmuted_chat_discovery','lark.im.unmuted_chat_reconcile')
    """):
        cursor = parse_json(row['cursor_json'])
        cursor = cursor if isinstance(cursor, dict) else {}
        completed = iso_ms(cursor.get('completed_at'))
        if row['id'] == DISCOVERY_ID:
            discovery_done = (cursor.get('kind') == 'chat_discovery_cursor/v1'
                              and cursor.get('has_more') is False and completed is not None)
        discovery.append({
            'lane': 'initial' if row['id'] == DISCOVERY_ID else 'reconcile',
            'pages_scanned': integer_ms(cursor.get('pages_scanned')),
            'has_more': int(cursor['has_more']) if isinstance(cursor.get('has_more'), bool) else None,
            'completed_at': utc_text(completed),
        })

    intervals = {key: [] for key in enabled}
    valid_run_counts = {key: 0 for key in enabled}
    invalid_run_counts = {key: 0 for key in enabled}
    evidence_counts = {'eligible_successful_runs': 0, 'invalid_successful_runs': 0,
                       'skipped_successful_runs': 0, 'non_succeeded_runs_ignored': 0}
    invalid_reasons = {}
    # Read evidence/state only, not message contents or full metadata.
    for run in con.execute("""
        SELECT r.scope_id, r.status, r.cursor_before_json, r.cursor_after_json,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.window_start') AS window_start,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.window_end') AS window_end,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.window_start_ms') AS window_start_ms,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.window_end_ms') AS window_end_ms,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.window_complete') AS window_complete,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.coverage_mode') AS coverage_mode,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.list_complete') AS list_complete,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.details_complete') AS details_complete,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.pending_detail_count') AS pending_detail_count,
          json_type(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.list_complete') AS list_complete_type,
          json_type(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.details_complete') AS details_complete_type,
          json_type(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.pending_detail_count') AS pending_detail_count_type,
          json_type(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.list_window_start_ms') AS list_window_start_type,
          json_type(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.list_window_end_ms') AS list_window_end_type,
          json_extract(CASE WHEN json_valid(r.metadata_json) THEN r.metadata_json ELSE '{}' END,
                       '$.skipped') AS skipped
        FROM sync_runs r JOIN sync_scopes s ON s.id=r.scope_id AND s.source_id=r.source_id
        WHERE r.source_id='lark.im' AND s.enabled=1
          AND (s.id='lark.im.sent_by_me' OR s.id LIKE 'lark.im.received.chat.%')
    """):
        interval, reason = successful_interval(run)
        if (reason is None and run['coverage_mode'] == 'list_checkpoint_and_details'
                and detail_state['evidence'] != 'available'):
            interval, reason = None, 'detail_evidence_unavailable'
        if reason == 'not_succeeded':
            evidence_counts['non_succeeded_runs_ignored'] += 1
        elif reason == 'skipped':
            evidence_counts['skipped_successful_runs'] += 1
        elif reason:
            evidence_counts['invalid_successful_runs'] += 1
            invalid_run_counts[run['scope_id']] += 1
            invalid_reasons[reason] = invalid_reasons.get(reason, 0) + 1
        else:
            evidence_counts['eligible_successful_runs'] += 1
            valid_run_counts[run['scope_id']] += 1
            intervals[run['scope_id']].append(interval)

    details = {key: interval_coverage(value, start_ms, target_ms)
               for key, value in intervals.items()} if range_valid else {}
    complete_scopes = sum(item['complete'] for item in details.values())
    endpoints_at_target = (discovery_done and all(value is not None and value >= target_ms
                                                for value in received_cursors) and sent_at_target)
    coverage_complete = (baseline_status == 'ok' and range_valid and sent is not None
                         and complete_scopes == len(enabled))
    details_clear = detail_state['pending_at_or_before_target'] in (None, 0)
    strict_complete = bool(endpoints_at_target and coverage_complete and details_clear)
    progress = {
        'target_ms': target_ms,
        'initial_discovery_done': int(discovery_done),
        'enabled_received': len(received),
        'missing_or_invalid_cursor': len(received_cursors) - len(valid_received_cursors),
        'behind_fixed_target': sum(value < target_ms for value in valid_received_cursors),
        'oldest_received_cursor_utc': utc_text(min(valid_received_cursors)) if valid_received_cursors else None,
        'sent_at_target': int(sent_at_target),
        'cursor_endpoints_at_target': int(endpoints_at_target),
        'initial_baseline_at_target': int(strict_complete),
    }
    classes = {}
    disabled = {'message_scopes': 0, 'sent': 0, 'received': 0, 'unsupported': 0, 'other': 0}
    for scope in scopes:
        reason = unsupported_class(scope['unsupported_reason'])
        if scope['id'].startswith(RECEIVED_PREFIX):
            key = (scope['enabled'], reason)
            classes[key] = classes.get(key, 0) + 1
        if scope['enabled'] != 1:
            disabled['message_scopes'] += 1
            disabled['sent' if scope['id'] == SENT_ID else 'received'] += 1
            disabled['other' if reason == 'ordinary' else 'unsupported'] += 1
    lane_counts = {}
    for lane in ('sent', 'received'):
        keys = [key for key in enabled if (key == SENT_ID) == (lane == 'sent')]
        lane_counts[lane] = {
            'enabled_scopes': len(keys),
            'complete_window_coverage': sum(details.get(key, {}).get('complete', False) for key in keys),
            'without_eligible_successful_runs': sum(valid_run_counts[key] == 0 for key in keys),
        }
    coverage = {
        'required_start_ms': start_ms, 'required_start_utc': utc_text(start_ms),
        'target_ms': target_ms, 'target_utc': utc_text(target_ms),
        'configured_initial_sync_start_ms': baseline_ms,
        'baseline_status': baseline_status,
        'range_status': range_status,
        'baseline_valid': baseline_status == 'ok',
        'enabled_message_scopes': len(enabled),
        'complete_window_coverage_scopes': complete_scopes,
        'incomplete_window_coverage_scopes': len(enabled) - complete_scopes,
        'scopes_missing_start_coverage': (sum(item['missing_start'] for item in details.values())) if range_valid else None,
        'scopes_with_internal_gaps': (sum(item['internal_gaps'] > 0 for item in details.values())) if range_valid else None,
        'scopes_missing_end_coverage': (sum(item['missing_end'] for item in details.values())) if range_valid else None,
        'scopes_without_eligible_successful_runs': sum(value == 0 for value in valid_run_counts.values()),
        'scopes_with_invalid_successful_run_evidence': sum(value > 0 for value in invalid_run_counts.values()),
        'covered_scope_milliseconds': (sum(item['covered_ms'] for item in details.values())) if range_valid else None,
        'missing_scope_milliseconds': (sum(item['missing_ms'] for item in details.values())) if range_valid else None,
        'oldest_contiguous_coverage_end_utc': utc_text(min(item['contiguous_end_ms'] for item in details.values())) if details else None,
        'enabled_unsupported_scopes': sum(scope['unsupported_reason'] is not None for scope in enabled.values()),
        'by_lane': lane_counts,
        'disabled_excluded': disabled,
        **evidence_counts,
        'invalid_successful_run_reasons': invalid_reasons,
        'successful_windows_cover_fixed_range': bool(coverage_complete),
        'details_at_or_before_target_resolved': (details_clear if detail_state['evidence'] == 'available' else None),
        'initial_baseline_complete': strict_complete,
    }
    out = {
        'checked_at': datetime.datetime.now(UTC).isoformat(), 'progress': progress, 'coverage': coverage,
        'details': detail_state, 'list_progress': list_progress,
        'discovery': discovery,
        'scope_classes': [{'enabled': enabled_flag, 'reason': reason, 'count': count}
                          for (enabled_flag, reason), count in sorted(classes.items())],
    }
    queries = {
        'runs': "SELECT status,count(*) AS count,max(finished_at) AS latest_finished_at FROM sync_runs GROUP BY status",
        'recent_errors': """SELECT status,CASE WHEN error_type IN ('Error','StaleLock','StaleRun','PaginationLimitError')
          THEN error_type ELSE 'other' END AS error_type,count(*) AS count,min(started_at) AS first_at,
          max(started_at) AS latest_at FROM sync_runs WHERE status IN ('failed','cancelled') GROUP BY status,2""",
        'records': 'SELECT count(*) AS count FROM records',
        'integrity': 'PRAGMA quick_check',
        'foreign_key_issues': 'SELECT count(*) AS count FROM pragma_foreign_key_check',
        'sync_locks': 'SELECT count(*) AS count FROM sync_locks',
    }
    for name, query in queries.items():
        out[name] = [dict(row) for row in con.execute(query)]
    integrity_ok = len(out['integrity']) == 1 and out['integrity'][0].get('quick_check') == 'ok'
    foreign_keys_ok = (len(out['foreign_key_issues']) == 1
                       and out['foreign_key_issues'][0].get('count') == 0)
    # Do not emit raw integrity failures, which can contain local details.
    out['integrity'] = [{'quick_check': 'ok' if integrity_ok else 'failed'}]
    out['database_checks_ok'] = integrity_ok and foreign_keys_ok
    out['ok'] = strict_complete and out['database_checks_ok']
    return out


def inspect_database(db_path, target_ms):
    con = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        con.row_factory = sqlite3.Row
        con.execute('PRAGMA query_only=ON')
        con.execute('BEGIN')
        return inspect_connection(con, target_ms)
    finally:
        con.close()


def recent_cycles(log_path):
    cycles = []
    if not log_path.exists():
        return cycles
    known_steps = {'sent', 'discover-hot', 'received-hot', 'discover-catchup',
                   'discover-reconcile', 'received-fair', 'retention'}
    # Limit optional log inspection; ignore an incomplete first JSONL record.
    with log_path.open('rb') as stream:
        stream.seek(0, 2)
        offset = max(0, stream.tell() - 1024 * 1024)
        stream.seek(offset)
        text = stream.read().decode('utf-8', errors='replace')
    lines = text.splitlines()
    if offset:
        lines = lines[1:]
    for line in lines:
        event = parse_json(line)
        if not isinstance(event, dict) or event.get('type') != 'lark_im_worker_cycle':
            continue
        item = {'cycle': integer_ms(event.get('cycle')), 'at': utc_text(iso_ms(event.get('at'))),
                'ok': event.get('ok') if isinstance(event.get('ok'), bool) else None}
        failed = event.get('failed_steps')
        if isinstance(failed, list):
            item['failed_steps'] = [name if isinstance(name, str) and name in known_steps else 'other'
                                    for name in failed]
        elif integer_ms(failed) is not None:
            item['failed_steps'] = integer_ms(failed)
        cycles.append(item)
    return cycles[-5:]


def target_argument(value):
    result = iso_ms(value)
    if result is None:
        raise argparse.ArgumentTypeError(
            "--target must be a valid ISO date/time with an explicit timezone (Z or +/-HH:MM)"
        )
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, type=target_argument,
                        help='Required coverage end as an ISO timestamp with timezone; must be after baseline.')
    parser.add_argument('--db', type=Path, default=ROOT / 'data/exocortex.sqlite',
                        help='Existing SQLite database; defaults to data/exocortex.sqlite under the installed project root.')
    parser.add_argument('--log', type=Path,
                        help='Optional worker JSONL log. Its availability never decides coverage.')
    args = parser.parse_args(argv)
    try:
        out = inspect_database(args.db, args.target)
    except (sqlite3.Error, OSError, ValueError, TypeError, OverflowError):
        # Exception strings may contain private paths/identifiers; fail closed.
        out = {'checked_at': datetime.datetime.now(UTC).isoformat(),
               'error': 'readonly_inspection_failed', 'ok': False,
               'coverage': {'initial_baseline_complete': False}}
    out['recent_cycles'] = []
    out['log_status'] = 'not_requested'
    if args.log is not None:
        try:
            if not args.log.is_file():
                raise OSError("optional log unavailable")
            out['recent_cycles'] = recent_cycles(args.log)
            out['log_status'] = 'read'
        except (OSError, ValueError, TypeError):
            out['log_status'] = 'unavailable'
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
