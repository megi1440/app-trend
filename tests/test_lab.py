"""Regression tests for the public read-only Idea Lab index."""
import csv
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

FILE = Path(__file__).resolve().parents[1] / 'collector/build_lab.py'
spec = importlib.util.spec_from_file_location('build_lab', FILE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def put_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')


def put_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8', newline='') as out:
        w = csv.DictWriter(out, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


class LabIndexTests(unittest.TestCase):
    def test_shard_matches_gemini_collector(self):
        from collector.ai_daily import shard_name
        for key in ('apple:1234', 'google:com.example.game', 'itch:7b8e3'):
            self.assertEqual(mod.ai_shard(key) + '.json', shard_name(key))

    def test_tags_only_from_ai_content(self):
        self.assertEqual(mod.features_to_tags({}), [])
        self.assertIn('수집·인벤토리', mod.features_to_tags({'systems_ko':['인벤토리 관리 시스템']}))
        self.assertNotIn('카드·덱', mod.features_to_tags({'summary_ko':'카드 배틀 게임입니다.'}))

    def test_unbounded_data_driven_tags_with_traceable_evidence(self):
        self.assertEqual(mod.features_to_tags({'summary_ko': '물리 엔진이 좋습니다.'}), [])
        self.assertNotIn('사격·전투', mod.features_to_tags({'features_ko': ['전투가 없는 평화로운 농장 게임']}))
        self.assertNotIn('사격·전투', mod.features_to_tags({'features_ko': ['전투 시스템이 없는 게임']}))
        self.assertEqual(mod.features_to_tags({'systems_ko': ['UI 인터페이스', '데이터 관리 시스템']}), [])
        analysis = {'features_ko':['리듬 액션 기능을 제공합니다.'],
                    'systems_ko':['물리 엔진 충돌 및 파괴 시스템', '이미지 유사도 분석 알고리즘', '인벤토리 관리 시스템']}
        tags, origins = mod.feature_tags_with_evidence(analysis)
        self.assertIn('리듬 액션', tags)
        self.assertIn('물리 엔진 충돌 및 파괴', tags)
        self.assertIn('이미지 유사도 분석', tags)
        self.assertIn('수집·인벤토리', tags)
        for tag in tags:
            self.assertTrue(origins[tag])
            self.assertIn(origins[tag][0]['field'], ['features_ko', 'systems_ko'])
            self.assertTrue(origins[tag][0]['text'])
        # A growing catalog must not be limited by the initial known aliases.
        new_systems = [f'맞춤 기능 구성 {n} 시스템' for n in range(140)]
        new_tags, new_origins = mod.feature_tags_with_evidence({'systems_ko':new_systems})
        self.assertEqual(len(new_tags), 140)
        self.assertEqual(len(new_origins), 140)
        self.assertEqual(mod.features_to_tags({'systems_ko':new_systems}), new_tags)

    def test_family_expansion_and_safe_synonyms(self):
        self.assertEqual(mod.canonical_tag('개인화된 추천'), '개인화 추천')
        self.assertEqual(mod.canonical_tag('실시간 멀티플레이어 동기화'), '멀티플레이어 동기화')
        self.assertNotEqual(mod.canonical_tag('물리 충돌'), mod.canonical_tag('물리 파괴'))
        self.assertEqual(mod.feature_family('멀티플레이어 동기화'), '네트워크·소셜')
        self.assertEqual(mod.feature_family('사용자 인증·보안'), '데이터·저장·보안')
        self.assertEqual(mod.feature_family('완전히 새로운 미지의 요소 xyz'), '새로 발견된 기능')
        # A family is a navigation aid, never an allow-list. Novel names survive.
        new_tags, origin = mod.feature_tags_with_evidence({'systems_ko':['신규 홀로그램 장치 구성 시스템']})
        self.assertEqual(new_tags, ['신규 홀로그램 장치 구성'])
        self.assertEqual(mod.feature_family(new_tags[0]), '새로 발견된 기능')
        self.assertTrue(origin[new_tags[0]])
        tags, proof = mod.feature_tags_with_evidence({'systems_ko':['개인화된 추천 시스템', '개인화 추천 시스템']})
        self.assertEqual(tags, ['개인화 추천'])
        self.assertEqual(len(proof['개인화 추천']), 2)

    def test_canonical_icon_fallback_when_itch_feed_omits_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            key = 'itch:has-an-image'
            put_json(root/'data/web/latest.json', {'data_date':'2026-10-24', 'groups':[
                {'source':'itch', 'country':'GLOBAL', 'feed':'new', 'data_date':'2026-10-24',
                 'is_stale':False, 'items':[{'app_key':key, 'name':'Illustrated Game', 'kind':'game',
                    'icon_url':'', 'position':1}]}]})
            put_json(root/'data/web/trends.json', {'candidates':[]})
            put_csv(root/'data/apps.csv', ['app_key', 'kind', 'icon_url', 'developer', 'detail_url'],
                    [{'app_key':key, 'kind':'game', 'developer':'Source Author',
                      'icon_url':'https://img.itch.zone/real-cover.png',
                      'detail_url':'https://example.itch.io/illustrated-game'}])
            mod.build(root)
            index = json.loads((root/'data/lab/index.json').read_text(encoding='utf-8'))
            item = next(i for i in index['items'] if i['app_key'] == key)
            self.assertEqual(item['icon_url'], 'https://img.itch.zone/real-cover.png')
            self.assertEqual(item['developer'], 'Source Author')
            self.assertEqual(item['kind'], 'game')
            # A newer image from a chart is preferred to the archived icon.
            latest = json.loads((root/'data/web/latest.json').read_text(encoding='utf-8'))
            latest['groups'][0]['items'][0]['icon_url'] = 'https://example.com/new-cover.png'
            put_json(root/'data/web/latest.json', latest)
            mod.build(root)
            newer = json.loads((root/'data/lab/index.json').read_text(encoding='utf-8'))
            self.assertEqual(newer['items'][0]['icon_url'], 'https://example.com/new-cover.png')

    def test_generated_index_contains_new_tags_without_fake_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            key='google:com.example.dynamic'
            put_json(root/'data/web/latest.json',{'data_date':'2026-10-23','groups':[
              {'source':'google','country':'KR','chart':'top_free','category':'game_puzzle',
               'data_date':'2026-10-23','is_stale':False,'items':[{'app_key':key,'name':'Puzzle','rank':7,'kind':'game'}]}]})
            put_json(root/'data/web/trends.json',{'candidates':[]})
            shard=mod.ai_shard(key)
            put_json(root/f'data/ai/items/{shard}.json',{'items':{key:{'app_key':key,'source':'google',
              'analysis':{'features_ko':['리듬 액션 기능을 지원합니다.'], 'systems_ko':['물리 엔진 충돌 및 파괴 시스템']}}}})
            mod.build(root)
            output=json.loads((root/'data/lab/index.json').read_text(encoding='utf-8'))
            rec=next(i for i in output['items'] if i['app_key']==key)
            self.assertEqual(rec['has_ai'], True)
            self.assertIn('리듬 액션',rec['tags'])
            self.assertIn('물리 엔진 충돌 및 파괴',rec['tags'])
            self.assertEqual(rec['tag_evidence']['리듬 액션'][0]['field'],'features_ko')
            self.assertTrue(rec['tag_evidence']['물리 엔진 충돌 및 파괴'][0]['text'].endswith('시스템'))
            self.assertNotIn('selection',rec)

    def test_true_stale_and_country_signals_and_historical_itch(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            key = 'google:example.puzzle'
            latest = {'data_date':'2026-10-23','groups':[
                {'source':'google','country':'US','chart':'top_free','category':'game_puzzle',
                 'data_date':'2026-10-23','is_stale':False,'items':[
                    {'app_key':key,'name':'Original Puzzle','kind':'game','rank':7,'first_seen':'2026-10-22'}]},
                {'source':'google','country':'JP','chart':'top_free','category':'game_puzzle',
                 'data_date':'2026-10-23','is_stale':False,'items':[
                    {'app_key':key,'name':'Original Puzzle','kind':'game','rank':9}]},
                {'source':'apple','country':'KR','chart':'top_free','category':'all_apps',
                 'data_date':'2026-10-22','is_stale':True,'items':[
                    {'app_key':'apple:stale','name':'Old app','kind':'app','rank':3}]}
            ]}
            put_json(root/'data/web/latest.json',latest)
            put_json(root/'data/web/trends.json',{'candidates':[
                {'app_key':'apple:stale','reason_code':'newly_seen',
                 'source_data_dates':['2026-10-23'], 'evidence':{'first_seen':'2026-10-23'}},
                {'app_key':key,'reason_code':'newly_seen',
                 'source_data_dates':['2026-10-23'], 'evidence':{'first_seen':'2026-10-22'}}
            ]})
            fields = ['date','source','country','chart','category','rank','app_key']
            put_csv(root/'data/rankings/2026/10/2026-10-22.csv',fields,[
                {'date':'2026-10-22','source':'google','country':'US','chart':'top_free',
                 'category':'game_puzzle','rank':28,'app_key':key}])
            put_csv(root/'data/rankings/2026/10/2026-10-23.csv',fields,[
                {'date':'2026-10-23','source':'google','country':'US','chart':'top_free',
                 'category':'game_puzzle','rank':7,'app_key':key}])
            put_csv(root/'data/discoveries/2026/10/2026-10-22.csv',
                ['date','feed','position','app_key'],[
                    {'date':'2026-10-22','feed':'new','position':2,'app_key':'itch:game'}])
            mod.build(root)
            produced=json.loads((root/'data/lab/index.json').read_text('utf-8'))
            by_key={e['app_key']:e for e in produced['items']}
            self.assertNotIn('newly_seen',[s['reason_code'] for s in by_key['apple:stale']['signals']])
            good=by_key[key]
            self.assertIn('multi_country',[s['reason_code'] for s in good['signals']])
            rise=next(s for s in good['signals'] if s['reason_code']=='rising_7d')
            self.assertEqual((rise['evidence']['before_rank'],rise['evidence']['after_rank']), (28,7))
            self.assertEqual(rise['source_data_dates'],['2026-10-22','2026-10-23'])
            self.assertEqual(good['tags'],[])
            self.assertNotIn('selection',good)
            indie=json.loads((root/'data/lab/indie_history.json').read_text('utf-8'))
            self.assertEqual(indie['itch:game'][0]['position'],2)

    def test_previous_chart_departures_remain_real_90_day_candidates(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            put_json(root/'data/web/latest.json', {'data_date':'2026-10-23','groups':[
              {'source':'google','country':'US','chart':'top_free','category':'game_puzzle',
               'data_date':'2026-10-23','is_stale':False,'items':[
                {'app_key':'google:current','name':'Current','kind':'game','rank':2}]}]})
            put_json(root/'data/web/trends.json', {'candidates':[]})
            put_csv(root/'data/apps.csv', ['app_key','source','kind','detail_url','first_seen','primary_category'],[
              {'app_key':'google:old','source':'google','kind':'game','detail_url':'https://example.org/old',
               'first_seen':'2026-10-01','primary_category':'게임'}])
            put_csv(root/'data/app_locales.csv',['app_key','country','name'],[
              {'app_key':'google:old','country':'JP','name':'지난달 게임'}])
            columns=['date','source','country','chart','category','rank','app_key']
            put_csv(root/'data/rankings/2026/10/2026-10-10.csv',columns,[
              {'date':'2026-10-10','source':'google','country':'JP','chart':'top_free',
               'category':'game_puzzle','rank':9,'app_key':'google:old'}])
            # Data outside 90 days is not treated as a current candidate.
            put_csv(root/'data/rankings/2026/06/2026-06-01.csv',columns,[
              {'date':'2026-06-01','source':'google','country':'JP','chart':'top_free',
               'category':'game_puzzle','rank':1,'app_key':'google:too-old'}])
            mod.build(root)
            data=json.loads((root/'data/lab/index.json').read_text(encoding='utf-8'))
            by_key={x['app_key']:x for x in data['items']}
            self.assertEqual(by_key['google:old']['name'],'지난달 게임')
            self.assertTrue(by_key['google:old']['observations'][0]['historical'])
            self.assertEqual(by_key['google:old']['observations'][0]['date'],'2026-10-10')
            self.assertEqual(by_key['google:old']['observations'][0]['rank'],9)
            self.assertNotIn('google:too-old',by_key)
            self.assertNotIn('historical',by_key['google:current']['observations'][0])

    def test_tag_classification_does_not_match_style_as_tile(self):
        self.assertNotEqual(mod.feature_family('스타일별 상품 추천'),'퍼즐·규칙·카드')
        self.assertEqual(mod.feature_family('타일 배치'),'퍼즐·규칙·카드')

    def test_ai_shard_loss_preserves_last_published_index(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            put_json(root/'data/web/latest.json', {'data_date':'2026-10-23','groups':[]})
            put_json(root/'data/web/trends.json',{'candidates':[]})
            original={'schema_version':1,'ai_count':5,'items':[]}
            put_json(root/'data/lab/index.json',original)
            put_json(root/'data/ai/items/00.json',{'items':{}})
            with self.assertRaisesRegex(RuntimeError,'AI 레코드'):
                mod.build(root)
            self.assertEqual(json.loads((root/'data/lab/index.json').read_text('utf-8')),original)

    def test_only_verified_apple_release_is_publishable(self):
        self.assertEqual(mod.verified_apple_release('apple','2026-10-01','2026-10-23'),'2026-10-01')
        self.assertEqual(mod.verified_apple_release('google','2026-10-01','2026-10-23'),'')
        self.assertEqual(mod.verified_apple_release('itch','2026-10-01','2026-10-23'),'')
        for value in ('', '2026-13-01', '2026-10-24', '2026-10-01T00:00:00Z', '2026-10-01 (업데이트)'):
            self.assertEqual(mod.verified_apple_release('apple',value,'2026-10-23'),'')

    def test_release_dates_are_forwarded_only_for_apple_and_historical_apple(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            put_json(root/'data/web/latest.json',{'data_date':'2026-10-23','groups':[
                {'source':'apple','country':'KR','chart':'top_free','category':'all_apps','data_date':'2026-10-23','items':[
                    {'app_key':'apple:latest','name':'Apple Latest','release_date':'2026-10-03','rank':4,'kind':'app'}]},
                {'source':'google','country':'US','chart':'top_free','category':'game_puzzle','data_date':'2026-10-23','items':[
                    {'app_key':'google:com.fake','name':'Google','release_date':'2026-10-05','rank':2,'kind':'game'}]},
                {'source':'itch','country':'GLOBAL','feed':'new','data_date':'2026-10-23','items':[
                    {'app_key':'itch:fake','name':'itch','release_date':'2026-10-10','position':1,'kind':'game'}]}
            ]})
            put_json(root/'data/web/trends.json',{'candidates':[]})
            put_csv(root/'data/apps.csv',['app_key','source','kind','first_seen','release_date'],[
                {'app_key':'apple:latest','source':'apple','kind':'app','release_date':'2026-10-03'},
                {'app_key':'apple:old','source':'apple','kind':'game','release_date':'2026-09-10'},
                {'app_key':'google:com.fake','source':'google','kind':'game','release_date':'2026-10-05'}])
            put_csv(root/'data/rankings/2026/10/2026-10-10.csv',
                    ['date','source','country','chart','category','rank','app_key'],[
                {'date':'2026-10-10','source':'apple','country':'KR','chart':'top_free','category':'all_games',
                 'rank':18,'app_key':'apple:old'}])
            mod.build(root)
            rows={i['app_key']:i for i in json.loads((root/'data/lab/index.json').read_text('utf-8'))['items']}
            self.assertEqual(rows['apple:latest']['release_date'],'2026-10-03')
            self.assertEqual(rows['apple:old']['release_date'],'2026-09-10')
            self.assertEqual(rows['google:com.fake']['release_date'],'')
            self.assertEqual(rows['itch:fake']['release_date'],'')

    def test_sentence_fragments_are_not_feature_names(self):
        candidate=mod.features_to_tags({'features_ko':[
            '웹사이트 전체를 클릭 한 번으로 번역하는 기능을 제공합니다.',
            '음성으로 노래를 흥얼거려 곡명을 찾는 기능을 제공합니다.']})
        self.assertNotIn('웹사이트 전체를 클릭 한 번으로 번역하는',candidate)
        self.assertNotIn('음성으로 노래를 흥얼거려 곡명을 찾는',candidate)
        # Concrete emerging systems remain searchable without fixed allow-list.
        self.assertIn('신규 홀로그램 장치 구성',mod.features_to_tags({'systems_ko':['신규 홀로그램 장치 구성 시스템']}))


if __name__ == '__main__':
    unittest.main()
