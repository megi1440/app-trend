"""Create current lists, evidence-only trend candidates, status, and CSV exports."""
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path

from common import atomic_json, timestamp
from merge import (APP_FIELDS, DISC_FIELDS, LOCALE_FIELDS, RANK_FIELDS, group_key,
                   group_of_row, read_csv, write_csv, expected_groups)
import csv
import os
import tempfile


def all_history(root, base, columns, end_day, days=None):
    earliest = (dt.date.fromisoformat(end_day) - dt.timedelta(days=days - 1)).isoformat() if days else None
    for path in sorted((root / 'data' / base).glob('*/*/*.csv')):
        if path.stem > end_day or (earliest and path.stem < earliest):
            continue
        yield from read_csv(path, columns)


def web_record(app_key, country, apps, locales):
    app = apps.get(app_key, {})
    loc = locales.get((app_key, country), {})
    if not loc.get('name'):
        loc = next((r for (k, _), r in sorted(locales.items()) if k == app_key and r.get('name')), {})
    return {
        'app_key': app_key, 'name': loc.get('name') or app_key,
        'kind': app.get('kind', ''), 'developer': app.get('developer', ''),
        'primary_category': app.get('primary_category', ''),
        'icon_url': app.get('icon_url', ''), 'detail_url': app.get('detail_url', ''),
        'release_date': app.get('release_date', ''), 'first_seen': app.get('first_seen', ''),
        'description': loc.get('description', '')[:1600],
        'rating': float(loc['rating']) if loc.get('rating') else None,
        'rating_count': int(float(loc['rating_count'])) if loc.get('rating_count') else None,
    }


def keep_status_across_partial_runs(root, run_date, current_statuses):
    """Preserve unrelated source statuses on manual per-source runs.

    Count a failure at most once per KST collection date. Unsupported/skipped
    charts are not treated as outages. No extra HTTP requests are made.
    """
    path = root / 'data/web/status.json'
    previous = {}
    if path.exists():
        stored = json.loads(path.read_text(encoding='utf-8'))
        previous = {group_key(row): row for row in stored.get('groups', [])}
    current = {group_key(row): row for row in current_statuses}
    if len(current) != len(current_statuses):
        raise ValueError('DUPLICATE_STATUS_GROUP')

    merged = []
    for expected in expected_groups(('apple', 'google', 'itch')):
        key = group_key(expected)
        old = previous.get(key, {})
        if key not in current:
            # An unselected source should never be marked as failed or have
            # its last observed state erased by a different collector's run.
            if old:
                merged.append(dict(old))
            else:
                merged.append(dict(expected, status='skipped', item_count=0,
                                   attempted_at='', message='NOT_ATTEMPTED', accepted=False,
                                   last_checked_date='', consecutive_failed_days=0))
            continue

        row = dict(current[key])
        was_ok = bool(row.get('accepted'))
        failed = not was_ok and row.get('status') in ('failed', 'partial')
        if failed:
            old_day = old.get('last_checked_date', '')
            # Same-day reruns must not increment the streak twice. A success
            # earlier today followed by a failure counts as one failed attempt.
            if old_day == run_date:
                count = max(1, int(old.get('consecutive_failed_days') or 0))
            else:
                count = int(old.get('consecutive_failed_days') or 0) + 1
        else:
            count = 0
        row['last_checked_date'] = run_date
        row['consecutive_failed_days'] = count
        merged.append(row)
    return merged


