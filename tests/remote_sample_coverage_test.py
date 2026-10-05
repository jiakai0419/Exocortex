"""Bounded sample coverage against generated-only SQLite history and debt."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/coverage/lark-im-coverage-check.py'
SPEC = importlib.util.spec_from_file_location('sample_coverage_check', SCRIPT)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)
START = 1_609_459_200_000
END = START + 600_000
NOW = END + 3_600_000
SCOPE = check.RECEIVED_PREFIX + 'synthetic_scope'
KEY = hashlib.sha256(b'synthetic sample correlation').hexdigest()
MESSAGE = 'synthetic_private_message'


def cursor(ms):
    return json.dumps({'kind': 'time_message_cursor/v1', 'created_at_ms': ms})


class SampleCoverageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='synthetic-sample-coverage-')
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'synthetic.sqlite'
        self.con = sqlite3.connect(self.path)
        self.addCleanup(self.con.close)
        self.con.executescript('''
            CREATE TABLE sources(id TEXT PRIMARY KEY,enabled INTEGER,config_json TEXT);
            CREATE TABLE sync_scopes(id TEXT PRIMARY KEY,source_id TEXT,enabled INTEGER,config_json TEXT);
            CREATE TABLE sync_runs(id INTEGER PRIMARY KEY,source_id TEXT,scope_id TEXT,status TEXT,
              metadata_json TEXT,cursor_before_json TEXT,cursor_after_json TEXT,started_at TEXT,finished_at TEXT);
            CREATE INDEX run_scope_started ON sync_runs(scope_id,started_at DESC);
            CREATE TABLE lark_im_list_progress(scope_id TEXT PRIMARY KEY);
            CREATE TABLE lark_im_detail_tasks(scope_id TEXT,status TEXT,occurred_at_ms INTEGER);
            CREATE INDEX detail_scope_status ON lark_im_detail_tasks(scope_id,status);
            CREATE TABLE records(external_id TEXT,source_id TEXT,record_type TEXT,container_id TEXT,
              external_version TEXT,raw_json TEXT,canonical_json TEXT,UNIQUE(source_id,external_id));
        ''')
        self.con.execute('INSERT INTO sources VALUES(?,?,?)',
                         ('lark.im', 1, json.dumps({'initial_sync_start_ms': START})))
        self.con.execute('INSERT INTO sync_scopes VALUES(?,?,?,?)',
                         (SCOPE, 'lark.im', 1, json.dumps({'chat_id': 'synthetic_private_chat'})))

    def run_window(self, left=START, right=END, finished=END + 60_000, metadata=None,
                   source='lark.im', scope=SCOPE, status='succeeded', before='default', after='default', started=None):
        data = {'window_start': check.utc_text(left), 'window_end': check.utc_text(right),
                'window_complete': True}
        if metadata:
            data.update(metadata)
        self.con.execute('''INSERT INTO sync_runs(source_id,scope_id,status,metadata_json,
          cursor_before_json,cursor_after_json,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?)''',
                         (source, scope, status, json.dumps(data),
                          cursor(left) if before == 'default' else before,
                          cursor(right // 60_000 * 60_000) if after == 'default' else after,
                          check.utc_text(left if started is None else started), check.utc_text(finished)))

    def target(self, **changes):
        return {'key': KEY, 'scope_id': SCOPE, 'message_id': MESSAGE, 'created_ms': START + 60_001, **changes}

    def record(self, message=MESSAGE, source='lark.im', record_type='lark.im.message', body='synthetic private body'):
        self.con.execute('INSERT INTO records VALUES(?,?,?,?,?,?,?)',
                         (message, source, record_type, 'synthetic_private_chat', str(START + 60_001),
                          json.dumps({'body': body}), json.dumps({'source_api': 'im.v1.messages'})))

    def inspect(self, targets=None):
        self.con.commit()
        before = self.path.read_bytes()
        result = check.inspect_sample_database(self.path, {'targets': targets or [self.target()]}, now_ms=NOW)
        self.assertEqual(self.path.read_bytes(), before, 'sample coverage must not write its database')
        encoded = json.dumps(result)
        for private in (SCOPE, 'synthetic_private_chat', str(self.path)):
            self.assertNotIn(private, encoded)
        return result['coverage']

    def test_valid_covering_run_and_readonly_privacy(self):
        self.run_window()
        result = self.inspect()[KEY]
        self.assertEqual(result, {'covered': True, 'latest_finished_ms': END + 60_000,
                                  'details_pending': False, 'reason': 'covered'})

    def test_reconfirmation_requires_later_finish_of_same_covering_window(self):
        observed = END + 120_000
        self.run_window()
        self.run_window(left=END, right=END + 600_000, finished=END + 700_000)
        self.assertFalse(self.inspect([self.target(observed_after_ms=observed)])[KEY]['covered'])
        self.run_window(finished=observed)
        self.assertFalse(self.inspect([self.target(observed_after_ms=observed)])[KEY]['covered'])
        self.run_window(finished=observed + 1)
        self.assertEqual(self.inspect([self.target(observed_after_ms=observed)])[KEY]['latest_finished_ms'], observed + 1)

    def test_window_end_boundary_and_minute_floor_are_conservative(self):
        self.run_window(right=END + 59_999)
        self.assertFalse(self.inspect([self.target(created_ms=END)])[KEY]['covered'])
        self.assertTrue(self.inspect([self.target(created_ms=END - 1)])[KEY]['covered'])

    def test_cursor_or_requested_end_cannot_replace_actual_window(self):
        self.run_window(right=START + 60_000, after=cursor(END), metadata={'requested_window_end': check.utc_text(END)})
        self.assertFalse(self.inspect()[KEY]['covered'])

    def test_skipped_failed_foreign_and_bad_cursors_never_cover(self):
        variants = [dict(status='failed'), dict(source='synthetic_foreign'), dict(metadata={'skipped': True}),
                    dict(before=cursor(START - 60_000)), dict(after=cursor(END + 60_000)),
                    dict(metadata={'window_complete': False}), dict(finished=NOW + 1),
                    dict(started=END + 120_000)]
        for variant in variants:
            with self.subTest(variant=variant):
                self.con.execute('DELETE FROM sync_runs')
                self.run_window(**variant)
                self.assertFalse(self.inspect()[KEY]['covered'])

    def test_source_and_scope_must_be_enabled_and_owned(self):
        self.run_window()
        for statement, reason in [
                ("UPDATE sources SET enabled=0", 'source_unavailable'),
                ("UPDATE sync_scopes SET enabled=0", 'scope_unavailable'),
                ("UPDATE sync_scopes SET source_id='foreign'", 'scope_unavailable'),
                ("UPDATE sync_scopes SET config_json='{}'", 'scope_unavailable')]:
            with self.subTest(statement=statement):
                self.con.execute('SAVEPOINT scenario')
                self.con.execute(statement)
                self.con.row_factory = sqlite3.Row
                result = check.inspect_sample_connection(self.con, [self.target()], NOW)[KEY]
                self.assertEqual(result['reason'], reason)
                self.assertFalse(result['covered'])
                self.con.execute('ROLLBACK TO scenario')
                self.con.execute('RELEASE scenario')

    def test_detail_debt_and_missing_ledger_block(self):
        self.run_window()
        self.con.execute('INSERT INTO lark_im_detail_tasks VALUES(?,?,?)', (SCOPE, 'pending', END + 60_000))
        self.assertEqual(self.inspect()[KEY]['reason'], 'details_pending')
        self.assertTrue(self.inspect()[KEY]['details_pending'])
        self.con.execute("UPDATE lark_im_detail_tasks SET status='complete'")
        self.assertTrue(self.inspect()[KEY]['covered'])
        self.con.execute('DROP TABLE lark_im_list_progress')
        self.assertEqual(self.inspect()[KEY]['reason'], 'detail_evidence_unavailable')

    def test_detail_complete_contract_is_same_as_full_coverage(self):
        evidence = {'coverage_mode': 'list_checkpoint_and_details', 'list_complete': True,
                    'details_complete': True, 'pending_detail_count': 0,
                    'window_start_ms': START, 'window_end_ms': END}
        self.run_window(metadata=evidence)
        self.assertTrue(self.inspect()[KEY]['covered'])
        self.con.execute('DELETE FROM sync_runs')
        self.run_window(metadata={**evidence, 'pending_detail_count': 1})
        self.assertFalse(self.inspect()[KEY]['covered'])
        self.con.execute('DELETE FROM sync_runs')
        self.run_window(metadata={'list_complete': True, 'list_window_start_ms': START})
        self.assertFalse(self.inspect()[KEY]['covered'])

    def test_sql_prefilters_outside_windows_before_history_budget(self):
        for _ in range(501):
            self.run_window(left=END, right=END + 600_000, finished=END + 700_000)
        self.run_window()
        self.assertTrue(self.inspect()[KEY]['covered'])

    def test_per_target_and_batch_caps_fail_closed(self):
        for _ in range(501):
            self.run_window()
        self.assertEqual(self.inspect()[KEY]['reason'], 'inspection_budget_exhausted')
        self.con.execute('DELETE FROM sync_runs WHERE id>3')
        with mock.patch.object(check, 'SAMPLE_TOTAL_RUNS', 5):
            targets = [self.target(), self.target(key='b' * 64)]
            result = self.inspect(targets)
            self.assertTrue(result[KEY]['covered'])
            self.assertEqual(result['b' * 64]['reason'], 'inspection_budget_exhausted')

    def test_deadline_fails_closed(self):
        self.run_window()
        with mock.patch.object(check, 'SAMPLE_BUDGET_SECONDS', -1):
            self.assertEqual(self.inspect()[KEY]['reason'], 'inspection_budget_exhausted')

    def test_input_contract_rejects_future_duplicates_and_foreign_shapes(self):
        invalid = [self.target(created_ms=NOW + 1), self.target(observed_after_ms=NOW + 1),
                   self.target(scope_id=check.SENT_ID), self.target(created_ms=True), self.target(key='private-id'),
                   self.target(message_id=''), self.target(message_id='x' * 513)]
        for target in invalid:
            with self.subTest(target=target), self.assertRaises(ValueError):
                check.validate_sample_targets({'targets': [target]}, NOW)
        for payload in ({'targets': [self.target()] * 2}, {'targets': [self.target()] * 201}, {'targets': [], 'extra': 1}):
            with self.assertRaises(ValueError):
                check.validate_sample_targets(payload, NOW)

    def test_cli_has_bounded_private_stdin_and_safe_missing_database(self):
        self.run_window()
        self.con.commit()
        for db, expected in ((self.path, 'covered'), (self.path.with_name('missing.sqlite'), 'readonly_inspection_failed')):
            output = io.StringIO()
            with mock.patch('sys.stdin', io.StringIO(json.dumps({'targets': [self.target()]}))), contextlib.redirect_stdout(output):
                code = check.main(['--db', str(db), '--sample-targets'])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.getvalue())['coverage'][KEY]['reason'], expected)
            self.assertNotIn(str(db), output.getvalue())
        output = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO('x' * (check.SAMPLE_MAX_INPUT_BYTES + 1))), contextlib.redirect_stdout(output):
            self.assertEqual(check.main(['--db', str(self.path), '--sample-targets']), 2)
        self.assertEqual(json.loads(output.getvalue())['error'], 'invalid_sample_targets')

    def test_coverage_and_record_survive_atomic_writer_revocation_in_same_snapshot(self):
        """Reproduce old-coverage/new-absence: WAL writer commits between reads.

        The old implementation's two connections could combine true coverage
        with absent records. One transaction must instead return old+old while
        a subsequent snapshot returns new+new.
        """
        self.con.commit()
        self.con.execute('PRAGMA journal_mode=WAL')
        self.run_window(finished=END + 120_000)
        self.record()
        self.con.commit()
        writer_calls = []

        def revoke():
            writer = sqlite3.connect(self.path, timeout=0.1)
            try:
                writer.execute('BEGIN IMMEDIATE')
                writer.execute('DELETE FROM sync_runs')
                writer.execute('DELETE FROM records')
                writer.commit()
                writer_calls.append('committed')
            finally:
                writer.close()

        payload = {'targets': [self.target(observed_after_ms=END + 60_000)]}
        snapshot = check.inspect_sample_database(self.path, payload, now_ms=NOW, after_coverage=revoke)
        self.assertEqual(writer_calls, ['committed'])
        self.assertNotIn('error', snapshot)
        self.assertTrue(snapshot['coverage'][KEY]['covered'])
        self.assertEqual([row['external_id'] for row in snapshot['records']], [MESSAGE])
        self.assertIn('synthetic private body', snapshot['records'][0]['raw_json'])
        after = check.inspect_sample_database(self.path, payload, now_ms=NOW)
        self.assertFalse(after['coverage'][KEY]['covered'])
        self.assertEqual(after['records'], [])

    def test_private_records_filter_exact_source_and_ids_but_preserve_wrong_type(self):
        self.run_window()
        self.record(source='synthetic.foreign')
        self.record(message='synthetic_other_message')
        self.record(record_type='synthetic.wrong_type')
        self.con.commit()
        snapshot = check.inspect_sample_database(self.path, {'targets': [self.target()]}, now_ms=NOW)
        self.assertTrue(snapshot['coverage'][KEY]['covered'])
        self.assertEqual(len(snapshot['records']), 1)
        self.assertEqual(snapshot['records'][0]['record_type'], 'synthetic.wrong_type')
        self.assertEqual(snapshot['records'][0]['source_id'], 'lark.im')

    def test_record_read_failure_and_payload_budget_discard_all_coverage(self):
        self.run_window()
        self.record(body='generated payload')
        self.con.commit()
        with mock.patch.object(check, 'SAMPLE_MAX_RECORD_BYTES', 1):
            result = check.inspect_sample_database(self.path, {'targets': [self.target()]}, now_ms=NOW)
        self.assertEqual(result['error'], 'readonly_inspection_failed')
        self.assertFalse(result['coverage'][KEY]['covered'])
        self.assertEqual(result['records'], [])
        self.con.execute('DROP TABLE records')
        self.con.commit()
        result = check.inspect_sample_database(self.path, {'targets': [self.target()]}, now_ms=NOW)
        self.assertEqual(result['error'], 'readonly_inspection_failed')
        self.assertFalse(result['coverage'][KEY]['covered'])
        self.assertEqual(result['records'], [])


if __name__ == '__main__':
    unittest.main()
