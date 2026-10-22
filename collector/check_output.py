"""Minimal on-disk integrity checks before a GitHub Actions data commit.

Offline only; no network requests. This is not a second collection pass.
"""
import json
from collections import Counter
from pathlib import Path
from common import ROOT, kst_now
from merge import APP_FIELDS, LOCALE_FIELDS, RANK_FIELDS, DISC_FIELDS, read_csv, expected_groups, group_key


def check(root, run_date=None):
    run_date = run_date or kst_now().date().isoformat()
    base = root / 'data'
    apps = read_csv(base / 'apps.csv', APP_FIELDS)
    locales = read_csv(base / 'app_locales.csv', LOCALE_FIELDS)
    if not apps:
        raise ValueError('NO_APPS_SAVED')
    if len({r['app_key'] for r in apps}) != len(apps):
        raise ValueError('DUPLICATE_APP_ID')
    app_ids = {r['app_key'] for r in apps}
    if len({(r['app_key'], r['country']) for r in locales}) != len(locales):
        raise ValueError('DUPLICATE_LOCALE_ID')
    if any(r['app_key'] not in app_ids for r in locales):
        raise ValueError('UNKNOWN_LOCALE_APP')

    for folder, schema, fields in (
        ('rankings', RANK_FIELDS, ('date', 'source', 'country', 'chart', 'category', 'rank')),
        ('discoveries', DISC_FIELDS, ('date', 'source', 'feed', 'position')),
    ):
        seen = set()
        for path in sorted((base / folder).glob('*/*/*.csv')):
            for row in read_csv(path, schema):
                if row['app_key'] not in app_ids:
                    raise ValueError(f'UNKNOWN_APP_IN_HISTORY: {path.name}')
                key = tuple(row[c] for c in fields)
                if key in seen:
                    raise ValueError(f'DUPLICATE_HISTORY_POSITION: {path.name}')
                seen.add(key)

    jsons = {}
    for name in ('latest', 'trends', 'status'):
        path = base / 'web' / (name + '.json')
        jsons[name] = json.loads(path.read_text(encoding='utf-8'))
        if jsons[name].get('schema_version') != 1:
            raise ValueError(f'INVALID_WEB_JSON: {name}')
    status = jsons['status']
    expected_count = len(expected_groups(('apple', 'google', 'itch')))
    if len(status.get('groups', [])) != expected_count:
        raise ValueError('STATUS_GROUPS_MISSING')
    if len({group_key(r) for r in status['groups']}) != expected_count:
        raise ValueError('STATUS_GROUPS_DUPLICATED')
    if status.get('accepted_groups', 0) < 1:
        raise ValueError('NO_ACCEPTED_GROUPS')
    if jsons['latest'].get('data_date') != run_date:
        raise ValueError('LATEST_DATE_MISMATCH')
    exports = list((base / 'exports').glob('*.csv'))
    if len(exports) != 6:
        raise ValueError('MISSING_PERIOD_EXPORTS')
    print('[data/check] 정상:', len(app_ids), '개 앱·게임,', expected_count, '개 수집 그룹,',
          len(exports), '개 CSV 내보내기', flush=True)
    return True


if __name__ == '__main__':
    check(ROOT)
