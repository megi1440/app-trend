"""Offline pipeline regression tests; no market data is fabricated in production."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'collector'))
from process_data import process
from merge import RANK_FIELDS, read_csv, write_csv
from build_web import safe_spreadsheet_value

DAY = '2026-10-22'
TS = '2026-10-22T10:15:00+09:00'


def item(source, name, position=1):
    id_ = 'com.example.' + name if source == 'google' else ('12345' if source == 'apple' else 'i01')
    return dict(app_key=f'{source}:{id_}', source_id=id_, position=position, kind='game',
                name=name, developer='Indie Dev', primary_category='Puzzle',
                detail_url='https://example.org/' + name, icon_url='https://example.org/icon.png',
                release_date='', rating=4.5)


def snapshot(source, groups, mode='full'):
    return dict(schema_version=1, source=source, mode=mode, generated_at=TS, groups=groups)


def group(source, items, status='success', country='US', feed=None):
    return dict(source=source, country='GLOBAL' if source == 'itch' else country,
                chart=None if source == 'itch' else 'top_free',
                category=None if source == 'itch' else 'game_puzzle',
                feed=feed, status=status, attempted_at=TS, item_count=len(items),
                items=items, message='')


class DataPipelineTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.root = Path(self.td.name)
        (self.root / 'data/staging').mkdir(parents=True)

    def stage(self, source, groups, mode='full'):
        (self.root / 'data/staging' / (source + '.json')).write_text(
            json.dumps(snapshot(source, groups, mode)), encoding='utf-8')

    def test_merges_and_exports_three_sources(self):
        self.stage('apple', [group('apple', [item('apple', 'A')])])
        self.stage('google', [group('google', [item('google', 'G')])])
        self.stage('itch', [group('itch', [item('itch', 'I')], feed='featured')])
        result = process(self.root, DAY)
        self.assertEqual(result['accepted'], 3)
        self.assertEqual(len(read_csv(self.root / f'data/rankings/2026/10/{DAY}.csv', RANK_FIELDS)), 2)
        latest = json.loads((self.root / 'data/web/latest.json').read_text(encoding='utf-8'))
        self.assertTrue(any(g['source'] == 'itch' and g['items'] for g in latest['groups']))
        self.assertTrue((self.root / f'data/exports/app_trends_90d_{DAY}.csv').exists())
        self.assertTrue((self.root / f'data/exports/indie_discoveries_7d_{DAY}.csv').exists())
        apps = (self.root / 'data/apps.csv').read_text(encoding='utf-8')
        self.assertIn('apple:12345', apps)
        self.assertIn('itch:i01', apps)
        self.assertEqual(json.loads((self.root / 'data/web/status.json').read_text(encoding='utf-8'))['overall_status'], 'partial')

    def test_rerun_failure_does_not_erase_and_stale_is_visible(self):
        self.stage('google', [group('google', [item('google', 'A')])])
        process(self.root, DAY, ('google',))
        before = (self.root / f'data/rankings/2026/10/{DAY}.csv').read_bytes()
        self.stage('google', [group('google', [], status='failed')])
        result = process(self.root, DAY, ('google',))
        self.assertEqual(result['accepted'], 0)
        self.assertEqual(before, (self.root / f'data/rankings/2026/10/{DAY}.csv').read_bytes())
        latest = json.loads((self.root / 'data/web/latest.json').read_text(encoding='utf-8'))
        target = next(g for g in latest['groups'] if g['source'] == 'google' and g['category'] == 'game_puzzle'
                      and g['country'] == 'US')
        self.assertEqual(target['items'][0]['name'], 'A')
        self.assertTrue(target['is_stale'])

    def test_successful_rerun_replaces_one_group_not_append(self):
        self.stage('google', [group('google', [item('google', 'A')])])
        process(self.root, DAY, ('google',))
        self.stage('google', [group('google', [item('google', 'B')])])
        process(self.root, DAY, ('google',))
        rows = read_csv(self.root / f'data/rankings/2026/10/{DAY}.csv', RANK_FIELDS)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['app_key'], 'google:com.example.B')
        apps = (self.root / 'data/apps.csv').read_text(encoding='utf-8')
        self.assertIn('google:com.example.A', apps)  # Historical app stays registered.

    def test_apple_old_7003_arcade_rows_fixed_offline(self):
        path = self.root / f'data/rankings/2026/10/{DAY}.csv'
        old = [dict(date=DAY, collected_at=TS, source='apple', country=country,
                    chart='top_free', category='game_arcade', rank='1', app_key='apple:12345')
               for country in ('US', 'JP', 'KR')]
        write_csv(path, RANK_FIELDS, old)
        self.stage('google', [group('google', [item('google','A')])])
        process(self.root, DAY, ('google',))
        fixed = read_csv(path, RANK_FIELDS)
        self.assertEqual(len(fixed), 4)
        self.assertFalse(any(r['source']=='apple' and r['category']=='game_arcade' for r in fixed))
        self.assertEqual(sum(r['source']=='apple' and r['category']=='game_casual' for r in fixed), 3)
        latest = json.loads((self.root/'data/web/latest.json').read_text(encoding='utf-8'))
        self.assertEqual(sum(g['source']=='apple' and g['category']=='game_casual' for g in latest['groups']), 3)
        # Repeat processing is safe and never duplicates old rank records.
        process(self.root, DAY, ('google',))
        self.assertEqual(len(read_csv(path, RANK_FIELDS)), 4)

    def test_smoke_cannot_modify_csv(self):
        self.stage('google', [group('google', [item('google', 'A')])], mode='smoke')
        with self.assertRaisesRegex(ValueError, 'REFUSE_SMOKE_DATA'):
            process(self.root, DAY, ('google',))
        self.assertFalse((self.root / 'data/apps.csv').exists())

    def test_large_to_one_rejected(self):
        many = [item('google', str(i), i + 1) for i in range(20)]
        self.stage('google', [group('google', many)])
        process(self.root, DAY, ('google',))
        original = (self.root / f'data/rankings/2026/10/{DAY}.csv').read_bytes()
        self.stage('google', [group('google', [item('google', '0')])])
        process(self.root, DAY, ('google',))
        self.assertEqual(original, (self.root / f'data/rankings/2026/10/{DAY}.csv').read_bytes())
        status = json.loads((self.root / 'data/web/status.json').read_text(encoding='utf-8'))
        warning = next(g for g in status['groups'] if g['source']=='google' and g['country']=='US' and g['category']=='game_puzzle')
        self.assertIn('SUSPICIOUS_DROP', warning['message'])

    def test_real_seven_day_rank_change_and_first_seen(self):
        old_day = '2026-10-15'
        old_stamp = '2026-10-15T09:30:00+09:00'
        older = snapshot('google', [group('google', [item('google', 'A', 30)])])
        older['generated_at'] = old_stamp
        older['groups'][0]['attempted_at'] = old_stamp
        (self.root / 'data/staging/google.json').write_text(json.dumps(older), encoding='utf-8')
        process(self.root, old_day, ('google',))
        self.stage('google', [group('google', [item('google', 'A', 10)])])
        process(self.root, DAY, ('google',))
        apps = (self.root / 'data/apps.csv').read_text(encoding='utf-8')
        self.assertIn('2026-10-15,2026-10-22', apps)
        trends = json.loads((self.root / 'data/web/trends.json').read_text(encoding='utf-8'))
        rising = next(c for c in trends['candidates'] if c['reason_code'] == 'rising_7d')
        self.assertEqual(rising['evidence']['change'], 20)
        self.assertEqual(rising['source_data_dates'], ['2026-10-15', DAY])

    def test_manual_source_rerun_preserves_other_status(self):
        self.stage('google', [group('google', [item('google', 'G')])])
        process(self.root, DAY, ('google',))
        self.stage('apple', [group('apple', [item('apple', 'A')])])
        process(self.root, DAY, ('apple',))
        status = json.loads((self.root / 'data/web/status.json').read_text(encoding='utf-8'))
        self.assertEqual(len(status['groups']), 106)
        google = next(g for g in status['groups'] if g['source'] == 'google'
                      and g['country'] == 'US' and g['category'] == 'game_puzzle')
        self.assertTrue(google['accepted'])
        self.assertEqual(google['last_checked_date'], DAY)
        latest = json.loads((self.root / 'data/web/latest.json').read_text(encoding='utf-8'))
        google_chart = next(g for g in latest['groups'] if g['source'] == 'google'
                            and g['country'] == 'US' and g['category'] == 'game_puzzle')
        self.assertEqual(google_chart['items'][0]['name'], 'G')
        self.assertFalse(google_chart['is_stale'])

    def test_seven_failed_collection_days_alert_without_same_day_double_count(self):
        import datetime as dt
        for index in range(7):
            day = (dt.date(2026, 10, 16) + dt.timedelta(days=index)).isoformat()
            stamp = f'{day}T10:15:00+09:00'
            failed = snapshot('apple', [group('apple', [], status='failed')])
            failed['generated_at'] = stamp
            failed['groups'][0]['attempted_at'] = stamp
            (self.root / 'data/staging/apple.json').write_text(json.dumps(failed), encoding='utf-8')
            self.stage('google', [group('google', [item('google', 'G')])])
            good = self.root / 'data/staging/google.json'
            doc = json.loads(good.read_text(encoding='utf-8'))
            doc['generated_at'] = stamp
            doc['groups'][0]['attempted_at'] = stamp
            good.write_text(json.dumps(doc), encoding='utf-8')
            process(self.root, day, ('apple', 'google'))
            status = json.loads((self.root/'data/web/status.json').read_text(encoding='utf-8'))
            apple = next(x for x in status['groups'] if x['source'] == 'apple'
                         and x['country'] == 'US' and x['category'] == 'game_puzzle')
            self.assertEqual(apple['consecutive_failed_days'], index + 1)
            self.assertEqual(apple['needs_attention'], index == 6)
            if index == 6:
                process(self.root, day, ('apple', 'google'))
                rerun = json.loads((self.root/'data/web/status.json').read_text(encoding='utf-8'))
                same = next(x for x in rerun['groups'] if x['source'] == 'apple'
                            and x['country'] == 'US' and x['category'] == 'game_puzzle')
                self.assertEqual(same['consecutive_failed_days'], 7)

    def test_no_spreadsheet_formula_in_download(self):
        self.assertEqual(safe_spreadsheet_value(' =HYPERLINK("test")'), '\' =HYPERLINK("test")')
        self.assertEqual(safe_spreadsheet_value('@cmd'), "'@cmd")
        self.assertEqual(safe_spreadsheet_value('name'), 'name')


if __name__ == '__main__':
    unittest.main()
