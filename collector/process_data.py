"""Process newly created FULL staging JSONs; no network access or scraping."""
import argparse
import json
from pathlib import Path

from common import ROOT, kst_now
from merge import RANK_FIELDS, merge, read_csv, write_csv
from build_web import build


def repair_apple_7003_history(root):
    """Correct Apple 7003 charts stored as Arcade before Casual mapping was fixed.

    Initial 2026-10-22 collections used Apple genre 7003 under game_arcade.
    Apple's current chart calls 7003 Casual. This is a local CSV migration:
    no network calls and no new observations. Never modify future Arcade data.
    """
    changed = 0
    for path in sorted((root / 'data/rankings').glob('*/*/*.csv')):
        if path.stem > '2026-10-22':
            continue
        records = read_csv(path, RANK_FIELDS)
        old = [r for r in records if r['source'] == 'apple' and r['category'] == 'game_arcade']
        if not old:
            continue
        # If a corrected Casual chart was collected on the same day, keep it
        # and remove the older wrongly labeled Arcade snapshot instead.
        existing = {(r['date'], r['country'], r['chart']) for r in records
                    if r['source'] == 'apple' and r['category'] == 'game_casual'}
        fixed = []
        for row in records:
            if row['source'] == 'apple' and row['category'] == 'game_arcade':
                if (row['date'], row['country'], row['chart']) in existing:
                    changed += 1
                    continue
                row = dict(row, category='game_casual')
                changed += 1
            fixed.append(row)
        fixed.sort(key=lambda r: (r['source'], r['country'], r['chart'], r['category'], int(r['rank'])))
        write_csv(path, RANK_FIELDS, fixed)
    return changed


def process(root, run_date, sources=('apple', 'google', 'itch')):
    staging = root / 'data/staging'
    snapshots = {}
    for source in sources:
        path = staging / (source + '.json')
        snapshots[source] = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    # Stage files produced by smoke mode, or from previous dates, MUST NOT become CSV.
    statuses = merge(root, run_date, snapshots, sources)
    # Re-label the old 7003 data before generating web JSON/CSV exports.
    repair_apple_7003_history(root)
    summary = build(root, run_date, statuses)
    summary['accepted'] = sum(g['accepted'] for g in statuses)
    summary['failed'] = sum(g['status'] == 'failed' for g in statuses)
    return summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--date', default=kst_now().date().isoformat())
    p.add_argument('--source', choices=['all', 'apple', 'google', 'itch'], default='all')
    args = p.parse_args()
    sources = ('apple', 'google', 'itch') if args.source == 'all' else (args.source,)
    summary = process(ROOT, args.date, sources)
    print('[data] date={0} accepted={1} failed={2} groups={3} candidates={4} status={5}'.format(
        args.date, summary['accepted'], summary['failed'], summary['groups'],
        summary['candidates'], summary['status']), flush=True)
    return 0 if summary['accepted'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
