"""Offline smoke tests for the public-only site artifact generation."""
import csv
import json
import tempfile
import unittest
from pathlib import Path
import importlib.util

FILE = Path(__file__).resolve().parents[1] / 'collector' / 'build_site.py'
spec = importlib.util.spec_from_file_location('build_site', FILE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SiteBuildTests(unittest.TestCase):
    def test_shard_index_stable(self):
        self.assertEqual(mod.shard_for_key('apple:123'), sum(b'apple:123') % 16)

    def test_only_web_files_and_history_public(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            (root/'web').mkdir()
            (root/'web/index.html').write_text('<link href="./css/main.css"><script src="./js/app.js"></script>', encoding='utf-8')
            (root/'data/web').mkdir(parents=True)
            for file, obj in {'latest.json':{'data_date':'2026-10-22','groups':[]},'trends.json':{'candidates':[]},'status.json':{'groups':[]}}.items():
                (root/'data/web'/file).write_text(json.dumps(obj), encoding='utf-8')
            file = root/'data/rankings/2026/10/2026-10-22.csv'
            file.parent.mkdir(parents=True)
            with file.open('w',encoding='utf-8-sig',newline='') as out:
                writer=csv.DictWriter(out,fieldnames=['date','source','country','chart','category','rank','app_key']);writer.writeheader()
                writer.writerow({'date':'2026-10-22','source':'google','country':'US','chart':'top_free','category':'game_puzzle','rank':9,'app_key':'google:xyz'})
            export=root/'data/exports/app_trends_7d_2026-10-22.csv'
            export.parent.mkdir(parents=True)
            export.write_text('app_key\nxyz\n',encoding='utf-8')
            mod.build(root)
            manifest=json.loads((root/'web/exports/manifest.json').read_text('utf-8'))
            self.assertIn('app_trends_7d',manifest['files'])
            hist=json.loads((root/'web/data/history'/f'{mod.shard_for_key("google:xyz")}.json').read_text('utf-8'))
            self.assertEqual(hist['google:xyz'][0]['rank'],9)
            self.assertFalse((root/'web/docs').exists())
            # The branch-based Pages root opens directly at /app-trend/.
            home=(root/'index.html').read_text('utf-8')
            self.assertIn('href="./web/css/main.css"', home)
            self.assertIn('src="./web/js/app.js"', home)
            self.assertEqual(json.loads((root/'data/latest.json').read_text('utf-8'))['data_date'], '2026-10-22')
            self.assertEqual(json.loads((root/'data/history'/f'{mod.shard_for_key("google:xyz")}.json').read_text('utf-8'))['google:xyz'][0]['rank'],9)
            self.assertTrue((root/'exports/app_trends_7d.csv').is_file())
            self.assertTrue((root/'exports/manifest.json').is_file())
            self.assertTrue((root/'.nojekyll').is_file())

if __name__ == '__main__':unittest.main()
