"""Offline V3 tests: no API, no real store network, and no real repo data writes."""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import ai_daily
from test_ai_probe import sample_detailed_result


def snapshot(count=12, *, date='2026-10-22'):
    groups = []
    for source, country, category, kind in [
        ('apple', 'KR', 'app_lifestyle', 'app'),
        ('google', 'US', 'game_strategy', 'game'),
        ('itch', 'GLOBAL', 'featured', 'game'),
    ]:
        items = []
        for i in range(count):
            key = f'{source}:{kind}:{i}'
            items.append({
                'app_key': key, 'name': f'{source} example {i}',
                'kind': kind, 'first_seen': date if i > 5 else '2026-10-01',
                'rank': i + 1, 'position': i + 1,
                'detail_url': f'https://example.com/{source}/{i}',
                'description': ('Example game has real actions and outcomes. ' * 3),
            })
        groups.append({
            'source': source, 'country': country, 'category': category if source != 'itch' else None,
            'feed': category if source == 'itch' else None,
            'is_stale': False, 'data_date': date, 'items': items,
        })
    return {'data_date': date, 'groups': groups}


def trends():
    return {'candidates': [
        {'app_key': 'google:game:8', 'reason_code': 'rising_7d'},
        {'app_key': 'apple:app:7', 'reason_code': 'multi_country'},
    ]}


def responder(payload, api_key):
    assert api_key == 'FAKE_SECRET'
    items = json.loads(payload['contents'][0]['parts'][0]['text'].split('\n')[-1])
    assert len(items) <= 5
    return {'items': [sample_detailed_result(item['app_key']) for item in items]}, {
        'totalTokenCount': 700, 'promptTokenCount': 300, 'candidatesTokenCount': 400,
    }


