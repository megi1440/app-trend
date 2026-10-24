"""V1.31 High pair pipeline uses synthetic AI data and no remote Gemini calls."""
import csv
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import ai_daily
import ai_probe
import develop_daily as dev

DAY='2026-10-24'

def fixture(root):
    rows=[]
    info=[('apple','apple:app1','Original Game','Studio (Apps)','game'),
          ('google','google:game1','Original Game','Studio','game'),
          ('itch','itch:game2','Small Puzzle','Solo Studio','game'),
          ('apple','apple:app3','Wellness App','Indie Soft','app')]
    groups=[]
    for source,key,name,developer,kind in info:
        rows.append({'app_key':key,'source':source,'name':name,'developer':developer,
                     'category': 'game_puzzle' if kind=='game' else 'app_lifestyle',
                     'detail_url':'https://example.org/'+key, 'data_date':DAY,
                     'source_description':'Store description for the product. '*8,
                     'analysis':{'summary_ko':'기능','features_ko':['주요 기능'],
                                 'difficulty_ko':{'level':'쉬움','reason':'작은 규모'}},
                     'selection':{'best_rank':1,'reasons':['newly_seen']}})
        groups.append({'source':source,'country':'JP','category':'game_puzzle','data_date':DAY,
                       'items':[{'app_key':key,'name':name,'developer':developer}]})
    ai_daily.write_records(root, rows,{})
    (root/'data/web').mkdir(parents=True,exist_ok=True)
    (root/'data/web/latest.json').write_text(json.dumps({'data_date':DAY,'groups':groups}))
    with (root/'data/apps.csv').open('w',newline='',encoding='utf-8') as f:
        writer=csv.DictWriter(f,fieldnames=['app_key','kind']);writer.writeheader()
        for _,key,_,_,kind in info:writer.writerow({'app_key':key,'kind':kind})
    return rows

def fake_output(payload,key):
    assert key=='FAKE'
    stage='brief' if '개발 검토서' in payload['contents'][0]['parts'][0]['text'][:120] else 'plan'
    ctx=json.loads(payload['contents'][0]['parts'][0]['text'].split('입력 자료(JSON):\n')[-1])
    schema=payload['generationConfig']['responseFormat']['text']['schema']['properties']['items']['items']
    def make(spec, field=''):
        if spec.get('enum'):return spec['enum'][0]
        t=spec['type']
        if t=='string':return '새로운 신작 기획' if field=='title_ko' else f'내용: {field}'
        if t=='integer':return 1
        if t=='array':return [make(spec['items'], field)]
        if t=='object':return {k:make(v,k) for k,v in spec['properties'].items()}
    row=make(schema)
    row['app_key']=ctx['source']['app_key'];row['product_kind']=ctx['source']['product_kind_from_catalog']
    if stage=='brief':
        row['new_concepts_ko']=[dict(row['new_concepts_ko'][0],title_ko=f'기획 {n}') for n in (1,2,3)]
    else:
        row['selected_concept_title_ko']=ctx['selected_concept']['title_ko']
    return {'items':[row], '_usageMetadata':{'totalTokenCount':100}}

