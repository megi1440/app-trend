"""Cross-store AI de-dup must work across DIFFERENT observation days."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import ai_daily


def item(key, developer='HAYO', name='80億分の1 - 人生シミュレーター'):
    return {'app_key':key, 'source':key.split(':',1)[0], 'name':name,
            'developer':developer, 'rank':1,
            'detail_url':'https://example.com/'+key,
            'first_seen':'2026-10-22', 'kind':'game', 'description':'Game with evidence.'*4}


def snapshot(*items):
    return {'data_date':'2026-10-24', 'groups':[
        {'source':i['source'], 'country':'JP', 'category':'game_simulation',
         'chart':'top_free','data_date':'2026-10-24','is_stale':False,'items':[i]}
        for i in items]}


class HistoryDedupeTest(unittest.TestCase):
    def test_old_google_ai_skips_todays_apple_only(self):
        apple=item('apple:12',developer='HAYO (Apps)')
        google=item('google:game.hayo')
        today=snapshot(apple)
        queue=ai_daily.choose_candidates(today,{}, {'google:game.hayo':{}},{},
                                         limit=5,historical_items=[google])
        self.assertEqual(queue,[])
        # The actual run() path loads the existing index from disk.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'data/lab').mkdir(parents=True)
            (root/'data/lab/index.json').write_text(json.dumps({
                'schema_version':1,'items':[google]}),encoding='utf-8')
            old_record={'app_key':google['app_key'],'analysed_at':'2026-10-23T13:00:00+09:00'}
            ai_daily.write_records(root,[old_record],{})
            result=ai_daily.run(root,snapshot=today,trends={},run_day='2026-10-24')
            self.assertEqual(result['candidates'],[])
            self.assertEqual(result['already_analysed'],1)

    def test_reverse_and_unrelated_remain_eligible(self):
        apple=item('apple:12',developer='HAYO (Apps)')
        google=item('google:game.hayo')
        self.assertFalse(ai_daily.choose_candidates(snapshot(google),{},
          {'apple:12':{}},{},limit=5,historical_items=[apple]))
        other=item('google:another', developer='Different publisher')
        self.assertEqual(len(ai_daily.choose_candidates(snapshot(apple),{},
          {'google:game.hayo':{}},{},limit=5,historical_items=[other])),1)
        self.assertEqual(len(ai_daily.choose_candidates(snapshot(apple),{},
          {'apple:different':{}},{},limit=5,historical_items=[apple])),1)

    def test_missing_or_ambiguous_history_does_not_force_merge(self):
        apple=item('apple:12',developer='HAYO (Apps)')
        google=item('google:game.hayo')
        third=item('google:another')
        self.assertFalse(ai_daily.cross_store_pairs(snapshot(apple),[google,third]))
        self.assertEqual(len(ai_daily.choose_candidates(snapshot(apple),{},
          {'google:game.hayo':{}},{},limit=5,historical_items=[google,third])),1)
        self.assertFalse(ai_daily.cross_store_pairs(snapshot(apple),[
            item('google:game.hayo',developer='')]))


if __name__=='__main__': unittest.main()
