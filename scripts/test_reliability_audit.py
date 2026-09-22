import unittest
import argparse
import io
import json
from pathlib import Path
import tempfile
import urllib.error
from unittest.mock import patch
from reliability_audit import audit, consume, environment, fresh_state, report, timestamp


def document(document_id, **fields):
    return {'name': document_id, 'fields': {key: {'stringValue': value} for key, value in fields.items()}}


class ReliabilityAuditTest(unittest.TestCase):
    def state(self):
        return fresh_state('test-project', 'test-tenant', ['production.example'], '2026-09-22T00:00:00Z')

    def test_kst_boundary_and_missing_timestamp_are_distinct(self):
        state = self.state()
        consume(state, [document('a', createdAt='2026-09-20T15:00:00Z'), document('b', createdAt='invalid')])
        self.assertEqual(state['dailyKst'], {'2026-09-21': 1})
        self.assertEqual(state['missingCreatedAt'], 1)
        self.assertIsNone(timestamp('2026-09-20T15:00:00'))

    def test_preview_is_not_inferred_from_vercel_hostname(self):
        self.assertEqual(environment({'href': 'https://app.vercel.app'}, []), 'unknown')
        self.assertEqual(environment({'href': 'http://localhost:5173'}, []), 'local_host_observed')
        self.assertEqual(environment({'href': 'https://production.example/a?secret=x'}, ['production.example']), 'production_host_observed')

    def test_repeated_requests_are_not_silently_removed(self):
        state = self.state()
        consume(state, [document('a', clientRequestId='r', source='platform_api'), document('b', clientRequestId='r', source='platform_api')])
        state['exhausted'] = True
        result = report(state, 2)
        self.assertEqual(result['total'], 2)
        self.assertEqual(result['repeatedRequestExtraEvents'], 1)
        self.assertIsNone(result['errorRate'])
        self.assertNotIn('requestGroups', result)
        self.assertNotIn('cursor', result)

    def test_incomplete_scan_or_count_mismatch_never_passes(self):
        state = self.state()
        self.assertEqual(report(state, 0)['status'], 'partial')
        state['exhausted'] = True
        self.assertEqual(report(state, None)['status'], 'partial')
        self.assertEqual(report(state, 1)['status'], 'partial')
        self.assertEqual(report(state, 0)['status'], 'complete')

    def test_resume_rejects_overlapping_page(self):
        state = self.state()
        consume(state, [document('a')])
        with self.assertRaises(ValueError):
            consume(state, [document('a')])

    def test_arbitrary_labels_and_urls_do_not_leak_to_report(self):
        state = self.state()
        consume(state, [document('a', source='private@example.com', name='customer name', href='https://example.com/private?token=secret')])
        result = report(state, None)
        self.assertEqual(result['sources'], {'other_or_missing': 1})
        self.assertNotIn('private', str(result))
        self.assertNotIn('secret', str(result))

    def test_snapshot_pagination_count_failure_and_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(project='test', tenant='test', production_host=[], page_size=1,
                                      checkpoint=f'{directory}/checkpoint.json', output=f'{directory}/report.json', resume=False)
            bodies = []
            responses = [[{'document': document('a')}], [], urllib.error.HTTPError('url', 503, 'failure', {}, None)]

            def request(req, timeout):
                bodies.append(json.loads(req.data))
                response = responses.pop(0)
                if isinstance(response, Exception):
                    raise response
                return io.BytesIO(json.dumps(response).encode())

            with patch('reliability_audit.subprocess.run') as auth, patch('reliability_audit.urllib.request.urlopen', side_effect=request):
                auth.return_value.stdout = 'token'
                self.assertEqual(audit(args), 2)
                self.assertEqual(json.loads(Path(args.output).read_text())['status'], 'partial')
                checkpoint = json.loads(Path(args.checkpoint).read_text())
                self.assertTrue(checkpoint['exhausted'])
                args.resume = True
                responses.append([{'result': {'aggregateFields': {'total': {'integerValue': '1'}}}}])
                self.assertEqual(audit(args), 0)
            self.assertEqual({body['readTime'] for body in bodies}, {checkpoint['readTime']})
            self.assertEqual(bodies[1]['structuredQuery']['startAt'], {'values': [{'referenceValue': 'a'}], 'before': False})
            self.assertIn('structuredAggregationQuery', bodies[-1])

    def test_expired_snapshot_and_auth_failure_never_become_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(project='test', tenant='test', production_host=[], page_size=1,
                                      checkpoint=f'{directory}/checkpoint.json', output=f'{directory}/report.json', resume=False)
            with patch('reliability_audit.subprocess.run', side_effect=RuntimeError('secret credentials')):
                self.assertEqual(audit(args), 2)
            self.assertNotIn('secret', Path(args.output).read_text())
            state = fresh_state('test', 'test', [], '2026-01-01T00:00:00Z')
            Path(args.checkpoint).write_text(json.dumps(state))
            args.resume = True
            with patch('reliability_audit.subprocess.run') as auth, patch('reliability_audit.urllib.request.urlopen', side_effect=urllib.error.HTTPError('url', 400, 'expired', {}, None)) as request:
                auth.return_value.stdout = 'token'
                self.assertEqual(audit(args), 2)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(json.loads(Path(args.output).read_text())['readTime'], state['readTime'])


if __name__ == '__main__':
    unittest.main()
