"""Offline retry protection: do not refetch successful groups or overwrite them."""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import run_collect
import apple
from process_data import process
from merge import RANK_FIELDS, read_csv
from test_data_pipeline import DAY, TS, group, item, snapshot


class CollectionRetryTests(unittest.TestCase):
    def test_only_failed_and_partial_groups_are_retried(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            directory = root / 'data/web'
            directory.mkdir(parents=True)
            finished = f'{DAY}T09:12:00+09:00'
            def status(name, category, status):
                return {'source': 'apple', 'country': 'US', 'chart': 'top_free',
                        'category': category, 'feed': None, 'status': status}
            payload = {'finished_at': finished, 'overall_status': 'partial',
                       'accepted_groups': 2, 'groups': [
                           status('success', 'all_apps', 'success'),
                           status('failed', 'game_puzzle', 'failed'),
                           status('partial', 'game_action', 'partial'),
                           status('skipped', 'game_arcade', 'skipped')]}
            (directory / 'status.json').write_text(json.dumps(payload))
            keys = run_collect.incomplete_groups(root, DAY)
            self.assertEqual({v['category'] for v in keys}, {'game_puzzle','game_action'})
            self.assertEqual({v['source'] for v in keys}, {'apple'})
            self.assertFalse(any(v['category'] == 'all_apps' for v in keys))

            with self.assertRaisesRegex(ValueError, 'RETRY_STATUS_NOT_TODAY'):
                run_collect.incomplete_groups(root, '2026-10-23')
            payload['overall_status'] = 'success'
            (directory / 'status.json').write_text(json.dumps(payload))
            self.assertEqual(run_collect.incomplete_groups(root, DAY), keys)

    def test_apple_only_requested_chart_is_polled(self):
        requested = {('US', 'top_free', 'game_puzzle')}
        # Calling collect with no target network allowed guarantees filtering.
        with patch.object(apple, 'fetch_bytes', side_effect=RuntimeError('MOCK_FAIL')) as fetch:
            groups = apple.collect(['US','JP','KR'], 'full', sleep_sec=0, only_groups=requested)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['country'], 'US')
        self.assertEqual(groups[0]['category'], 'game_puzzle')
        self.assertEqual(fetch.call_count, 1)

    def test_retry_replaces_only_failed_group_and_preserves_successful_source(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root/'data/staging').mkdir(parents=True)
            src = root/'data/staging/google.json'
            good = group('google',[item('google','GOOD')])
            bad = group('google',[],status='failed',country='JP')
            src.write_text(json.dumps(snapshot('google',[good,bad])),encoding='utf8')
            process(root,DAY,('google',))
            previous = json.loads((root/'data/web/status.json').read_text())
            self.assertEqual(previous['overall_status'],'partial')
            good_rows = [r for r in read_csv(root/f'data/rankings/2026/10/{DAY}.csv',RANK_FIELDS)
                         if r['country']=='US']
            self.assertEqual(len(good_rows),1)
            self.assertEqual(good_rows[0]['app_key'],'google:com.example.GOOD')
            recovered = group('google',[item('google','RECOVERED')],country='JP')
            src.write_text(json.dumps(snapshot('google',[recovered])),encoding='utf8')
            process(root,DAY,('google',),only_groups=[bad])
            status = json.loads((root/'data/web/status.json').read_text())
            jp = next(r for r in status['groups'] if r['source']=='google'
                      and r['country']=='JP' and r['category']=='game_puzzle')
            us = next(r for r in status['groups'] if r['source']=='google'
                      and r['country']=='US' and r['category']=='game_puzzle')
            self.assertTrue(jp['accepted'])
            self.assertTrue(us['accepted'])
            rows = read_csv(root/f'data/rankings/2026/10/{DAY}.csv',RANK_FIELDS)
            self.assertEqual({r['app_key'] for r in rows},
                             {'google:com.example.GOOD','google:com.example.RECOVERED'})

    def test_retry_failure_does_not_erase_existing_success(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root/'data/staging').mkdir(parents=True)
            src = root/'data/staging/google.json'
            good=group('google',[item('google','FIRST')])
            src.write_text(json.dumps(snapshot('google',[good])),encoding='utf8')
            process(root,DAY,('google',))
            original=json.loads((root/'data/web/status.json').read_text())
            self.assertEqual(original['accepted_groups'],1)
            failure = group('google', [], status='failed')
            src.write_text(json.dumps(snapshot('google',[failure])),encoding='utf8')
            process(root,DAY,('google',),only_groups=[good])
            status=json.loads((root/'data/web/status.json').read_text())
            target=next(r for r in status['groups'] if r['source']=='google' and
                        r['country']=='US' and r['category']=='game_puzzle')
            self.assertTrue(target['accepted'])
            self.assertEqual(target['last_checked_date'],DAY)
            self.assertEqual(status['accepted_groups'],1)

if __name__ == '__main__': unittest.main()
