"""Historical unanalysed chart items remain eligible without forged release dates."""
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'collector'))
import ai_daily

class BacklogTests(unittest.TestCase):
    def test_previous_observed_not_new_release_and_existing_skipped(self):
        old={'app_key':'apple:old','source':'apple','kind':'app','name':'Old App',
             'developer':'Maker','detail_url':'https://example.com/old','description':'Original',
             'observations':[{'source':'apple','country':'JP','category':'app_lifestyle',
                              'date':'2026-10-22','rank':12,'historical':True}]}
        today={'data_date':'2026-10-24','groups':[]}
        result=ai_daily.choose_candidates(today,{}, {}, {},limit=5,historical_items=[old])
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['priority_reasons'],['previously_observed'])
        self.assertEqual(result[0]['data_date'],'2026-10-22')
        self.assertEqual(result[0]['country'],'JP')
        self.assertEqual(ai_daily.choose_candidates(today,{}, {'apple:old':{}}, {},
                         limit=5,historical_items=[old]),[])
    def test_historical_backlog_does_not_duplicate_fresh_key(self):
        row={'app_key':'apple:new','name':'Current','developer':'Dev',
             'detail_url':'https://example.org/a','rank':1,'first_seen':'2026-10-24'}
        snapshot={'data_date':'2026-10-24','groups':[{'source':'apple','country':'JP',
                  'category':'app_lifestyle','data_date':'2026-10-24','items':[row]}]}
        historical=[{'app_key':'apple:new','source':'apple','name':'Current','developer':'Dev',
          'detail_url':'https://example.org/a','observations':[{'date':'2026-10-23','country':'JP'}]}]
        result=ai_daily.choose_candidates(snapshot,{}, {}, {},limit=5,historical_items=historical)
        self.assertEqual(len(result),1)
        self.assertNotEqual(result[0]['priority_reasons'],['previously_observed'])