def make_latest(root, run_date, status_rows, apps, locales):
    latest_group_rows = defaultdict(list)
    for r in all_history(root, 'rankings', RANK_FIELDS, run_date):
        key = group_of_row(r)
        if latest_group_rows[key] and latest_group_rows[key][0]['date'] < r['date']:
            latest_group_rows[key] = []
        if not latest_group_rows[key] or latest_group_rows[key][0]['date'] == r['date']:
            latest_group_rows[key].append(r)
    for r in all_history(root, 'discoveries', DISC_FIELDS, run_date):
        key = group_of_row(r, discovery=True)
        if latest_group_rows[key] and latest_group_rows[key][0]['date'] < r['date']:
            latest_group_rows[key] = []
        if not latest_group_rows[key] or latest_group_rows[key][0]['date'] == r['date']:
            latest_group_rows[key].append(r)
    status_map = {group_key(s): s for s in status_rows}
    groups = []
    for key, rows in sorted(latest_group_rows.items()):
        head = rows[0]
        source, country, chart, category = key
        indie = source == 'itch'
        data_date = head['date']
        status = status_map.get(key)
        is_stale = data_date != run_date or (status is not None and not status.get('accepted'))
        groups.append({
            'source': source, 'country': country, 'chart': None if indie else chart,
            'category': None if indie else category, 'feed': category if indie else None,
            'data_date': data_date, 'updated_at': max(r['collected_at'] for r in rows),
            'is_stale': is_stale,
            'has_warning': status is not None and status['status'] != 'success',
            'items': [dict({'position' if indie else 'rank': int(row['position' if indie else 'rank'])},
                           **web_record(row['app_key'], country, apps, locales))
                      for row in sorted(rows, key=lambda r: int(r['position' if indie else 'rank']))],
        })
    for s in status_rows:
        if group_key(s) not in latest_group_rows:
            groups.append(dict(source=s['source'], country=s['country'], chart=s['chart'],
                               category=s['category'], feed=s.get('feed'), data_date=None, updated_at=None,
                               is_stale=True, has_warning=True, items=[]))
    groups.sort(key=lambda g: (g['source'], g['country'], g.get('chart') or '', g.get('category') or g.get('feed') or ''))
    return {'schema_version': 1, 'generated_at': timestamp(), 'data_date': run_date, 'groups': groups}


def make_status(run_date, statuses, latest):
    latest_by = {group_key(g): g for g in latest['groups']}
    entries = []
    for g in statuses:
        latest_group = latest_by.get(group_key(g), {})
        entries.append({k: g.get(k) for k in ('source', 'country', 'chart', 'category', 'feed',
                                             'status', 'item_count', 'attempted_at', 'message', 'accepted',
                                             'last_checked_date', 'consecutive_failed_days')} |
                       {'last_success_at': latest_group.get('updated_at') if latest_group.get('items') else None,
                        'data_date': latest_group.get('data_date'),
                        'needs_attention': g.get('consecutive_failed_days', 0) >= 7,
                        'error_code':
                        (g.get('message') or '').split(':', 1)[0] if not g.get('accepted') else ''})
    successful = sum(1 for r in entries if r['accepted'])
    failed = sum(1 for r in entries if r['status'] == 'failed')
    overall = 'failed' if successful == 0 else 'success' if not failed and all(
        r['status'] in ('success', 'skipped') for r in entries) else 'partial'
    observed_times = [dt.datetime.fromisoformat(r['attempted_at'].replace('Z', '+00:00'))
                      for r in entries if r['attempted_at']]
    started_at = min(observed_times).isoformat() if observed_times else timestamp()
    return {'schema_version': 1, 'run_id': 'app-trend-' + run_date + '-' + timestamp(),
            'started_at': started_at,
            'finished_at': timestamp(), 'overall_status': overall,
            'accepted_groups': successful, 'failed_groups': failed, 'groups': entries}


