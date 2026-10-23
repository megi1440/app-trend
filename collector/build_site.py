"""Build the public app-trend website at the repository root for GitHub Pages.

Run: python collector/build_site.py
The editable web/ sources and canonical data/web/ files are preserved.
"""
from __future__ import annotations
import csv
import datetime as dt
import json
import shutil
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
WEB = ROOT / 'web'


def shard_for_key(key: str) -> int:
    return sum(key.encode('utf-8')) % 16


def build(root: Path = ROOT) -> dict:
    data = root / 'data'
    web = root / 'web'
    dest_data = web / 'data'
    dest_export = web / 'exports'
    if not (web / 'index.html').is_file():
        raise FileNotFoundError('web/index.html 파일이 없습니다.')
    for name in ('latest.json', 'trends.json', 'status.json'):
        src = data / 'web' / name
        if not src.is_file():
            raise FileNotFoundError(f'수집 결과가 없습니다: {src}')
        # Validate the JSON before putting it on the public site.
        with src.open(encoding='utf-8') as fp:
            json.load(fp)
        dest_data.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest_data / name)

    latest = json.loads((data / 'web/latest.json').read_text(encoding='utf-8'))
    day = latest.get('data_date')
    if not day:
        raise ValueError('latest.json 에 data_date 값이 없습니다.')
    end = dt.date.fromisoformat(day)
    earliest = end - dt.timedelta(days=89)

    # Split history into 16 small files. The detail view loads only one shard.
    buckets: dict[int, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for file in sorted((data / 'rankings').glob('*/*/*.csv')):
        try:
            date = dt.date.fromisoformat(file.stem)
        except ValueError:
            continue
        if not earliest <= date <= end:
            continue
        with file.open('r', encoding='utf-8-sig', newline='') as fp:
            for r in csv.DictReader(fp):
                key = r.get('app_key', '')
                if not key:
                    continue
                try:
                    rank = int(r['rank'])
                except (ValueError, TypeError, KeyError):
                    continue
                buckets[shard_for_key(key)][key].append({
                    'date': r['date'], 'country': r['country'],
                    'source': r['source'], 'chart': r['chart'],
                    'category': r['category'], 'rank': rank,
                })
    hdir = dest_data / 'history'
    hdir.mkdir(parents=True, exist_ok=True)
    for prev in hdir.glob('*.json'):
        prev.unlink()
    for index, by_app in buckets.items():
        (hdir / f'{index}.json').write_text(json.dumps(by_app, ensure_ascii=False, separators=(',', ':')),
                                                encoding='utf-8')

    # Publish stable download names (only the latest generated export for each period).
    dest_export.mkdir(parents=True, exist_ok=True)
    for prev in dest_export.glob('*.csv'):
        prev.unlink()
    manifest = {'data_date': day, 'files': {}}
    for prefix in ('app_trends', 'indie_discoveries'):
        for days in (7, 30, 90):
            candidates = sorted((data / 'exports').glob(f'{prefix}_{days}d_*.csv'))
            candidates = [p for p in candidates if p.stem.rsplit('_', 1)[-1] <= day]
            if not candidates:
                continue
            source = candidates[-1]
            target_name = f'{prefix}_{days}d.csv'
            shutil.copyfile(source, dest_export / target_name)
            manifest['files'][f'{prefix}_{days}d'] = {'filename': target_name,
                                                      'date': source.stem.rsplit('_', 1)[-1],
                                                      'bytes': source.stat().st_size}
    (dest_export / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

    # The research index and itch observations are already public under data/lab/.
    # Copy a preview to web/data/ for the editable site without touching the AI shards.
    lab_dir = data / 'lab'
    if (lab_dir / 'index.json').is_file():
        preview_lab = dest_data / 'lab'
        preview_lab.mkdir(parents=True, exist_ok=True)
        for name in ('index.json', 'indie_history.json'):
            if (lab_dir / name).is_file():
                json.loads((lab_dir / name).read_text(encoding='utf-8'))
                shutil.copyfile(lab_dir / name, preview_lab / name)

    # Deploy from a branch supports only main/(root) or main/docs. Keep all
    # documentation out of Git and publish the actual site from main/(root).
    # The editable site stays under web/. No Pages Actions are needed.
    html = (web / 'index.html').read_text(encoding='utf-8')
    html = html.replace('href="./css/main.css"', 'href="./web/css/main.css"')
    html = html.replace('href="./css/lab.css"', 'href="./web/css/lab.css"')
    html = html.replace('src="./js/app.js"', 'src="./web/js/app.js"')
    (root / 'index.html').write_text(html, encoding='utf-8')

    # All JS data URLs are document-relative (./data, ./exports). Publish
    # these snapshots to their real URLs, leaving data/web/ as the authority.
    for name in ('latest.json', 'trends.json', 'status.json'):
        shutil.copyfile(dest_data / name, data / name)
    public_history = data / 'history'
    public_history.mkdir(parents=True, exist_ok=True)
    for old in public_history.glob('*.json'):
        old.unlink()
    for src in hdir.glob('*.json'):
        shutil.copyfile(src, public_history / src.name)

    public_exports = root / 'exports'
    public_exports.mkdir(exist_ok=True)
    for old in public_exports.glob('*.csv'):
        old.unlink()
    for src in dest_export.iterdir():
        if src.is_file() and src.suffix in ('.csv', '.json'):
            shutil.copyfile(src, public_exports / src.name)
    (root / '.nojekyll').touch()

    result = {'date': day, 'history_shards': len(buckets), 'exports': len(manifest['files'])}
    print(f"[site] {day} / history {result['history_shards']} shards / exports {result['exports']}")
    return result


if __name__ == '__main__':
    build()
