"""Development pipeline tests use synthetic saved AI results, never live APIs."""
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import ai_daily
import develop_daily as dev

DAY = '2026-10-24'


def setup_fixture(root: Path):
    ai_rows=[]
    store_groups=[]
    identities=[]
    for source,key,name,developer in (
        ('apple','apple:app1','Original Game','Studio (Apps)'),
        ('google','google:game1','Original Game','Studio'),
        ('itch','itch:game2','Small Puzzle','Solo Studio'),
        ('apple','apple:app3','Wellness App','Indie Soft'),
    ):
        record={'app_key':key,'source':source,'name':name,'developer':developer,
                'kind':'game' if source != 'apple' else 'app',
                'detail_url':f'https://example.org/{key}', 'data_date': DAY,
                'source_description':'A plain store description of the game. '*5,
                'analysis':{'summary_ko':'앱 정보','features_ko':['주요 기능'],
                    'difficulty_ko':{'level':'쉬움','reason':'작은 규모'},
                    'solo_mvp_ko':{'must_have':['기능 하나'], 'defer':[], 'risks':['리스크']},
                    'source_limitations_ko':'확인되지 않음'},
                'selection':{'best_rank':1,'reasons':['newly_seen']},
                'analysed_at':'2026-10-24T01:00:00+09:00'}
        ai_rows.append(record)
        identities.append({'app_key':key,'source':source,'name':name,'developer':developer})
        store_groups.append({'source':source, 'country':'JP','category':'game_puzzle',
                             'data_date':DAY,'items':[{'app_key':key,'name':name,'developer':developer}]})
    ai_daily.write_records(root,ai_rows,{})
    (root/'data/web').mkdir(parents=True)
    (root/'data/lab').mkdir(parents=True)
    (root/'data/web/latest.json').write_text(json.dumps({'data_date':DAY,'groups':store_groups}))
    (root/'data/lab/index.json').write_text(json.dumps({'schema_version':1,'items':identities}))
    return ai_rows


def respond(payload, key):
    assert key == 'FAKE'
    raw=json.loads(payload['contents'][0]['parts'][0]['text'].split('입력 자료(JSON):\n')[-1])
    props=payload['generationConfig']['responseFormat']['text']['schema']['properties']['items']['items']['properties']
    rows=[]
    for item in raw:
        output={k:([f'구체적 제안: {k}'] if v['type']=='array' else f'분석 근거가 제한된 제안: {k}')
                for k,v in props.items()}
        output['app_key']=item['app_key']
        rows.append(output)
    return {'items':rows}


