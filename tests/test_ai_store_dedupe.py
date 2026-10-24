"""One same-title, same-developer app must not consume twice the AI allowance."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'collector'))
import ai_daily


def make_app(key, name='80億分の1 - 人生シミュレーター', developer='HAYO'):
    return {'app_key': key, 'name': name, 'developer': developer,
            'detail_url': f'https://example.org/{key}', 'kind':'game',
            'rank': 2, 'first_seen':'2026-10-24',
            'description':'An app with useful features.'*3}


def snapshot(*items):
    groups=[]
    for item in items:
        source=item['app_key'].split(':',1)[0]
        groups.append({'source':source,'country':'JP','chart':'top_free',
                       'category':'game_simulation', 'data_date':'2026-10-24',
                       'is_stale':False,'items':[item]})
    return {'data_date':'2026-10-24','groups':groups}


class StoreDedupTests(unittest.TestCase):
    def test_cross_store_pair_only_one_ai_candidate(self):
        data=snapshot(make_app('apple:12',developer='HAYO (Apps)'),
                      make_app('google:game.hayo',developer='HAYO'),
                      make_app('google:unrelated',name='Another game',developer='HAYO'))
        pair=ai_daily.cross_store_pairs(data)
        self.assertEqual(pair['apple:12'],pair['google:game.hayo'])
        queue=ai_daily.choose_candidates(data,{}, {},{},limit=5)
        self.assertEqual(len({r['app_key'] for r in queue}&{'apple:12','google:game.hayo'}),1)
        self.assertIn('google:unrelated',{r['app_key'] for r in queue})

    def test_previously_analyzed_other_store_is_skipped(self):
        data=snapshot(make_app('apple:12',developer='HAYO (Apps)'),
                      make_app('google:game.hayo',developer='HAYO'))
        queue=ai_daily.choose_candidates(data,{}, {'google:game.hayo':{}},{},limit=5)
        self.assertFalse({r['app_key'] for r in queue}&{'apple:12','google:game.hayo'})

    def test_unknown_or_different_publisher_does_not_merge(self):
        data=snapshot(make_app('apple:12',developer=''),
                      make_app('google:game.hayo',developer='HAYO'))
        self.assertFalse(ai_daily.cross_store_pairs(data))
        queue=ai_daily.choose_candidates(data,{}, {},{},limit=5)
        self.assertEqual(len(queue),2)
        other=snapshot(make_app('apple:12',developer='Publisher A'),
                       make_app('google:game.hayo',developer='Publisher B'))
        self.assertFalse(ai_daily.cross_store_pairs(other))

    def test_same_store_ambiguity_never_forces_link(self):
        data=snapshot(make_app('apple:12'),make_app('apple:13'),make_app('google:game.hayo'))
        self.assertFalse(ai_daily.cross_store_pairs(data))


if __name__=='__main__':
    unittest.main()