class DailyTests(unittest.TestCase):
    def test_ranked_by_evidence_and_top_chart(self):
        rows = ai_daily.rank_candidates(snapshot(), trends())
        self.assertEqual(rows[0]['app_key'], 'google:game:8')
        self.assertIn('rising_7d', rows[0]['priority_reasons'])

    def test_stale_data_excluded_and_duplicate_ids_across_countries(self):
        data = snapshot(2)
        group = dict(data['groups'][0], country='JP')
        group['items'] = [dict(data['groups'][0]['items'][0], rank=2)]
        data['groups'].append(group)
        rows = ai_daily.rank_candidates(data, {})
        target = [r for r in rows if r['app_key'] == 'apple:app:0']
        self.assertEqual(len(target), 1)
        self.assertEqual(set(target[0]['countries']), {'KR', 'JP'})
        data['groups'][-1]['is_stale'] = True
        rows = ai_daily.rank_candidates(data, {})
        self.assertEqual([r for r in rows if r['app_key'] == 'apple:app:0'][0]['countries'], ['KR'])

    def test_preview_no_fetch_no_save_and_balanced(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            api = Mock(side_effect=AssertionError('DO NOT CALL'))
            fetch = Mock(side_effect=AssertionError('DO NOT FETCH'))
            result = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                  live=False, limit=5, fetch=fetch, invoke=api)
            self.assertEqual(result['mode'], 'preview')
            self.assertEqual(len(result['candidates']), 5)
            self.assertEqual({x['source'] for x in result['candidates']}, {'apple','google','itch'})
            self.assertFalse((home / 'data/ai').exists())
            fetch.assert_not_called()
            api.assert_not_called()

    def test_count_by_korean_date_including_imported_analyses(self):
        data = {
            'import1': {'analysed_at': '2026-10-22T14:20:00+00:00', 'data_date': '2026-10-22'},
            'import2': {'analysed_at': '2026-10-22T23:10:00+09:00', 'data_date': '2026-10-22'},
            'nextday': {'analysed_at': '2026-10-22T15:20:00Z', 'data_date': '2026-10-22'},
            'previous': {'analysed_at': '2026-10-21T20:00:00+09:00', 'data_date': '2026-10-21'},
        }
        self.assertEqual(ai_daily.analysed_on_day(data, '2026-10-22'), 2)
        self.assertEqual(ai_daily.analysed_on_day(data, '2026-10-23'), 1)
        # A batch started on the 22nd may finish after midnight.
        # Its original KST run day, not response time, consumes the quota.
        data['cross_midnight'] = {
            'quota_day': '2026-10-22',
            'analysed_at': '2026-10-23T00:05:00+09:00',
            'data_date': '2026-10-22',
        }
        self.assertEqual(ai_daily.analysed_on_day(data, '2026-10-22'), 3)
        self.assertEqual(ai_daily.analysed_on_day(data, '2026-10-23'), 1)

    def test_daily_cap_applies_across_multiple_runs_and_preview(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            prior = [
                {'app_key': f'imported:{i}', 'analysed_at': '2026-10-22T12:00:00+09:00',
                 'data_date': '2026-10-22', 'origin': 'imported_v2'}
                for i in range(58)
            ]
            ai_daily.write_records(home, prior, {})
            api = Mock(side_effect=responder)
            fetch = Mock(return_value='Detailed store description for testing. ' * 2)
            preview = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                   live=False, limit=5, run_day='2026-10-22',
                                   fetch=fetch, invoke=api)
            self.assertEqual(preview['analysed_today'], 58)
            self.assertEqual(preview['remaining_today'], 2)
            self.assertEqual(preview['effective_limit'], 2)
            self.assertEqual(len(preview['candidates']), 2)
            api.assert_not_called()
            fetch.assert_not_called()

            result = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                  live=True, api_key='FAKE_SECRET', limit=5,
                                  batch_size=5, run_day='2026-10-22',
                                  fetch=fetch, invoke=api, pause=lambda _: None)
            self.assertEqual(result['analysed'], 2)
            self.assertEqual(result['remaining_today'], 0)
            self.assertEqual(len(ai_daily.load_records(home)), 60)
            self.assertEqual(api.call_count, 1)
            self.assertEqual({entry['quota_day'] for entry in ai_daily.load_records(home).values()
                              if entry.get('origin') == 'daily_v3'}, {'2026-10-22'})

            fetch.reset_mock()
            again = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                 live=True, api_key='FAKE_SECRET', limit=60,
                                 run_day='2026-10-22', fetch=fetch, invoke=api)
            self.assertEqual(again['analysed'], 0)
            self.assertEqual(again['requests'], 0)
            self.assertEqual(again['remaining_today'], 0)
            api.assert_called_once()
            fetch.assert_not_called()

            tomorrow = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                    live=False, limit=5, run_day='2026-10-23')
            self.assertEqual(tomorrow['analysed_today'], 0)
            self.assertEqual(tomorrow['effective_limit'], 5)

    def test_run_requires_key_without_external_requests(self):
        with TemporaryDirectory() as td:
            fetch = Mock(side_effect=AssertionError('FETCH'))
            call = Mock(side_effect=AssertionError('API'))
            with self.assertRaisesRegex(ValueError, 'GEMINI_API_KEY_NOT_SET'):
                ai_daily.run(Path(td), snapshot=snapshot(), trends={}, live=True,
                             limit=5, fetch=fetch, invoke=call)
            fetch.assert_not_called()
            call.assert_not_called()

    def test_live_batch_persists_all_and_next_run_skips_them(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            fetch = Mock(return_value='A real store app has several features. ' * 3)
            api = Mock(side_effect=responder)
            result = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                  api_key='FAKE_SECRET', live=True, limit=5,
                                  fetch=fetch, invoke=api, pause=lambda seconds:None)
            self.assertEqual(result['analysed'], 5)
            self.assertEqual(result['requests'], 1)
            self.assertEqual(result['batches'], 1)
            self.assertEqual(result['usage_total_tokens'], 700)
            self.assertEqual(len(ai_daily.load_records(home)), 5)
            self.assertEqual(api.call_count, 1)
            for entry in ai_daily.load_records(home).values():
                self.assertEqual(entry['prompt_version'], 'v2')
                self.assertEqual(entry['source_description'].startswith('A real store'), True)
                self.assertNotIn('FAKE_SECRET', json.dumps(entry))
                self.assertIn('difficulty_ko', entry['analysis'])
            second = ai_daily.run(home, snapshot=snapshot(), trends=trends(),
                                  api_key='FAKE_SECRET', live=True, limit=5,
                                  fetch=fetch, invoke=api, pause=lambda seconds:None)
            self.assertEqual(second['analysed'], 5)
            self.assertEqual(len(ai_daily.load_records(home)), 10)
            self.assertEqual(api.call_count, 2)
            self.assertEqual(len(ai_daily.choose_candidates(snapshot(), trends(),
                              ai_daily.load_records(home), {}, limit=5)), 15)

    def test_output_order_may_differ(self):
        with TemporaryDirectory() as td:
            def reverse(payload, key):
                inputs = json.loads(payload['contents'][0]['parts'][0]['text'].split('\n')[-1])
                return {'items': [sample_detailed_result(item['app_key']) for item in reversed(inputs)]}, {}
            result = ai_daily.run(Path(td), snapshot=snapshot(), trends=trends(),
                                  api_key='FAKE_SECRET', live=True, limit=3,
                                  fetch=lambda item:'Long enough description. '*4,
                                  invoke=reverse, pause=lambda sec:None)
            self.assertEqual(result['analysed'], 3)
            for key, record in ai_daily.load_records(Path(td)).items():
                self.assertEqual(key, record['analysis']['app_key'])

    def test_detail_skip_and_cooldown(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            key = ai_daily.choose_candidates(snapshot(), {}, {}, {}, limit=2)[0]['app_key']
            def fetch(item):
                if item['app_key'] == key:
                    return 'short'
                return 'Long enough description to analyze and preserve. '*2
            report = ai_daily.run(home, snapshot=snapshot(), trends={},
                                  api_key='FAKE_SECRET', live=True, limit=2,
                                  fetch=fetch, invoke=responder, pause=lambda sec:None)
            self.assertEqual(report['details_skipped'], 1)
            self.assertEqual(report['analysed'], 2)
            errors = ai_daily.read_failures(home)
            self.assertEqual(errors[key]['retry_on'], '2026-10-29')
            self.assertNotIn(key, {x['app_key'] for x in
                ai_daily.choose_candidates(snapshot(), {}, ai_daily.load_records(home),
                                           errors, limit=5)})

    def test_overload_once_then_success_and_atomic(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            attempts = []
            def server(payload, key):
                attempts.append(1)
                if len(attempts) == 1:
                    raise RuntimeError('GEMINI_HTTP_503')
                return responder(payload, key)
            report = ai_daily.run(home, snapshot=snapshot(), trends={},
                                  api_key='FAKE_SECRET', live=True, limit=5,
                                  fetch=lambda i:'Long enough store description. '*2,
                                  invoke=server, pause=lambda sec:None)
            self.assertEqual(len(attempts), 2)
            self.assertEqual(report['requests'], 2)
            self.assertEqual(report['analysed'], 5)

    def test_invalid_json_response_does_not_store(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            def mismatched(payload, key):
                return {'items': [sample_detailed_result('google:wrong')]}, {}
            report = ai_daily.run(home, snapshot=snapshot(), trends={},
                                  api_key='FAKE_SECRET', live=True, limit=5,
                                  fetch=lambda i:'Long enough store description. '*2,
                                  invoke=mismatched, pause=lambda sec:None)
            self.assertEqual(report['analysed'], 0)
            self.assertEqual(report['stopped_by_error'], 'ValueError')
            self.assertEqual(len(ai_daily.load_records(home)), 0)

    def test_later_batch_error_keeps_earlier_batch(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            calls = []
            def fn(payload, key):
                calls.append(1)
                if len(calls) == 1:
                    return responder_for_test(2)(payload, key)
                raise RuntimeError('GEMINI_HTTP_503')
            report = ai_daily.run(home, snapshot=snapshot(), trends={},
                                  api_key='FAKE_SECRET', live=True, limit=5, batch_size=2,
                                  fetch=lambda i:'Long enough store description. '*2,
                                  invoke=fn, pause=lambda sec:None)
            self.assertEqual(report['analysed'], 2)
            self.assertEqual(len(ai_daily.load_records(home)), 2)
            self.assertEqual(report['stopped_by_error'], 'GEMINI_HTTP_503')

    def test_corrupted_shard_refuses_to_overwrite(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            file = home / 'data/ai/items/00.json'
            file.parent.mkdir(parents=True)
            file.write_text('{"schema_version": 1, "items": "wrong"}',encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'AI_STORE_INVALID_SHARD'):
                ai_daily.load_records(home)

    def test_imports_old_baseline_only_without_api(self):
        with TemporaryDirectory() as td:
            home = Path(td)
            stage = home / 'data/staging'
            stage.mkdir(parents=True)
            old = {'schema_version':2, 'mode':'live','model':'gemini-3.1-flash-lite',
                   'generated_at':'2026-10-22T20:00:00+09:00',
                   'input_apps':[{'app_key':'apple:1','name':'A','source':'apple','country':'KR',
                                  'category':'game_puzzle','detail_url':'https://example.com/a',
                                  'data_date':'2026-10-22'}],
                   'items':[sample_detailed_result('apple:1')]}
            (stage/'ai_probe.json').write_text(json.dumps(old), encoding='utf-8')
            baseline = {**old, 'input_apps':[dict(old['input_apps'][0],app_key='google:2')],
                        'items':[sample_detailed_result('google:2')], 'prompt_version':'v2'}
            revised = {**baseline, 'prompt_version':'v2.1'}
            compare = {'source_descriptions':[{'app_key':'google:2','description':'Original text.'}],
                       'baseline_v2':baseline,'revised_v2_1':revised}
            (stage/'ai_compare.json').write_text(json.dumps(compare), encoding='utf-8')
            first = ai_daily.import_existing(home)
            self.assertEqual(first['imported'], 2)
            self.assertEqual(ai_daily.load_records(home)['google:2']['source_description'], 'Original text.')
            second = ai_daily.import_existing(home)
            self.assertEqual(second['imported'], 0)


def responder_for_test(number):
    # Response is computed from the actual payload in the mock helper.
    def fake(payload, key):
        items = json.loads(payload['contents'][0]['parts'][0]['text'].split('\n')[-1])
        assert len(items) == number
        return {'items':[sample_detailed_result(x['app_key']) for x in items]}, {}
    return fake


if __name__ == '__main__':
    unittest.main()
