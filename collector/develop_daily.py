"""Gemini 3.5 V8 High: one source-linked brief plus its development draft per app.

Runs after the unchanged Gemini 3.1 workflow. Saves each successful stage for
resume, publishes only completed pairs. Daily quota is model-specific; retry
and temporary 503 errors do not lose previously saved results.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from pathlib import Path

import ai_daily
import ai_probe
import development_prompt as prompt
from common import ROOT, atomic_json, kst_now, timestamp

MODEL = 'gemini-3.5-flash-lite'
API_URL = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'
SHARDS = Path('data/development/items')
INDEX = Path('data/development/index.json')
FAILURES = Path('data/development/failures.json')
PROMPT_VERSION = 'gemini35_source_linked_brief_and_draft_v8'
SCHEMA_VERSION = 2
MAX_REQUESTS = 500  # Only 3.5; Gemini 3.1 retains its existing 450 request safety cap.
BATCH = 5            # Progress groups of 5 candidates, with two individual API calls each.
RETRY_ATTEMPTS = 2


def shard_name(key: str) -> str:
    return f'{int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:8], 16) % 32:02d}.json'


def reset_old_35(root: Path) -> bool:
    """Drop only legacy 3.5 results (explicitly requested, no backup). Never touch 3.1."""
    idx = root / INDEX
    if not idx.exists():
        # Unindexed old shards must not silently become V8 data.
        legacy = list((root / SHARDS).glob('*.json'))
        if not legacy:
            return False
    else:
        obj = json.loads(idx.read_text(encoding='utf-8'))
        if obj.get('schema_version') == SCHEMA_VERSION and obj.get('prompt_version') == PROMPT_VERSION:
            return False
    for p in (root / SHARDS).glob('*.json'):
        p.unlink()
    # Rebuild an empty V8 index immediately so no old report appears on the web.
    (root / FAILURES).unlink(missing_ok=True)
    save_index(root, {})
    print('[3.5] 예전 30개 검토서/5개 설계 데이터 초기화 · 3.1 자료 유지', flush=True)
    return True


def read_records(root: Path) -> dict:
    found = {}
    for path in sorted((root / SHARDS).glob('*.json')):
        doc = json.loads(path.read_text(encoding='utf-8'))
        if doc.get('schema_version') != SCHEMA_VERSION or not isinstance(doc.get('items'), dict):
            raise ValueError('DEVELOPMENT_INVALID_SHARD')
        for key, row in doc['items'].items():
            if not isinstance(row, dict) or row.get('app_key') != key or shard_name(key) != path.name or key in found:
                raise ValueError('DEVELOPMENT_INVALID_RECORD')
            found[key] = row
    return found


def put_stage(root: Path, records: dict, source: dict, stage: str, content: dict, day: str,
              usage: dict | None = None) -> bool:
    if stage not in ('brief', 'plan'):
        raise ValueError('DEVELOPMENT_INVALID_STAGE')
    key = source['app_key']
    row = dict(records.get(key) or {
        'app_key': key, 'name': source.get('name', ''), 'developer': source.get('developer', ''),
        'source': source.get('source', ''), 'kind': source.get('kind', ''),
        'detail_url': source.get('detail_url', ''), 'model': MODEL,
        'prompt_version': PROMPT_VERSION, 'thinking_level': 'HIGH',
        'based_on': 'store_description_and_gemini_3_1',
    })
    if row.get(stage):
        return False
    row[stage] = content
    row[stage + '_at'] = timestamp()
    row[stage + '_quota_day'] = day
    row[stage + '_usage'] = usage or {}
    shard = root / SHARDS / shard_name(key)
    doc = json.loads(shard.read_text(encoding='utf-8')) if shard.exists() else {'schema_version': SCHEMA_VERSION, 'items': {}}
    if doc.get('schema_version') != SCHEMA_VERSION:
        raise ValueError('DEVELOPMENT_INVALID_SHARD')
    doc['items'][key] = row
    atomic_json(shard, doc)
    records[key] = row
    return True


def save_index(root: Path, records: dict) -> int:
    # Never surface half-pairs: a brief without its matching plan is pending.
    items = [dict((k, r.get(k, '')) for k in ('app_key', 'name', 'developer', 'source', 'kind', 'detail_url')) |
             {'brief': True, 'plan': True, 'shard': shard_name(key)[:-5],
              'brief_at': r.get('brief_at', ''), 'plan_at': r.get('plan_at', ''),
              'prompt_version': PROMPT_VERSION}
             for key, r in records.items() if r.get('brief') and r.get('plan')]
    items.sort(key=lambda r: (r['name'].casefold(), r['app_key']))
    payload = {'schema_version': SCHEMA_VERSION, 'model': MODEL, 'prompt_version': PROMPT_VERSION,
               'thinking_level': 'HIGH', 'generated_at': timestamp(), 'brief_count': len(items),
               'plan_count': len(items), 'pending_briefs': sum(bool(r.get('brief')) and not r.get('plan') for r in records.values()),
               'items': items}
    p = root / INDEX
    if p.exists():
        existing = json.loads(p.read_text(encoding='utf-8'))
        if all(existing.get(k) == payload[k] for k in ('schema_version', 'model', 'prompt_version', 'brief_count', 'plan_count', 'pending_briefs', 'items')):
            return len(items)
    atomic_json(p, payload)
    return len(items)


def read_failures(root: Path, day: str) -> set[str]:
    path = root / FAILURES
    if not path.exists():
        return set()
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schema_version') != 1 or not isinstance(doc.get('by_day'), dict):
        raise ValueError('DEVELOPMENT_INVALID_FAILURES')
    return set(doc['by_day'].get(day) or [])


def mark_failure(root: Path, day: str, key: str) -> None:
    path = root / FAILURES
    doc = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'schema_version': 1, 'by_day': {}}
    keys = set(doc['by_day'].get(day) or [])
    keys.add(key)
    doc['by_day'][day] = sorted(keys)
    doc['by_day'] = {day: doc['by_day'][day]}  # No need to retain daily transient failures.
    atomic_json(path, doc)


def make_source(row: dict) -> dict:
    a = row.get('analysis') or {}
    return {
        'app_key': row['app_key'], 'name': row.get('name', ''),
        'product_kind_from_catalog': row.get('kind', ''),
        'source': row.get('source', ''), 'category': row.get('category', ''),
        'country': row.get('country', ''),
        'store_description_original': str(row.get('source_description') or '')[:7000],
        'store_url': row.get('detail_url', ''),
        'observation': {'data_date': row.get('data_date', ''),
                        'best_observed_rank': (row.get('selection') or {}).get('best_rank'),
                        'note': '관측 순위는 흥행 원인, 다운로드, 매출 증거가 아니다.'},
        'gemini_3_1_interpretation_not_confirmed_facts': {
            k: a.get(k) for k in ('summary_ko', 'features_ko', 'noteworthy_ko',
                                  'systems_ko', 'difficulty_ko', 'source_limitations_ko')},
        'input_boundaries': ['원본 스토어 정보와 AI 해석을 구분한다.',
                             '원작을 플레이하지 않았으며 내부 규칙을 알 수 없다.',
                             '이전 3.1·3.5의 응용 아이디어는 입력에 사용하지 않는다.'],
    }


def make_payload(source: dict, stage: str, brief: dict | None = None) -> dict:
    if stage not in ('brief', 'plan'):
        raise ValueError('DEVELOPMENT_INVALID_STAGE')
    ctx = {'source': source}
    if stage == 'plan':
        if not brief:
            raise ValueError('DEVELOPMENT_BRIEF_REQUIRED')
        concepts = brief['new_concepts_ko']
        n = brief['recommended_concept_number']
        ctx['selected_concept'] = concepts[n - 1]
        ctx['reason_selected'] = brief['why_recommended_ko']
        ctx['important_original_elements'] = brief['valuable_elements_ko']
    return {'systemInstruction': {'parts': [{'text': prompt.SYSTEM}]},
            'contents': [{'role': 'user', 'parts': [{'text': (prompt.BRIEF if stage == 'brief' else prompt.PLAN) +
                '\n입력 자료(JSON):\n' + json.dumps(ctx, ensure_ascii=False)}]}],
            'generationConfig': {'thinkingConfig': {'thinkingLevel': 'HIGH'},
                                 'maxOutputTokens': 20000 if stage == 'brief' else 24000,
                                 'responseFormat': {'text': {'mimeType': 'APPLICATION_JSON',
                                             'schema': prompt.brief_schema() if stage == 'brief' else prompt.plan_schema()}}}}


def verify(response: dict, source: dict, stage: str, brief: dict | None = None) -> dict:
    rows = response.get('items') if isinstance(response, dict) else None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        raise ValueError('DEVELOPMENT_INVALID_ITEMS')
    row = rows[0]
    if row.get('app_key') != source['app_key'] or row.get('product_kind') != source['product_kind_from_catalog']:
        raise ValueError('DEVELOPMENT_INVALID_IDENTITY')
    if stage == 'brief':
        concepts = row.get('new_concepts_ko')
        n = row.get('recommended_concept_number')
        if not isinstance(concepts, list) or len(concepts) != 3 or type(n) is not int or n not in (1,2,3):
            raise ValueError('DEVELOPMENT_INVALID_CONCEPTS')
        if any(not isinstance(x, dict) or not all(isinstance(x.get(k), str) and x[k].strip()
               for k in ('title_ko', 'core_idea_ko', 'what_to_keep_ko', 'what_to_change_ko',
                         'mobile_use_or_play_ko', 'solo_mvp_and_effort_ko')) for x in concepts):
            raise ValueError('DEVELOPMENT_INVALID_CONCEPT_DETAILS')
    else:
        selected = brief['new_concepts_ko'][brief['recommended_concept_number'] - 1]
        if row.get('selected_concept_title_ko') != selected['title_ko']:
            raise ValueError('DEVELOPMENT_SELECTED_CONCEPT_MISMATCH')
    return row


def call_model(payload: dict, key: str) -> dict:
    req = urllib.request.Request(API_URL, data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=150) as res:
            body = res.read(800_001)
    except urllib.error.HTTPError as exc:
        print(f'[3.5] HTTP {exc.code}: {ai_probe.safe_gemini_error(exc,key)}', file=sys.stderr)
        raise RuntimeError(f'GEMINI_HTTP_{exc.code}') from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError('GEMINI_NETWORK_ERROR') from None
    if len(body) > 800_000:
        raise ValueError('DEVELOPMENT_RESPONSE_TOO_LARGE')
    envelope = json.loads(body.decode('utf-8'))
    candidate = (envelope.get('candidates') or [None])[0]
    if not candidate or candidate.get('finishReason') != 'STOP':
        raise ValueError('DEVELOPMENT_INCOMPLETE_RESPONSE')
    raw = ''.join(str(p.get('text') or '') for p in (candidate.get('content') or {}).get('parts', []))
    if not raw:
        raise ValueError('DEVELOPMENT_EMPTY_RESPONSE')
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError('DEVELOPMENT_INVALID_JSON') from None
    result['_usageMetadata'] = envelope.get('usageMetadata') or {}
    return result


def identity_groups(root: Path, first: dict) -> dict:
    latest = json.loads((root / ai_daily.LATEST_FILE).read_text(encoding='utf-8'))
    historical = ai_daily.load_historical_identities(root)
    return ai_daily.cross_store_pairs(latest, [*historical, *first.values()])


def choose(root: Path, first: dict, records: dict) -> list[dict]:
    """Prefer incomplete pairs; balance sources for new candidates, dedupe store twins."""
    pairs = identity_groups(root, first)
    groups = defaultdict(list)
    for key, r in first.items():
        group = tuple(sorted(pairs.get(key) or (key,)))
        groups[group].append(r)
    pending, buckets = [], {'apple': [], 'google': [], 'itch': []}
    for members, rows in groups.items():
        if any(records.get(k, {}).get('plan') for k in members):
            continue
        incomplete = [r for r in rows if records.get(r['app_key'], {}).get('brief')]
        if incomplete:
            pending.append(incomplete[0])
            continue
        rows = [r for r in rows if isinstance(r.get('analysis'), dict) and r.get('kind') in ('app','game')]
        if not rows:
            continue
        def priority(r):
            d = (r.get('analysis') or {}).get('difficulty_ko') or {}
            return (0 if (d.get('level') or '') == '쉬움' else 1,
                    0 if (r.get('selection') or {}).get('reasons') and 'newly_seen' in (r.get('selection') or {}).get('reasons') else 1,
                    r.get('data_date') or '', r['app_key'])
        rows.sort(key=priority)
        chosen = rows[0]
        buckets.setdefault(chosen.get('source'), []).append(chosen)
    pending.sort(key=lambda r: r['app_key'])
    for group in buckets.values():
        group.sort(key=lambda r: (0 if (r.get('analysis') or {}).get('difficulty_ko',{}).get('level') == '쉬움' else 1,
                                   r['app_key']))
    ordered = list(pending)
    q = {k: deque(v) for k, v in buckets.items()}
    while any(q.values()):
        for source in ('apple', 'google', 'itch'):
            if q.get(source):
                ordered.append(q[source].popleft())
    return ordered


def run(root: Path, *, live: bool = False, api_key: str = '', limit: int = 10000,
        invoke=call_model, pause=time.sleep, run_day: str | None = None) -> dict:
    if limit < 1:
        raise ValueError('DEVELOPMENT_INVALID_LIMIT')
    day = run_day or kst_now().date().isoformat()
    dt.date.fromisoformat(day)
    if live:
        reset_old_35(root)
    first = ai_daily.load_records(root)
    # Gemini 3.1 shards intentionally do not contain a kind field. The catalog
    # is authoritative for app/game classification; never infer it from a name.
    catalog = root / 'data/apps.csv'
    kinds = {}
    if catalog.exists():
        with catalog.open(encoding='utf-8-sig', newline='') as fh:
            kinds = {r['app_key']: r.get('kind', '') for r in csv.DictReader(fh)}
    for key, row in first.items():
        row['kind'] = kinds.get(key) or row.get('kind') or (
            'game' if str(row.get('category') or '').startswith('game_') else
            'app' if str(row.get('category') or '').startswith('app_') else '')
    if not live and (root / INDEX).exists():
        idx = json.loads((root / INDEX).read_text(encoding='utf-8'))
        if idx.get('schema_version') != SCHEMA_VERSION:
            records = {}  # Preview legacy data without modifying it.
        else:
            records = read_records(root)
    else:
        records = read_records(root)
    skipped_today = read_failures(root, day)
    queue = [row for row in choose(root, first, records) if row['app_key'] not in skipped_today][:limit]
    available = max(0, MAX_REQUESTS - ai_daily.read_request_usage(root, MODEL, ai_daily.pacific_day()))
    result = {'mode': 'live' if live else 'preview', 'model': MODEL, 'thinking_level': 'HIGH',
              'prompt_version': PROMPT_VERSION, 'run_day': day, 'candidate_count': len(queue),
              'candidate_briefs': [r['app_key'] for r in queue[:5] if not records.get(r['app_key'],{}).get('brief')],
              'candidate_plans': [r['app_key'] for r in queue[:5] if records.get(r['app_key'],{}).get('brief')],
              'available_requests': available, 'new_briefs': 0, 'new_plans': 0,
              'completed_pairs': 0, 'requests': 0, 'stopped_by_error': '', 'failed_candidates': [],
              'total_tokens': 0}
    if not live:
        return result
    if not api_key:
        raise ValueError('GEMINI_API_KEY_NOT_SET')

    def make_call(source, stage, brief):
        for attempt in range(RETRY_ATTEMPTS + 1):
            try:
                ai_daily.use_request(root, MODEL, ai_daily.pacific_day(), max_requests=MAX_REQUESTS)
                result['requests'] += 1
                output = invoke(make_payload(source, stage, brief), api_key)
                content = verify(output, source, stage, brief)
                usage = output.get('_usageMetadata') or {}
                result['total_tokens'] += int(usage.get('totalTokenCount') or 0)
                return content, usage
            except Exception as exc:
                code = str(exc)
                if code == 'GEMINI_LOCAL_REQUEST_LIMIT':
                    result['stopped_by_error'] = code
                    return None
                # 429 may be an exhausted daily project quota. Avoid burning the limit.
                if code == 'GEMINI_HTTP_429':
                    result['stopped_by_error'] = code
                    return None
                temporary = isinstance(exc, ValueError) or ai_daily.retryable_analysis_error(exc)
                if temporary and attempt < RETRY_ATTEMPTS:
                    print(f'[3.5] {stage} 잠시 오류, 재시도 {attempt + 2}/{RETRY_ATTEMPTS+1}', flush=True)
                    pause(5 * (attempt + 1))
                    continue
                if temporary:
                    print(f'[3.5] {source["app_key"]} {stage} 3회 실패 · 다음 후보', flush=True)
                    result['failed_candidates'].append({'app_key': source['app_key'], 'stage': stage,
                                                        'reason': type(exc).__name__})
                    mark_failure(root, day, source['app_key'])
                    return None
                result['stopped_by_error'] = code if code.startswith('GEMINI_') else type(exc).__name__
                print('[3.5] 중단: ' + ai_daily.safe_error_diagnostic(exc, api_key), file=sys.stderr)
                return None

    try:
        for num, row in enumerate(queue, 1):
            key = row['app_key']
            source = make_source(row)
            rec = records.get(key, {})
            if not rec.get('brief'):
                ret = make_call(source, 'brief', None)
                if not ret:
                    if result['stopped_by_error']:
                        break
                    continue
                content, usage = ret
                put_stage(root, records, row, 'brief', content, day, usage)
                result['new_briefs'] += 1
                rec = records[key]
                pause(4.2)
            if not rec.get('plan'):
                ret = make_call(source, 'plan', rec['brief'])
                if not ret:
                    if result['stopped_by_error']:
                        break
                    continue
                content, usage = ret
                put_stage(root, records, row, 'plan', content, day, usage)
                result['new_plans'] += 1
                result['completed_pairs'] += 1
            save_index(root, records)
            if num % BATCH == 0:
                print(f'[3.5 HIGH] {num}/{len(queue)} 후보 처리 · 새 검토서 {result["new_briefs"]} / 설계 초안 {result["new_plans"]} · 요청 {result["requests"]}', flush=True)
            pause(4.2)
    finally:
        save_index(root, records)
    result['total_briefs'] = sum(bool(r.get('brief')) for r in records.values())
    result['total_plans'] = sum(bool(r.get('plan')) for r in records.values())
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description='Gemini 3.5 High V8 development brief and draft generator')
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--limit', type=int, default=10000, help='최대 후보 수(요청 한도는 별도 500회)')
    args = parser.parse_args()
    try:
        result = run(ROOT, live=args.run, api_key=ai_probe.load_api_key() if args.run else '', limit=args.limit)
        if not args.run:
            print(f'[미리보기] 미완료 후보 {result["candidate_count"]}건 · 현재 추가 요청 여유 {result["available_requests"]}회')
        print(f'[3.5 High] 새 검토서 {result["new_briefs"]} · 새 설계 초안 {result["new_plans"]} · API {result["requests"]}회')
        if result['stopped_by_error'] and result['stopped_by_error'] not in ('GEMINI_LOCAL_REQUEST_LIMIT', 'GEMINI_HTTP_429'):
            return 2
        return 0
    except Exception as exc:
        print('[3.5] 오류: ' + ai_daily.safe_error_diagnostic(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
