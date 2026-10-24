"""V3: daily first-pass AI analysis with persistent shards and safe request caps.

Store observations remain unmodified. An API key is read from the environment or
an external local secret file; raw keys are never persisted or logged.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
import math
import re
import sys
import time
import traceback
import unicodedata
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import ai_probe
from common import ROOT, atomic_json, kst_now, timestamp

STORE_DIR = Path('data/ai/items')
FAILURES_FILE = Path('data/ai/failures.json')
LATEST_FILE = Path('data/web/latest.json')
TRENDS_FILE = Path('data/web/trends.json')
REASONS = {
    'rising_7d': 240,
    'newly_seen': 135,  # First observed by THIS collector, not necessarily new release.
    'multi_country': 150,
    'consistent_30d': 85,
    'indie_discovery': 140,
    'overseas_interest': 45,
}
MAX_DAY_APPS = 2250  # Safety headroom: 450 batches * 5 apps.
MAX_DAY_REQUESTS = 450  # User free tier currently shows 500 RPD, do not use all.
REQUEST_USAGE = Path('data/ai/request_usage.json')
MAX_BATCH_SIZE = 5
MIN_DESCRIPTION = 40
KST = dt.timezone(dt.timedelta(hours=9))


def pacific_day() -> str:
    # Gemini RPD resets at midnight Pacific, independently of the KST run day.
    now = dt.datetime.now(dt.timezone.utc)
    try:
        return now.astimezone(ZoneInfo('America/Los_Angeles')).date().isoformat()
    except ZoneInfoNotFoundError:
        # Stock Windows Python may have no system IANA timezone database.
        # US Pacific DST: second Sunday in March at 10:00 UTC, first Sunday
        # in November at 09:00 UTC. Avoid requiring another Python package.
        year = now.year
        march = dt.date(year, 3, 1)
        second_sunday = 1 + (6 - march.weekday()) % 7 + 7
        november = dt.date(year, 11, 1)
        first_sunday = 1 + (6 - november.weekday()) % 7
        start = dt.datetime(year, 3, second_sunday, 10, tzinfo=dt.timezone.utc)
        end = dt.datetime(year, 11, first_sunday, 9, tzinfo=dt.timezone.utc)
        offset = -7 if start <= now < end else -8
        return (now + dt.timedelta(hours=offset)).date().isoformat()


def read_request_usage(root: Path, model: str, day: str) -> int:
    path = root / REQUEST_USAGE
    if not path.exists():
        return 0
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema_version') != 1 or not isinstance(doc.get('days'), dict):
        raise ValueError('AI_REQUEST_USAGE_INVALID')
    return int(doc['days'].get(day, {}).get(model, 0))


def use_request(root: Path, model: str, day: str) -> None:
    path = root / REQUEST_USAGE
    doc = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'schema_version': 1, 'days': {}}
    if doc.get('schema_version') != 1 or not isinstance(doc.get('days'), dict):
        raise ValueError('AI_REQUEST_USAGE_INVALID')
    count = int(doc['days'].get(day, {}).get(model, 0))
    if count >= MAX_DAY_REQUESTS:
        raise RuntimeError('GEMINI_LOCAL_REQUEST_LIMIT')
    doc['days'].setdefault(day, {})[model] = count + 1
    # Keep limited history and count unsuccessful API calls too.
    doc['days'] = {k: doc['days'][k] for k in sorted(doc['days'])[-12:]}
    atomic_json(path, doc)


def safe_error_diagnostic(exc: Exception, api_key: str = '') -> str:
    """Log the failure reason and Python location, without raw Gemini data/secrets."""
    message = str(exc) or '(오류 메시지 없음)'
    if api_key:
        message = message.replace(api_key, '[REDACTED]')
    message = re.sub(r'AIza[0-9A-Za-z_-]{15,}', '[REDACTED]', message)
    message = re.sub(r'(?i)\b(?:api[_-]?key|key|token|authorization)\s*[=:]\s*[^\s&]+',
                     'credential=[REDACTED]', message)
    message = re.sub(r'(?i)https?://\S+', '[URL]', message)
    message = ' '.join(message.split())[:240]
    frames = traceback.extract_tb(exc.__traceback__)
    if frames:
        origin = frames[-1]
        location = f'{Path(origin.filename).name}:{origin.lineno} {origin.name}()'
    else:
        location = '위치 정보 없음'
    return f'{type(exc).__name__}: {message} | 위치: {location}'


def analysed_on_day(existing: dict, day: str) -> int:
    """Count completed analyses by Korean calendar date, including imported V2 work."""
    count = 0
    for record in existing.values():
        # Daily batches belong to the KST day on which their run started.
        # An API response may arrive after midnight; preserve that day's quota.
        quota_day = record.get('quota_day')
        if isinstance(quota_day, str):
            try:
                dt.date.fromisoformat(quota_day)
            except ValueError:
                pass
            else:
                count += quota_day == day
                continue
        stamp = record.get('analysed_at', '')
        try:
            parsed = dt.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError('ANALYSIS_TIMESTAMP_HAS_NO_TIMEZONE')
        except (AttributeError, TypeError, ValueError):
            # Records without a trustworthy timestamp must not be silently ignored
            # if their chart is from the same day; count them conservatively.
            count += record.get('data_date') == day
            continue
        count += parsed.astimezone(KST).date().isoformat() == day
    return count


def shard_name(app_key: str) -> str:
    # Stable across operating systems and Python invocations.
    return f"{int(hashlib.sha256(app_key.encode('utf-8')).hexdigest()[:8], 16) % 32:02d}.json"


def load_records(root: Path) -> dict:
    """Reject malformed shards rather than treating a damaged store as empty."""
    found = {}
    for path in sorted((root / STORE_DIR).glob('*.json')):
        doc = json.loads(path.read_text(encoding='utf-8'))
        if doc.get('schema_version') != 1 or not isinstance(doc.get('items'), dict):
            raise ValueError('AI_STORE_INVALID_SHARD')
        for key, record in doc['items'].items():
            if (not isinstance(key, str) or not isinstance(record, dict)
                    or record.get('app_key') != key or shard_name(key) != path.name
                    or key in found):
                raise ValueError('AI_STORE_INVALID_RECORD')
            found[key] = record
    return found


def write_records(root: Path, new_records: list[dict], existing: dict) -> int:
    """Persist only new, validated records; atomic per shard. Never overwrite."""
    pending = defaultdict(dict)
    for record in new_records:
        key = record['app_key']
        if key not in existing and key not in pending[shard_name(key)]:
            pending[shard_name(key)][key] = record
    written = 0
    for name, rows in sorted(pending.items()):
        path = root / STORE_DIR / name
        if path.is_file():
            doc = json.loads(path.read_text(encoding='utf-8'))
            if doc.get('schema_version') != 1 or not isinstance(doc.get('items'), dict):
                raise ValueError('AI_STORE_INVALID_SHARD')
        else:
            doc = {'schema_version': 1, 'items': {}}
        for key, record in rows.items():
            if key not in doc['items']:
                doc['items'][key] = record
                written += 1
                existing[key] = record
        atomic_json(path, doc)
    return written


def read_failures(root: Path) -> dict:
    path = root / FAILURES_FILE
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding='utf-8'))
    if payload.get('schema_version') != 1 or not isinstance(payload.get('items'), dict):
        raise ValueError('AI_FAILURE_STATE_INVALID')
    return payload['items']


def save_failures(root: Path, failures: dict) -> None:
    atomic_json(root / FAILURES_FILE, {'schema_version': 1, 'items': failures})


def next_retry(day: str, days: int) -> str:
    return (dt.date.fromisoformat(day) + dt.timedelta(days=days)).isoformat()


def record_failure(failures: dict, key: str, day: str, code: str, cooldown: int) -> None:
    previous = failures.get(key, {})
    failures[key] = {
        'code': code[:100],
        'attempts': int(previous.get('attempts', 0)) + 1,
        'last_attempt_date': day,
        'retry_on': next_retry(day, cooldown),
    }


def _ranking(item: dict) -> int:
    value = item.get('rank', item.get('position', 10000))
    try:
        return max(1, int(value))
    except (ValueError, TypeError):
        return 10000


def _kind(item: dict, group: dict) -> str:
    kind = item.get('kind')
    if kind in ('app', 'game'):
        return kind
    return 'game' if group['source'] == 'itch' or str(group.get('category') or '').startswith('game_') else 'app'


def rank_candidates(snapshot: dict, trends: dict) -> list[dict]:
    """Rank independently of prompts, with evidence from collected chart data."""
    today = snapshot.get('data_date', '')
    # Discard old trend signals if the trend snapshot is not for today's chart.
    if trends.get('generated_at') and str(trends['generated_at'])[:10] != today:
        trends = {}
    trend_by_key = defaultdict(set)
    for row in trends.get('candidates', []):
        if isinstance(row, dict) and row.get('reason_code') in REASONS and row.get('app_key'):
            trend_by_key[row['app_key']].add(row['reason_code'])
    by_key = {}
    for group in snapshot.get('groups', []):
        if group.get('is_stale') or group.get('source') not in ('apple', 'google', 'itch'):
            continue
        if group.get('data_date') != today:  # Never select old data as fresh.
            continue
        for item in group.get('items', []):
            key = item.get('app_key')
            url = item.get('detail_url', '')
            if not isinstance(key, str) or ':' not in key or not isinstance(url, str) or not url.startswith('https://'):
                continue
            if key.split(':', 1)[0] != group['source'] or not str(item.get('name', '')).strip():
                continue
            rank = _ranking(item)
            if rank > 30 and group['source'] != 'itch' and not trend_by_key.get(key):
                continue
            first_seen = item.get('first_seen') == today
            existing = by_key.get(key)
            row = {
                'app_key': key, 'source_id': key.split(':', 1)[1],
                'source': group['source'], 'country': group['country'],
                'chart': group.get('chart'), 'category': group.get('category') or group.get('feed'),
                'kind': _kind(item, group), 'name': item.get('name') or '',
                'developer': item.get('developer') or '',
                'detail_url': url, 'description': item.get('description') or '',
                'data_date': today, 'best_rank': rank, 'countries': [group['country']],
                'first_seen_today': first_seen,
            }
            if not existing:
                by_key[key] = row
            else:
                existing['countries'] = sorted(set(existing['countries']) | {group['country']})
                existing['first_seen_today'] |= first_seen
                if rank < existing['best_rank']:
                    existing['best_rank'] = rank
                    for field in ('country', 'chart', 'category', 'detail_url'):
                        existing[field] = row[field]
                if len(row['description']) > len(existing['description']):
                    existing['description'] = row['description']
                if not existing['name']:
                    existing['name'] = row['name']

    ranked = []
    for key, row in by_key.items():
        reasons = set(trend_by_key[key])
        if row['first_seen_today']:
            reasons.add('newly_seen')
        if len(row['countries']) >= 2:
            reasons.add('multi_country')
        if row['source'] == 'itch':
            reasons.add('indie_discovery')
        if row['best_rank'] > 30 and not reasons:
            continue
        score = min(100, max(0, 105 - row['best_rank'] * 3))
        score += sum(REASONS[r] for r in reasons)
        # Very short indie pitches often cannot support a useful verified analysis.
        if row['source'] == 'itch' and len(ai_probe.plain_description(row['description'])) < MIN_DESCRIPTION:
            score -= 160
        row['priority_score'] = score
        row['priority_reasons'] = sorted(reasons, key=lambda r: (-REASONS[r], r))
        ranked.append(row)
    return sorted(ranked, key=lambda row: (-row['priority_score'], row['best_rank'], row['app_key']))


def cross_store_pairs(snapshot: dict, historical_items=()) -> dict[str, frozenset[str]]:
    """Map unambiguous same-title/same-publisher Apple/Google listings.

    Each original store ID remains independent in observations and storage.
    A missing publisher or ambiguous multiple listing is not guessed into a match.
    """
    def text(value):
        return ' '.join(unicodedata.normalize('NFKC', str(value or '')).casefold().split())

    def publisher(value):
        value = re.sub(r'\s*\(apps?\)$', '', text(value))
        return re.sub(r'(?:\s*,?\s*(?:inc\.?|incorporated|ltd\.?|limited|llc|corp\.?|corporation|co\.?))+(?:\s*,?\s*(?:ltd\.?))?$', '', value).strip()

    names = defaultdict(lambda: defaultdict(set))
    for group in snapshot.get('groups', []):
        source = group.get('source')
        if source not in ('apple', 'google'):
            continue
        for item in group.get('items', []):
            name, dev = text(item.get('name')), publisher(item.get('developer'))
            key = item.get('app_key', '')
            if name and dev and isinstance(key, str) and key.startswith(f'{source}:'):
                names[(name, dev)][source].add(key)
    # The other store may not occur in today's chart. The persisted Lab index
    # contains historical listings and lets us recognize yesterday's analysis.
    for item in historical_items:
        if not isinstance(item, dict):
            continue
        source = item.get('source')
        key = item.get('app_key')
        if source not in ('apple', 'google') or not isinstance(key, str) or not key.startswith(f'{source}:'):
            continue
        name, dev = text(item.get('name')), publisher(item.get('developer'))
        if name and dev:
            names[(name, dev)][source].add(key)
    pairs = {}
    for members in names.values():
        if len(members.get('apple', ())) != 1 or len(members.get('google', ())) != 1:
            continue
        pair = frozenset((*members['apple'], *members['google']))
        for key in pair:
            pairs[key] = pair
    return pairs


def choose_candidates(snapshot: dict, trends: dict, existing: dict, failures: dict,
                      limit: int = MAX_DAY_APPS, scan_factor: int = 3,
                      historical_items=()) -> list[dict]:
    """Keep top evidence-driven choices but avoid one kind/source occupying all slots."""
    today = snapshot.get('data_date', '')
    eligible = [
        row for row in rank_candidates(snapshot, trends)
        if row['app_key'] not in existing
        and (failures.get(row['app_key'], {}).get('retry_on', '') <= today)
        and row['priority_score'] >= 60
    ]
    # Fresh store charts always take priority, but an app that disappeared
    # yesterday must not be permanently stranded as an unanalysed historical
    # research item. Use its real latest observation, never invent freshness.
    eligible_keys = {row['app_key'] for row in eligible}
    backlog = []
    for item in historical_items:
        if not isinstance(item, dict):
            continue
        key, source = item.get('app_key'), item.get('source')
        if (source not in ('apple', 'google', 'itch') or not isinstance(key, str)
                or not key.startswith(source + ':') or key in existing or key in eligible_keys
                or failures.get(key, {}).get('retry_on', '') > today
                or not str(item.get('name') or '').strip()
                or not str(item.get('detail_url') or '').startswith('https://')):
            continue
        observations = [o for o in item.get('observations', []) if isinstance(o, dict)
                        and isinstance(o.get('date'), str) and o.get('date') <= today]
        if not observations:
            continue
        last = max(observations, key=lambda o: (o['date'], not o.get('historical', False)))
        if source != 'itch' and last.get('country') not in ('KR', 'JP', 'US'):
            # A guessed market must never become a genuine store observation.
            continue
        best_rank = min((_ranking(o) for o in observations), default=10000)
        backlog.append({
            'app_key': key, 'source_id': key.split(':', 1)[1], 'source': source,
            'country': ('GLOBAL' if source == 'itch' else last['country']),
            'chart': last.get('chart'), 'category': last.get('category') or item.get('category'),
            'kind': item.get('kind') or ('game' if source == 'itch' else 'app'),
            'name': item.get('name'), 'developer': item.get('developer') or '',
            'detail_url': item.get('detail_url'), 'description': item.get('description') or '',
            'data_date': last['date'], 'best_rank': best_rank,
            'countries': sorted({o.get('country') for o in observations if o.get('country')}),
            'first_seen_today': False, 'priority_reasons': ['previously_observed'],
            'priority_score': 60,
        })
    backlog.sort(key=lambda x: (x['best_rank'], x['app_key']))
    backlog.sort(key=lambda x: x['data_date'], reverse=True)
    eligible += backlog
    # Both store versions count as one app for new analysis. A previously
    # analysed counterpart must not consume the next day's Gemini allowance.
    pairs = cross_store_pairs(snapshot, [*historical_items, *existing.values()])
    eligible = [row for row in eligible
                if not (pairs.get(row['app_key'], frozenset()) & existing.keys())]
    capacity = max(1, limit * scan_factor)
    candidates = []
    chosen_pairs = set()
    chosen_keys = set()
    def not_chosen(row):
        pair = pairs.get(row['app_key'])
        return row['app_key'] not in chosen_keys and (not pair or pair not in chosen_pairs)
    def select(row):
        candidates.append(row)
        chosen_keys.add(row['app_key'])
        pair = pairs.get(row['app_key'])
        if pair:
            chosen_pairs.add(pair)
    # Prefer diversity first; remaining slots may go to strong options from any stream.
    buckets = Counter()
    quota = max(2, math.ceil(limit * .4))
    for row in eligible:
        bucket = row['source']
        if buckets[bucket] < quota and not_chosen(row):
            select(row)
            buckets[bucket] += 1
            if len(candidates) == capacity:
                break
    if len(candidates) < capacity:
        present = {row['app_key'] for row in candidates}
        for row in eligible:
            if row['app_key'] not in present and not_chosen(row):
                select(row)
                if len(candidates) == capacity:
                    break
    return candidates


def load_historical_identities(root: Path) -> list[dict]:
    """Use the already-built 90-day Lab index; no network or extra collection."""
    path = root / 'data/lab/index.json'
    if not path.is_file():
        return []
    payload = json.loads(path.read_text(encoding='utf-8'))
    if payload.get('schema_version') != 1 or not isinstance(payload.get('items'), list):
        raise ValueError('AI_IDENTITY_INDEX_INVALID')
    return payload['items']


def _save_entry(row: dict, analysis: dict, model: str, generated_at: str, *,
                description: str, origin: str, quota_day: str = '') -> dict:
    record = {
        'app_key': row['app_key'], 'name': row.get('name', ''),
        'developer': row.get('developer', ''),
        'source': row.get('source', ''), 'country': row.get('country', ''),
        'category': row.get('category', ''), 'detail_url': row.get('detail_url', ''),
        'data_date': row.get('data_date', ''),
        'analysed_at': generated_at, 'model': model, 'prompt_version': 'v2',
        'source_description': description, 'analysis': analysis,
        'selection': {
            'score': row.get('priority_score'),
            'reasons': row.get('priority_reasons', []),
            'best_rank': row.get('best_rank'),
            'countries': row.get('countries', []),
        },
        'origin': origin, 'ai_generated': True,
    }
    if quota_day:
        record['quota_day'] = quota_day
    return record


def _load_json(path: Path, *, optional: bool = False) -> dict:
    if optional and not path.is_file():
        return {}
    return json.loads(path.read_text(encoding='utf-8-sig'))


def import_existing(root: Path) -> dict:
    """Reuse offline V2 probe and V2 baseline comparisons without any API calls."""
    existing = load_records(root)
    import_rows = []
    inputs = [
        (root / 'data/staging/ai_probe.json', None),
        (root / 'data/staging/ai_compare.json', 'baseline_v2'),
    ]
    for path, field in inputs:
        if not path.is_file():
            continue
        payload = _load_json(path)
        descriptions = {}
        if field:
            descriptions = {
                row['app_key']: row.get('description', '')
                for row in payload.get('source_descriptions', [])
                if isinstance(row, dict) and row.get('app_key')
            }
            payload = payload.get(field, {})
        if payload.get('prompt_version', 'v2') != 'v2':
            continue
        input_map = {
            row['app_key']: row for row in payload.get('input_apps', [])
            if isinstance(row, dict) and row.get('app_key')
        }
        for analysis in payload.get('items', []):
            if not isinstance(analysis, dict):
                continue
            key = analysis.get('app_key', '')
            if not key or key in existing:
                continue
            row = input_map.get(key)
            if not row:
                continue
            ai_probe.verify_result({'items': [analysis]}, [{'app_key': key}])
            record = _save_entry(row, analysis, payload.get('model', ai_probe.MODEL),
                                 payload.get('generated_at', timestamp()),
                                 description=descriptions.get(key, ''), origin='imported_v2')
            import_rows.append(record)
            existing[key] = record
    # write_records excludes "existing" IDs; build fresh state for atomic persistence.
    persisted = load_records(root)
    count = write_records(root, import_rows, persisted)
    return {'imported': count, 'total': len(persisted)}


RETRYABLE_GEMINI_ERRORS = frozenset({
    'GEMINI_HTTP_502', 'GEMINI_HTTP_503', 'GEMINI_HTTP_504', 'GEMINI_NETWORK_ERROR',
})


def retryable_analysis_error(exc: Exception) -> bool:
    """Malformed model output and transient outages merit a bounded retry.

    Quota exhaustion, authentication, permissions, and invalid requests must
    NEVER continue to drain requests in a loop.
    """
    return isinstance(exc, ValueError) or (
        isinstance(exc, RuntimeError) and str(exc) in RETRYABLE_GEMINI_ERRORS
    )


def analyze_with_retries(selected: list[dict], api_key: str, tracked_invoke, pause) -> dict:
    """Retry the *whole* 5-app response validation (not just the HTTP call)."""
    for attempt in range(3):
        try:
            return ai_probe.analyze(selected, [], api_key, tracked_invoke)
        except Exception as exc:
            if not retryable_analysis_error(exc) or attempt == 2:
                raise
            print(f'[Gemini] 배치 응답/일시적 오류, {attempt + 2}/3번째 시도', flush=True)
            pause(4)


def run(root: Path, *, snapshot: dict, trends: dict, api_key: str = '',
        live: bool = False, limit: int = MAX_DAY_APPS, batch_size: int = MAX_BATCH_SIZE,
        fetch=ai_probe.retrieve_description, invoke=ai_probe.call_gemini,
        pause=time.sleep, run_day: str | None = None) -> dict:
    if not 1 <= limit <= MAX_DAY_APPS or not 1 <= batch_size <= MAX_BATCH_SIZE:
        raise ValueError('AI_INVALID_DAILY_LIMIT')
    existing = load_records(root)
    failed = read_failures(root)
    today = snapshot.get('data_date', '')
    dt.date.fromisoformat(today)  # Reject missing or malformed source date.
    run_day = run_day or kst_now().date().isoformat()
    dt.date.fromisoformat(run_day)
    today_done = analysed_on_day(existing, run_day)
    remaining = max(0, MAX_DAY_APPS - today_done)
    # Requests per Pacific day may be exhausted independently of Korean app count.
    available_requests = max(0, MAX_DAY_REQUESTS - read_request_usage(root, ai_probe.MODEL, pacific_day()))
    effective_limit = min(limit, remaining, available_requests * batch_size)
    queue = (choose_candidates(snapshot, trends, existing, failed, effective_limit,
                               historical_items=load_historical_identities(root))
             if effective_limit else [])
    if not live:
        return {
            'mode': 'preview', 'data_date': today, 'run_day': run_day,
            'already_analysed': len(existing), 'analysed_today': today_done,
            'remaining_today': remaining, 'effective_limit': effective_limit, 'available_requests': available_requests,
            'candidates': queue[:effective_limit], 'eligible_in_queue': len(queue),
        }
    if not api_key:
        raise ValueError('GEMINI_API_KEY_NOT_SET')

    result = {
        'mode': 'live', 'data_date': today, 'run_day': run_day,
        'analysed_today_before': today_done, 'effective_limit': effective_limit,
        'model': ai_probe.MODEL,
        'prompt_version': 'v2', 'already_analysed': len(existing),
        'analysed': 0, 'requests': 0, 'batches': 0, 'details_skipped': 0,
        'failures': [], 'stopped_by_error': '', 'usage_total_tokens': 0,
    }
    batch, attempted = [], 0

    def flush_batch():
        nonlocal batch
        if not batch:
            return True
        selected = batch
        batch = []
        result['batches'] += 1
        def tracked_invoke(payload, key):
            use_request(root, ai_probe.MODEL, pacific_day())
            result['requests'] += 1
            return invoke(payload, key)
        try:
            # Full batch is validated as a unit; never save a partial/mismatched response.
            report = analyze_with_retries(selected, api_key, tracked_invoke, pause)
            # Verify app ID correspondence regardless of JSON ordering.
            by_analysis = {r['app_key']: r for r in report['items']}
            records = [
                _save_entry(row, by_analysis[row['app_key']], report['model'],
                            report['generated_at'], description=row['description'],
                            origin='daily_v3', quota_day=run_day)
                for row in selected
            ]
            added = write_records(root, records, existing)
            result['analysed'] += added
            result['usage_total_tokens'] += report['usage'].get('totalTokenCount') or 0
            for row in selected:
                failed.pop(row['app_key'], None)
            save_failures(root, failed)
            print(f"[AI] 저장 {added}건 · 누적 {len(existing)}건 · 요청 {result['requests']}회")
            # 15 RPM free tier: leave room for network jitter.
            if result['analysed'] < effective_limit:
                pause(4)
            return True
        except Exception as exc:
            # No API key or exception body appears in persisted failure entries.
            code = str(exc) if isinstance(exc, RuntimeError) and str(exc).startswith('GEMINI_') else type(exc).__name__
            recoverable = retryable_analysis_error(exc)
            result['failures'].append({'reason': code[:100], 'batch_size': len(selected)})
            print(f'[AI] 오류 상세: {safe_error_diagnostic(exc, api_key)}',
                  file=sys.stderr, flush=True)
            if recoverable:
                # Avoid trying these exact apps again in today's manual retry.
                for row in selected:
                    record_failure(failed, row['app_key'], run_day, code[:100], 1)
                save_failures(root, failed)
                print(f'[AI] 배치 {len(selected)}건 3회 실패 · 다음 배치 계속 진행', flush=True)
                return True
            result['stopped_by_error'] = code[:100]
            print(f'[AI] 한도/설정 등 복구 불가 오류: {code} · 성공 결과 보존', flush=True)
            return False

    for row in queue:
        if result['analysed'] + len(batch) >= effective_limit:
            break
        attempted += 1
        try:
            desc = fetch(row)
            if len(desc) < MIN_DESCRIPTION:
                raise ValueError('DETAIL_TOO_SHORT')
            batch.append({**row, 'description': desc})
            print(f"[상세정보] OK {row['source']:6} {row['country']:2} {row['name'][:36]}")
        except Exception as exc:
            code = type(exc).__name__
            result['details_skipped'] += 1
            result['failures'].append({'app_key': row['app_key'], 'reason': code})
            record_failure(failed, row['app_key'], today, code, 7 if code == 'ValueError' else 1)
            save_failures(root, failed)
            print(f"[상세정보] SKIP {row['app_key']} ({code})")
            continue
        if len(batch) >= batch_size:
            if not flush_batch():
                break
    else:
        if batch:
            flush_batch()
    # When exiting the loop by the item limit, flush the final partial batch.
    if batch and not result['stopped_by_error']:
        flush_batch()
    result['attempted_details'] = attempted
    result['total_stored'] = len(existing)
    result['remaining_today'] = max(0, MAX_DAY_APPS - today_done - result['analysed'])
    return result


def main() -> int:
    p = argparse.ArgumentParser(description='V3 AI candidate selection and durable V2 analysis storage')
    action = p.add_mutually_exclusive_group()
    action.add_argument('--run', action='store_true', help='Call Gemini and persist results')
    action.add_argument('--import-existing', action='store_true',
                        help='Import previous V2 probe/comparison JSON without Gemini API')
    p.add_argument('--limit', type=int, default=MAX_DAY_APPS)
    p.add_argument('--batch-size', type=int, default=MAX_BATCH_SIZE)
    args = p.parse_args()
    try:
        if args.import_existing:
            summary = import_existing(ROOT)
            print(f"[가져오기] 새로 저장 {summary['imported']}건 / 누적 {summary['total']}건")
            return 0
        latest = _load_json(ROOT / LATEST_FILE)
        trends = _load_json(ROOT / TRENDS_FILE, optional=True)
        result = run(ROOT, snapshot=latest, trends=trends,
                     api_key=ai_probe.load_api_key() if args.run else '',
                     live=args.run, limit=args.limit, batch_size=args.batch_size)
        if not args.run:
            print(f"[미리보기] 데이터 날짜 {result['data_date']} / 기존 분석 {result['already_analysed']}건")
            print(f"[일일 한도] {result['run_day']} 분석 {result['analysed_today']}건 / "
                  f"남은 최대 {result['remaining_today']}건")
            for row in result['candidates']:
                reason = ','.join(row['priority_reasons']) or f"순위 {row['best_rank']}"
                print(f"  {row['source']:6} {row['country']:2} {row['name'][:36]} [{reason}]")
            print('[안내] API 요청 및 파일 수정 없음. 실행하려면 --run 추가.')
        else:
            print(f"[완료] 신규 {result['analysed']}건 / 누적 {result['total_stored']}건 / "
                  f"Gemini 배치 {result['requests']}회 / 상세정보 제외 {result['details_skipped']}건")
            print(f"[일일 한도] {result['run_day']} 남은 최대 {result['remaining_today']}건")
            if result['stopped_by_error']:
                print('[안내] 일시 중단:', result['stopped_by_error'])
                return 2
        return 0
    except Exception as exc:
        # Never print API keys or raw external response bodies in logs.
        print(f'[ERROR] {safe_error_diagnostic(exc)}', file=sys.stderr, flush=True)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