class DevelopmentTests(unittest.TestCase):
    def test_3_5_pipeline_dedupes_stores_and_resumes_without_new_requests(self):
        with TemporaryDirectory() as td:
            root=Path(td);setup_fixture(root)
            fn=Mock(side_effect=respond)
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                first=dev.run(root,live=True,api_key='FAKE',brief_limit=3,plan_limit=5,
                              invoke=fn,pause=lambda n:None,run_day=DAY)
                self.assertEqual(first['new_briefs'],3)  # four first-pass app IDs, three unique products
                self.assertEqual(first['new_plans'],3)
                self.assertEqual(first['requests'],4)  # 1 batch of briefs, 3 standalone plans
                self.assertEqual(fn.call_count,4)
                stored=dev.read_records(root)
                self.assertEqual(len(stored),3)
                self.assertFalse('apple:app1' in stored and 'google:game1' in stored)
                self.assertEqual(sum('plan' in x for x in stored.values()),3)
                index=json.loads((root/dev.INDEX).read_text(encoding='utf-8'))
                self.assertEqual(index['brief_count'],3)
                self.assertEqual(index['plan_count'],3)
                self.assertEqual(len(index['items']),3)
                for item in index['items']:
                    self.assertTrue((root/dev.SHARDS/(item['shard']+'.json')).exists())
                again=dev.run(root,live=True,api_key='FAKE',brief_limit=3,plan_limit=5,
                              invoke=fn,pause=lambda n:None,run_day=DAY)
                self.assertEqual(again['requests'],0)
                self.assertEqual(fn.call_count,4)
                self.assertEqual(ai_daily.read_request_usage(root,dev.MODEL,'2026-10-23'),4)
                self.assertEqual(len(ai_daily.load_records(root)),4)  # original first-pass results untouched

    def test_invalid_or_mismatched_batch_saves_nothing(self):
        with TemporaryDirectory() as td:
            root=Path(td);setup_fixture(root)
            wrong=Mock(return_value={'items':[{'app_key':'wrong'}]})
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                result=dev.run(root,live=True,api_key='FAKE',brief_limit=3,plan_limit=0,
                               invoke=wrong,pause=lambda _:None,run_day=DAY)
            self.assertEqual(result['stopped_by_error'],'')
            self.assertEqual(len(result['failed_batches']),1)
            self.assertEqual(result['requests'],3)
            self.assertEqual(result['new_briefs'],0)
            self.assertFalse(dev.read_records(root))
            self.assertEqual(ai_daily.read_request_usage(root,dev.MODEL,'2026-10-23'),3)

    def test_brief_failure_continues_to_next_batch(self):
        with TemporaryDirectory() as td:
            root=Path(td); setup_fixture(root)
            more=[]
            for i in range(9):
                more.append({'app_key':f'itch:extra{i}', 'source':'itch', 'name':f'Extra Game {i}',
                             'developer':f'Studio {i}', 'source_description':'Description'*12,
                             'analysis':{'summary_ko':'기능', 'difficulty_ko':{'level':'쉬움'}},
                             'analysed_at':'2026-10-24T01:00:00+09:00', 'data_date':DAY})
            ai_daily.write_records(root, more, ai_daily.load_records(root))
            counter=[]
            def fake(payload, key):
                counter.append(1)
                if len(counter)<=3: return {'items':[{'app_key':'wrong'}]}
                return respond(payload,key)
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                result=dev.run(root,live=True,api_key='FAKE',brief_limit=10,plan_limit=0,
                               invoke=fake,pause=lambda _:None,run_day=DAY)
            self.assertEqual(result['new_briefs'],5)
            self.assertEqual(result['requests'],4)
            self.assertEqual(len(result['failed_batches']),1)
            self.assertEqual(result['stopped_by_error'],'')

    def test_3_5_quota_error_does_not_retry(self):
        with TemporaryDirectory() as td:
            root=Path(td); setup_fixture(root)
            fn=Mock(side_effect=RuntimeError('GEMINI_HTTP_429'))
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                result=dev.run(root,live=True,api_key='FAKE',brief_limit=3,plan_limit=0,
                               invoke=fn,pause=lambda _:None,run_day=DAY)
            self.assertEqual(result['requests'],1)
            self.assertEqual(fn.call_count,1)
            self.assertEqual(result['stopped_by_error'],'RuntimeError')

    def test_preview_never_calls_api_or_changes_files(self):
        with TemporaryDirectory() as td:
            root=Path(td);setup_fixture(root)
            fn=Mock(side_effect=AssertionError('DO_NOT_CALL'))
            result=dev.run(root,live=False,invoke=fn,run_day=DAY)
            self.assertEqual(len(result['candidate_briefs']),3)
            fn.assert_not_called()
            self.assertFalse((root/dev.INDEX).exists())

    def test_request_cap_uses_pacific_day_and_is_model_specific(self):
        with TemporaryDirectory() as td:
            root=Path(td)
            for _ in range(2):
                ai_daily.use_request(root,dev.MODEL,'2026-10-23')
            self.assertEqual(ai_daily.read_request_usage(root,dev.MODEL,'2026-10-23'),2)
            self.assertEqual(ai_daily.read_request_usage(root,ai_daily.ai_probe.MODEL,'2026-10-23'),0)
            self.assertEqual(ai_daily.read_request_usage(root,dev.MODEL,'2026-10-24'),0)
            (root/ai_daily.REQUEST_USAGE).write_text('{"schema_version":1,"days":{"2026-10-23":{"gemini-3.5-flash-lite":450}}}')
            with self.assertRaisesRegex(RuntimeError,'GEMINI_LOCAL_REQUEST_LIMIT'):
                ai_daily.use_request(root,dev.MODEL,'2026-10-23')


if __name__=='__main__':
    unittest.main()