class DevelopmentTests(unittest.TestCase):
    def test_pairs_and_resume_and_kind_catalog(self):
        with TemporaryDirectory() as td:
            root=Path(td);fixture(root);fn=Mock(side_effect=fake_output)
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                first=dev.run(root,live=True,api_key='FAKE',invoke=fn,pause=lambda x:None,run_day=DAY)
                self.assertEqual(first['new_briefs'],3)
                self.assertEqual(first['new_plans'],3)
                self.assertEqual(first['requests'],6)
                self.assertEqual(first['total_tokens'],600)
                self.assertEqual(len(dev.read_records(root)),3)
                self.assertEqual({r['kind'] for r in dev.read_records(root).values()},{'game','app'})
                idx=json.loads((root/dev.INDEX).read_text())
                self.assertEqual(idx['schema_version'],2)
                self.assertEqual(idx['brief_count'],3)
                self.assertEqual(idx['plan_count'],3)
                self.assertEqual(idx['pending_briefs'],0)
                self.assertEqual(len(idx['items']),3)
                second=dev.run(root,live=True,api_key='FAKE',invoke=fn,pause=lambda x:None,run_day=DAY)
                self.assertEqual(second['requests'],0)
                self.assertEqual(fn.call_count,6)
                self.assertEqual(len(ai_daily.load_records(root)),4)

    def test_mid_pair_failure_resumes_plan_without_rebrief(self):
        with TemporaryDirectory() as td:
            root=Path(td);fixture(root)
            counter=[0]
            def invoke(payload,key):
                counter[0]+=1
                if counter[0] in (2,3,4):raise RuntimeError('GEMINI_HTTP_503')
                return fake_output(payload,key)
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                a=dev.run(root,live=True,api_key='FAKE',invoke=invoke,pause=lambda _:None,run_day=DAY,limit=1)
                self.assertEqual(a['new_briefs'],1)
                self.assertEqual(a['new_plans'],0)
                self.assertEqual(a['requests'],4)
                self.assertEqual(json.loads((root/dev.INDEX).read_text())['items'],[])
                b=dev.run(root,live=True,api_key='FAKE',invoke=invoke,pause=lambda _:None,run_day='2026-10-25',limit=1)
                self.assertEqual(b['new_briefs'],0)
                self.assertEqual(b['new_plans'],1)
                self.assertEqual(b['requests'],1)
                self.assertEqual(len(json.loads((root/dev.INDEX).read_text())['items']),1)

    def test_429_stops_once_and_preserves_done(self):
        with TemporaryDirectory() as td:
            root=Path(td);fixture(root)
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                a=dev.run(root,live=True,api_key='FAKE',invoke=Mock(side_effect=RuntimeError('GEMINI_HTTP_429')),
                          pause=lambda _:None,run_day=DAY)
            self.assertEqual(a['requests'],1)
            self.assertEqual(a['stopped_by_error'],'GEMINI_HTTP_429')
            self.assertFalse(dev.read_records(root))

    def test_v1_legacy_data_removed_only_during_live_run(self):
        with TemporaryDirectory() as td:
            root=Path(td);fixture(root)
            p=root/dev.INDEX;p.parent.mkdir(parents=True,exist_ok=True)
            p.write_text(json.dumps({'schema_version':1,'items':[],'brief_count':30,'plan_count':5}))
            old=root/dev.SHARDS/'00.json';old.parent.mkdir(parents=True,exist_ok=True)
            old.write_text(json.dumps({'schema_version':1,'items':{}}))
            a=dev.run(root,live=False,run_day=DAY)
            self.assertTrue(old.exists());self.assertEqual(a['mode'],'preview')
            with patch.object(ai_daily,'pacific_day',return_value='2026-10-23'):
                dev.run(root,live=True,api_key='FAKE',limit=1,invoke=fake_output,pause=lambda _:None,run_day=DAY)
            self.assertFalse(old.exists())
            self.assertEqual(json.loads(p.read_text())['schema_version'],2)
            self.assertEqual(len(ai_daily.load_records(root)),4)

    def test_request_cap_is_separate_for_two_models(self):
        with TemporaryDirectory() as td:
            root=Path(td)
            for _ in range(450):ai_daily.use_request(root,ai_probe.MODEL,'2026-10-23')
            with self.assertRaisesRegex(RuntimeError,'GEMINI_LOCAL_REQUEST_LIMIT'):
                ai_daily.use_request(root,ai_probe.MODEL,'2026-10-23')
            for _ in range(500):ai_daily.use_request(root,dev.MODEL,'2026-10-23',max_requests=500)
            with self.assertRaisesRegex(RuntimeError,'GEMINI_LOCAL_REQUEST_LIMIT'):
                ai_daily.use_request(root,dev.MODEL,'2026-10-23',max_requests=500)
            self.assertEqual(ai_daily.read_request_usage(root,dev.MODEL,'2026-10-23'),500)

if __name__=='__main__': unittest.main()
