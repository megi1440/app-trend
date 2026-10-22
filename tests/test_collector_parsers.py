"""Network-free fixture checks: run 'python -m unittest discover -s tests -v'."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'collector'))
import apple
import itch
from common import validate_items
from common import config


class CollectionParserTests(unittest.TestCase):
    def test_config_chart_count(self):
        cfg = json.loads((ROOT / 'config/sources.json').read_text('utf-8'))
        self.assertEqual(len(cfg['charts']), 17)
        self.assertEqual(len(cfg['countries']), 3)
        self.assertEqual(set(cfg['itch_feeds']), {'featured', 'new', 'puzzle', 'idle'})

    def test_apple_7003_is_casual_not_arcade(self):
        chart_map = {entry['category']: entry for entry in config()['charts']}
        self.assertEqual(chart_map['game_casual']['apple_genre'], 7003)
        self.assertIsNone(chart_map['game_arcade']['apple_genre'])
        self.assertEqual(chart_map['game_arcade']['google_category'], 'GAME_ARCADE')

    def test_apple_timeout_one_attempt_and_30_seconds(self):
        with patch('apple.fetch_bytes', side_effect=TimeoutError('test timeout')) as fetch:
            groups = apple.collect(['KR'], 'full', max_groups=1, sleep_sec=0)
        self.assertEqual(groups[0]['status'], 'failed')
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.kwargs, {'timeout': 30, 'retries': 0})

    def test_casual_feed_selected_and_arcade_skipped(self):
        modern = {'feed': {'results': [{'id': '12', 'name':'Test', 'artistName': 'Dev',
                                       'url': 'https://apps.apple.com/kr/app/id12'}]}}
        legacy = {'feed': {'entry': {'id': {'attributes': {'im:id':'12'}},
                                     'im:name': {'label': 'Test'},
                                     'link': {'attributes': {'href': 'https://apps.apple.com/kr/app/id12'}}}}}
        urls = []
        def respond(url, **options):
            urls.append(url)
            return json.dumps(modern if '/api/v2/' in url else legacy).encode('utf-8')
        with patch('apple.fetch_bytes', side_effect=respond):
            groups = apple.collect(['KR'], 'full', max_groups=11, sleep_sec=0)
        self.assertEqual(next(g['status'] for g in groups if g['category']=='game_casual'), 'success')
        self.assertEqual(next(g['status'] for g in groups if g['category']=='game_arcade'), 'skipped')
        self.assertTrue(any('genre=7003/' in url for url in urls))
        self.assertEqual(len(urls), 10)  # Arcade did not trigger a request.

    def test_modern_apple(self):
        data = {'feed': {'results': [{'id':'17', 'name':'Test App', 'artistName':'Dev', 'url':'https://apps.apple.com/us/app/id17','releaseDate':'2026-01-01','artworkUrl100':'https://img.example/icon.png','genres':[]}]}}
        items = validate_items(apple.parse_modern(data, 'app'), 5)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['app_key'], 'apple:17')
        self.assertEqual(items[0]['position'], 1)

    def test_legacy_apple(self):
        entry = {'id':{'attributes':{'im:id':'18'},'label':'https://apps.apple.com/jp/app/id18'},
                 'im:name':{'label':'テスト'}, 'im:artist':{'label':'Studio'},
                 'im:image':[{'label':'https://img.example/icon.png'}],
                 'category':{'attributes':{'label':'Puzzle'}}}
        data = {'feed':{'entry':entry}}
        rows = validate_items(apple.parse_legacy(data, 'game'), 5)
        self.assertEqual(rows[0]['app_key'], 'apple:18')
        self.assertEqual(rows[0]['kind'], 'game')

    def test_bad_apple_response_not_success(self):
        with self.assertRaises(ValueError):
            apple.parse_legacy({'feed':{}}, 'game')

    def test_itch_parse_and_stable_keys(self):
        xml = b'<rss version="2.0"><channel><item><title>A</title><link>https://studio.itch.io/game?ref=rss</link><description>A game</description></item></channel></rss>'
        game = itch.parse_rss(xml)[0]
        self.assertEqual(game['detail_url'], 'https://studio.itch.io/game')
        self.assertEqual(game['app_key'], itch.parse_rss(xml)[0]['app_key'])
        self.assertEqual(game['position'], 1)
        self.assertEqual(game['kind'], 'game')

    def test_reject_invalid_and_duplicate(self):
        item = {'app_key':'apple:123', 'detail_url':'https://apps.apple.com/us/app/id123', 'position':1}
        self.assertEqual(len(validate_items([item, item, {'app_key':'apple:999','detail_url':'bad','position':2}], 30)), 1)


if __name__ == '__main__':
    unittest.main()