def make_trends(root, run_date, latest, apps):
    """No generated claims about cause, revenue, or development difficulty."""
    today = dt.date.fromisoformat(run_date)
    week_ago = (today - dt.timedelta(days=7)).isoformat()
    recent = list(all_history(root, 'rankings', RANK_FIELDS, run_date, 30))
    recent_indie = list(all_history(root, 'discoveries', DISC_FIELDS, run_date, 30))
    prior = {(group_of_row(r), r['app_key']): r for r in recent if r['date'] == week_ago}
    group_appearance = defaultdict(set)
    for r in recent:
        group_appearance[(group_of_row(r), r['app_key'])].add(r['date'])
    candidates = []

    def add(key, code, evidence, dates, note):
        candidates.append({'app_key': key, 'reason_code': code, 'evidence': evidence,
                           'source_data_dates': dates, 'confidence_note': note})

    latest_items = defaultdict(list)
    for g in latest['groups']:
        if not g['items'] or g['is_stale'] or g['source'] == 'itch':
            continue
        key = group_key(g)
        for item in g['items']:
            latest_items[key].append((g, item))
    rising = []
    consistent = []
    overseas = []
    by_app = defaultdict(lambda: defaultdict(set))
    for key, entries in latest_items.items():
        for g, item in entries:
            app_key = item['app_key']
            earlier = prior.get((key, app_key))
            if earlier:
                before = int(earlier['rank'])
                after = item['rank']
                if before - after >= 5:
                    rising.append((before - after, item['rank'], app_key, g, before))
            count = len(group_appearance.get((key, app_key), set()))
            if count >= 3:
                consistent.append((count, item['rank'], app_key, g))
            if g['country'] in ('US', 'JP') and item['rank'] <= 30:
                overseas.append((item['rank'], app_key, g))
            by_app[(g['source'], g['chart'], g['category'], app_key)]['countries'].add(g['country'])

    for delta, after, app_key, g, before in sorted(rising, key=lambda x: (-x[0], x[1]))[:40]:
        add(app_key, 'rising_7d', {'source': g['source'], 'country': g['country'],
            'chart': g['chart'], 'category': g['category'], 'before_rank': before,
            'after_rank': after, 'change': delta}, [week_ago, g['data_date']],
            '같은 국가·스토어·차트의 관측 순위 변화이며 다운로드 증가율이 아닙니다.')
    for count, rank, app_key, g in sorted(consistent, key=lambda x: (-x[0], x[1]))[:30]:
        add(app_key, 'consistent_30d', {'observed_days': count, 'last_rank': rank,
            'source': g['source'], 'country': g['country'], 'category': g['category'],
            'chart': g['chart']}, [g['data_date']], '수집에 성공한 날짜의 등장 횟수입니다.')
    for (src, chart, cat, app_key), countries in sorted(by_app.items()):
        if len(countries) >= 2:
            add(app_key, 'multi_country', {'source': src, 'chart': chart, 'category': cat,
                'countries': sorted(countries)}, [run_date],
                '같은 스토어·차트에서 여러 국가에 관측되었습니다.')
            if sum(c['reason_code'] == 'multi_country' for c in candidates) >= 40:
                break
    for rank, app_key, g in sorted(overseas, key=lambda x: x[0])[:30]:
        add(app_key, 'overseas_interest', {'source': g['source'], 'country': g['country'],
            'category': g['category'], 'chart': g['chart'], 'rank': rank}, [g['data_date']],
            '해외 인기 목록 관측 사실이며 성장 원인에 대한 분석은 아닙니다.')
    for app_key, app in sorted(apps.items()):
        if app.get('first_seen') == run_date and app.get('source') != 'itch':
            add(app_key, 'newly_seen', {'first_seen': run_date}, [run_date],
                '우리 수집 시스템에서 처음 발견한 앱이며 신규 출시를 뜻하지 않습니다.')
            if sum(c['reason_code'] == 'newly_seen' for c in candidates) >= 50:
                break
    first_indie = set()
    for r in reversed(recent_indie):
        if r['app_key'] in first_indie:
            continue
        first_indie.add(r['app_key'])
        if app := apps.get(r['app_key']):
            if app.get('first_seen', '') >= (today - dt.timedelta(days=6)).isoformat():
                add(r['app_key'], 'indie_discovery', {'feed': r['feed'],
                    'first_seen': app['first_seen']}, [r['date']],
                    'itch.io 피드에 등장한 게임이며 인기 순위가 아닙니다.')
        if len(first_indie) >= 30:
            break
    return {'schema_version': 1, 'generated_at': timestamp(), 'window_days': 30,
            'candidates': candidates}


def safe_spreadsheet_value(v):
    value = '' if v is None else str(v)
    return "'" + value if value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else value


def export_csv(path, headers, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', encoding='utf-8-sig', newline='', dir=path.parent,
                                     prefix='.export-', delete=False) as stream:
        temp = Path(stream.name)
        writer = csv.DictWriter(stream, headers, extrasaction='ignore', lineterminator='\n')
        writer.writeheader()
        for row in rows:
            writer.writerow({k: safe_spreadsheet_value(row.get(k)) for k in headers})
    if path.exists() and path.read_bytes() == temp.read_bytes():
        temp.unlink()
    else:
        os.replace(temp, path)


def build_exports(root, run_date, apps, locales):
    rank_cols = ['date', 'source', 'country', 'chart', 'category', 'rank', 'app_key',
                 'name', 'developer', 'primary_category', 'rating', 'rating_count',
                 'installs_range', 'detail_url', 'release_date', 'first_seen']
    indie_cols = ['date', 'feed', 'position', 'app_key', 'name', 'developer',
                  'primary_category', 'detail_url', 'release_date', 'first_seen']
    export_dir = root / 'data/exports'
    output = {}
    for days in (7, 30, 90):
        ranks = []
        for row in all_history(root, 'rankings', RANK_FIELDS, run_date, days):
            app = apps.get(row['app_key'], {})
            loc = locales.get((row['app_key'], row['country']), {})
            fallback_name = web_record(row['app_key'], row['country'], apps, locales)['name']
            ranks.append(dict(row, name=loc.get('name') or fallback_name,
                              developer=app.get('developer'), primary_category=app.get('primary_category'),
                              rating=loc.get('rating'), rating_count=loc.get('rating_count'),
                              installs_range=loc.get('installs_range'), detail_url=app.get('detail_url'),
                              release_date=app.get('release_date'), first_seen=app.get('first_seen')))
        indies = []
        for row in all_history(root, 'discoveries', DISC_FIELDS, run_date, days):
            app = apps.get(row['app_key'], {})
            loc = locales.get((row['app_key'], 'GLOBAL'), {})
            indies.append(dict(row, name=loc.get('name') or row['app_key'],
                                developer=app.get('developer'), primary_category=app.get('primary_category'),
                                detail_url=app.get('detail_url'), release_date=app.get('release_date'),
                                first_seen=app.get('first_seen')))
        names = [f'app_trends_{days}d_{run_date}.csv', f'indie_discoveries_{days}d_{run_date}.csv']
        export_csv(export_dir / names[0], rank_cols, ranks)
        export_csv(export_dir / names[1], indie_cols, indies)
        output[str(days)] = names
    # Remove older generated export copies. Durable source CSVs are not touched.
    for old in export_dir.glob('*.csv'):
        if old.name not in sum(output.values(), []):
            old.unlink()
    return output


def build(root, run_date, statuses):
    apps = {r['app_key']: r for r in read_csv(root / 'data/apps.csv', APP_FIELDS)}
    locales = {(r['app_key'], r['country']): r for r in read_csv(root / 'data/app_locales.csv', LOCALE_FIELDS)}
    preserved_statuses = keep_status_across_partial_runs(root, run_date, statuses)
    latest = make_latest(root, run_date, preserved_statuses, apps, locales)
    status = make_status(run_date, preserved_statuses, latest)
    trends = make_trends(root, run_date, latest, apps)
    exports = build_exports(root, run_date, apps, locales)
    for name, value in [('latest', latest), ('trends', trends), ('status', status)]:
        atomic_json(root / 'data/web' / f'{name}.json', value)
    return {'status': status['overall_status'], 'groups': len(latest['groups']),
            'candidates': len(trends['candidates']), 'exports': exports}
