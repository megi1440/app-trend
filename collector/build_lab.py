"""Produce the small, public Idea Lab index from existing observations and Gemini V2 shards.

Never changes the canonical collector files or requests any external API.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# These are *aliases*, not a closed list of allowed tags. Recognizable synonyms
# stay together, while new explicit systems/features in subsequent Gemini records
# become new, source-backed tags without any code or prompt change.
# An alias match means AI mentioned it, NOT that actual app implementation is verified.
TAG_ALIASES = {
    '그리드·블록 배치': r'그리드|블록.{0,8}(배치|퍼즐|맞추)|격자|grid|block placement',
    '합성·머지': r'머지|합성|merge|아이템.{0,5}(결합|조합)',
    '턴·턴제': r'턴제|턴 기반|turn.based|교대.{0,4}진행',
    '사격·전투': r'전투|공격|사격|총격|combat|battle|shoot',
    '타워 디펜스': r'타워 ?디펜스|tower defense|방어 ?타워',
    '캐릭터 성장': r'레벨 ?업|캐릭터.{0,7}성장|스킬 ?트리|능력치.{0,5}강화',
    '수집·인벤토리': r'인벤토리|아이템.{0,6}수집|아이템.{0,6}관리|inventory|수집품',
    '카드·덱': r'카드.{0,9}(덱|수집|선택|전투|조합)|덱.{0,6}(구성|빌딩|관리)|deck.build|card game',
    '방치형·자동 진행': r'방치형|방치 ?보상|idle game|자동.{0,6}(진행|생산|전투|수익)',
    '건설·꾸미기': r'건설|꾸미기|배치.{0,6}(가구|시설|건물)|건물.{0,6}배치|construction',
    '대화·스토리 분기': r'대화.{0,5}(선택|분기|시스템)|스토리.{0,6}분기|선택지|분기.{0,5}(서사|시나리오|이야기)|인터랙티브 서사|dialogue',
    '미션·퀘스트': r'미션|퀘스트|quest',
    '보상·업적': r'업적|보상.{0,5}(시스템|설계|획득|지급)|achievement',
    '캐릭터 상호작용': r'캐릭터.{0,9}(상호작용|대화|교감)|npc.{0,7}(대화|상호작용)',
    '카메라·QR/바코드': r'카메라|바코드|qr ?코드|camera|barcode',
    '위치·지도': r'위치.{0,6}(기반|추적|정보|기록)|지도|gps|map ?view',
    '검색·필터': r'검색.{0,6}(기능|시스템|필터)|필터.{0,6}(기능|시스템|검색)|search.{0,6}filter',
    '기록·이력': r'일지|기록.{0,6}(기능|관리|저장|조회|분석)|히스토리|이력.{0,5}(관리|조회)|트래킹',
    '알림·일정': r'알림|리마인더|일정.{0,5}(관리|등록)|캘린더|notification|reminder',
    '결제·멤버십': r'결제|구독.{0,5}(관리|시스템|기능)|멤버십|payment|subscription',
}
COMPILED_ALIASES = [(label, re.compile(pattern, re.I)) for label, pattern in TAG_ALIASES.items()]

# These are broad *display families*, not an allow-list of feature names.
# Unrecognized, newly collected features are retained under "새로 발견된 기능".
# Users open a family to browse its actual tags, instead of scanning hundreds
# of individual chips. Family assignment never changes the AI source text.
FEATURE_FAMILIES = (
    ('퍼즐·규칙·카드', r'퍼즐|그리드|블록|타일|머지|합성|턴|솔리테어|카드|덱|점수|레벨|난이도|보드|판정|확률|슬롯|룰|규칙|대국|미니게임|힌트|실수|줄 완성'),
    ('전투·액션·물리', r'전투|사격|공격|배틀|발사|물리|충돌|파괴|주행|캐릭터 제어|이동|생존|타워 디펜스|지형|전략|서바이벌|슬로우 모션|속도|오브젝트|영웅 육성'),
    ('수집·성장·경제', r'수집|인벤토리|재화|자원|아이템|업그레이드|강화|보상|업적|성장|채굴|포인트|경제|해금|획득|생산|재고'),
    ('건설·제작·꾸미기', r'건설|건물|시설|제작|꾸미|조립|농작물|농장|동물|마을|크리에이티브|배치|광산'),
    ('스토리·미션·상호작용', r'스토리|대화·스토리|대화|퀘스트|미션|서사|분기|캐릭터 상호작용|협상|거래|토너먼트|npc'),
    ('AI·자동화·추천', r'\bai\b|llm|인공지능|자연어|생성|자동|추천|머신러닝|프롬프트|음성 인식'),
    ('이미지·영상·음성', r'카메라|이미지|영상|음성|오디오|사운드|리듬|애니메이션|파티클|그래픽|스트리밍|바코드|\bqr\b|\btotp\b'),
    ('네트워크·소셜', r'네트워크|멀티플레이어|서버|친구|소셜|커뮤니티|공유|채팅|통신|트래픽|\bdns\b|실시간 동기화|\bapi\b|연동|\bweb\b|웹 렌더링'),
    ('데이터·저장·보안', r'데이터|저장|로드|보안|인증|암호|로그(?![가-힣])|로깅|캐시|계정|다운로드|파일|\bdb\b|동기화|정보 관리|기록|이력|상태 관리|오프라인'),
    ('화면·입력·조작', r'\bui\b|\bux\b|입력|터치|제스처|위젯|탭|인터페이스|설정|화면|사용자 보드|클릭|검색|필터|커스터마이징|씬 전환|이벤트 트리거|출력|표시|의상 변경|\b3d\b'),
    ('생활·위치·일정', r'위치|지도|\bgps\b|일정|알림|건강|운동|운행|시간|계산|결제|멤버십|구독|쇼핑'),
)
COMPILED_FAMILIES = [(name, re.compile(pattern, re.I)) for name, pattern in FEATURE_FAMILIES]
# Confident synonym equivalents only. Broader *related* features stay distinct
# inside a family; never silently merge e.g. "물리 충돌" with "파괴".
EXACT_EQUIVALENTS = {
    '개인화된 추천': '개인화 추천',
    '실시간 멀티플레이어 동기화': '멀티플레이어 동기화',
    '멀티플레이어 네트워크 동기화': '멀티플레이어 동기화',
    '물리 및 충돌 판정': '물리·충돌 판정',
    '물리 엔진 및 충돌 판정': '물리·충돌 판정',
}


def canonical_tag(name: str) -> str:
    name = re.sub(r'\s+', ' ', name.strip())
    return EXACT_EQUIVALENTS.get(name, name)


def feature_family(name: str) -> str:
    """Display-family classification for any current or future tag."""
    for family, pattern in COMPILED_FAMILIES:
        if pattern.search(name):
            return family
    return '새로 발견된 기능'


# Generic technical plumbing is too broad to serve as a useful discovery filter.
GENERIC_SYSTEMS = {
    'ui', 'ui/ux', 'ui 인터페이스', '사용자 인터페이스',
    '게임 상태 관리', '데이터 관리', '데이터베이스', '사용자 데이터베이스',
    '관리', '시스템 관리', '기본 기능', '기본 ui', 'ui 및 게임 상태 제어',
    '사용자 인터페이스 및 데이터 관리', '게임 로직', 'ui 제어',
}
NEGATION_AFTER = re.compile(r'^(?:[은는이가을를도]?)\s*(?:없(?:는|음|다|으며)|미지원|제외|불가능|지원하지|존재하지|사용하지|구현하지)', re.I)
NEGATION_BEFORE = re.compile(r'(?:없음|미지원|제외|불가능|사용하지 않음|구현하지 않음)[\s:·,-]*$', re.I)
DYNAMIC_SUFFIX = re.compile(r'\s*(?:시스템|기능|모듈|로직|알고리즘|인터페이스|엔진)$', re.I)
FEATURE_NAME = re.compile(r'([가-힣A-Za-z0-9][가-힣A-Za-z0-9·/()+ -]{2,48}?)\s+(?:기능|시스템|메커니즘|엔진|모드)(?=을|를|이|가|은|는|과|와|으로|에서|[ .,]|$)', re.I)


def _entries(analysis: dict):
    # Restrict claims to Gemini's explicit features and proposed systems;
    # noteworthy_ko is speculative prose and should not silently create tags.
    for field in ('features_ko', 'systems_ko'):
        value = analysis.get(field)
        if isinstance(value, str):
            value = [value]
        if isinstance(value, list):
            for text in value:
                if isinstance(text, str) and text.strip():
                    yield field, ' '.join(text.split())


def _negated(text: str, start: int, end: int) -> bool:
    """Avoid obvious negative mentions; uncertain phrases are left untagged."""
    after = text[end:end+25]
    before = text[max(0, start-23):start]
    return bool(NEGATION_AFTER.match(after) or NEGATION_BEFORE.search(before)
                or re.match(r'^(?:\s*(?:시스템|기능|요소|모드)[은는이가]?)?\s*(?:이|가|은|는)?\s*없는', after))


def _dynamic_name(text: str) -> str:
    """Extract a short, explicit, human-checkable topic from a Gemini system line."""
    label = re.sub(r'\([^)]{1,35}\)', '', text).strip(' \t-·.,:;!')
    label = DYNAMIC_SUFFIX.sub('', label).strip(' \t-·.,:;!')
    label = re.sub(r'\s+', ' ', label)
    low = label.casefold()
    if (len(label) < 4 or len(label) > 46 or low in GENERIC_SYSTEMS
            or re.fullmatch(r'(?:ui|ux|api|db)(?:[/· ](?:ui|ux|api|db))*', low)
            or re.fullmatch(r'(?:일반|기본|사용자|앱|게임|시스템|데이터|오브젝트|정보|자원|상태|화면|기능)(?:\s+(?:관리|처리|제어|시스템|기능|설계))*', label)):
        return ''
    if re.search(r'(?:없는|미지원|불필요|제외|구현하지|지원하지)', label):
        return ''
    return label


def feature_tags_with_evidence(analysis: dict) -> tuple[list[str], dict[str, list[dict]]]:
    """Open-ended tags + traceable Gemini text, no API call or fixed tag ceiling.

    Explicit aliases unify recurring wording. An unmatched *specific* system
    entry, or a named feature phrase, becomes a new tag. Uncertain free-form
    prose does not produce an arbitrary guessed category.
    """
    evidence: dict[str, list[dict]] = {}

    def add(label: str, field: str, line: str) -> None:
        label = canonical_tag(label)
        if label not in evidence:
            evidence[label] = []
        if len(evidence[label]) < 2 and not any(x['text'] == line for x in evidence[label]):
            evidence[label].append({'field': field, 'text': line[:400]})

    for field, text in _entries(analysis):
        matched = False
        for label, pattern in COMPILED_ALIASES:
            valid = [m for m in pattern.finditer(text) if not _negated(text, *m.span())]
            if valid:
                matched = True
                add(label, field, text)
        if field == 'systems_ko':
            # An explicit Gemini system description can introduce a brand-new
            # feature: e.g. 물리 엔진 충돌 및 파괴, 실시간 멀티플레이어 네트워크.
            if not matched and not re.search(r'(?:없음|미지원|지원하지|없는|제외)', text):
                name = _dynamic_name(text)
                if name:
                    add(name, field, text)
        else:
            # Named features only. Do not turn an entire marketing sentence
            # into a tag or classify from a category/summary alone.
            for match in FEATURE_NAME.finditer(text):
                if _negated(text, *match.span()):
                    continue
                name = _dynamic_name(match.group(1))
                if name and not any(label in evidence and any(e['text'] == text for e in evidence[label])
                                    for label in TAG_ALIASES):
                    add(name, field, text)
    return sorted(evidence, key=str.casefold), evidence


def features_to_tags(analysis: dict) -> list[str]:
    """Compatibility wrapper for consumers of the original builder API."""
    return feature_tags_with_evidence(analysis)[0]


def ai_shard(key: str) -> str:
    return f'{int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:8], 16) % 32:02d}'


def json_read(file: Path) -> dict:
    return json.loads(file.read_text(encoding='utf-8'))


def history_days(day: str, days: int = 90) -> tuple[str, str]:
    end = dt.date.fromisoformat(day)
    return (end - dt.timedelta(days=days - 1)).isoformat(), day


def build(root: Path = ROOT) -> dict:
    data = root / 'data'
    latest = json_read(data / 'web/latest.json')
    trends = json_read(data / 'web/trends.json')
    day = latest['data_date']
    earliest, _ = history_days(day)
    records: dict[str, dict] = {}
    for group in latest.get('groups', []):
        source = group.get('source')
        for row in group.get('items', []):
            key = row.get('app_key')
            if not key:
                continue
            record = records.setdefault(key, {'app_key': key, 'name': '', 'source': source, 'kind': '',
                'developer': '', 'category': '', 'icon_url': '', 'detail_url': '', 'description': '',
                'first_seen': '', 'observations': [], 'signals': [], 'tags': [], 'has_ai': False,
                'ai_shard': None, 'difficulty': '', 'summary': '', 'analysed_at': ''})
            for source_field, target_field in [('name','name'),('kind','kind'),('developer','developer'),
                                                ('primary_category','category'),('icon_url','icon_url'),
                                                ('detail_url','detail_url'),('description','description'),
                                                ('first_seen','first_seen')]:
                if row.get(source_field) and not record[target_field]:
                    record[target_field] = row[source_field]
            record['observations'].append({
                'source': source, 'country': group.get('country'), 'chart': group.get('chart'),
                'category': group.get('category'), 'feed': group.get('feed'),
                'date': group.get('data_date'), 'stale': bool(group.get('is_stale')),
                'rank': row.get('rank'), 'position': row.get('position'),
            })

    # Candidate evidence was derived by the collector. Never manufacture scores.
    for c in trends.get('candidates', []):
        key = c.get('app_key')
        record = records.get(key)
        if not record:
            continue
        if c.get('reason_code') not in {'rising_7d', 'newly_seen', 'multi_country',
                'consistent_30d', 'indie_discovery', 'overseas_interest'}:
            continue
        source_dates = c.get('source_data_dates') or []
        # A stale group or mismatched snapshot cannot become today's momentum.
        if c['reason_code'] in {'rising_7d', 'newly_seen'}:
            if not any(not obs['stale'] and obs['date'] in source_dates for obs in record['observations']):
                continue
        record['signals'].append({'reason_code': c['reason_code'],
            'evidence': c.get('evidence') or {}, 'source_data_dates': source_dates,
            'confidence_note': c.get('confidence_note') or ''})

    # Independently verifiable signals complement (but never replace) trends.json.
    # Rank changes use the *same* source/country/chart/category at two real dates.
    observed_by_group: dict[tuple, dict[str, dict[str, int]]] = defaultdict(lambda: defaultdict(dict))
    seven_start, _ = history_days(day, 7)
    for file in sorted((data / 'rankings').glob('*/*/*.csv')):
        if not seven_start <= file.stem <= day:
            continue
        with file.open(encoding='utf-8-sig', newline='') as stream:
            for row in csv.DictReader(stream):
                try:
                    rank = int(row['rank'])
                except (ValueError, TypeError, KeyError):
                    continue
                group_key = (row.get('source'), row.get('country'), row.get('chart'), row.get('category'))
                observed_by_group[group_key][row.get('app_key', '')][row.get('date', '')] = rank
    for record in records.values():
        fresh = [o for o in record['observations'] if not o['stale'] and o['date'] == day]
        by_chart: dict[tuple, set[str]] = defaultdict(set)
        for o in fresh:
            if o['source'] != 'itch':
                by_chart[(o['source'], o['chart'], o['category'])].add(o['country'])
        for (source, chart, category), countries in by_chart.items():
            if len(countries) > 1 and not any(s['reason_code'] == 'multi_country'
                    and s['evidence'].get('source') == source and s['evidence'].get('category') == category
                    for s in record['signals']):
                record['signals'].append({'reason_code': 'multi_country',
                    'evidence': {'source': source, 'chart': chart, 'category': category,
                                 'countries': sorted(countries)}, 'source_data_dates': [day],
                    'confidence_note': '같은 스토어·차트·카테고리에서 관측된 국가 목록입니다.'})
        for o in fresh:
            if o['source'] == 'itch':
                continue
            group_key = (o['source'], o['country'], o['chart'], o['category'])
            series = observed_by_group.get(group_key, {}).get(record['app_key'], {})
            days = sorted(d for d in series if seven_start <= d <= day)
            if len(days) < 2 or days[-1] != day:
                continue
            before, after = days[0], days[-1]
            change = series[before] - series[after]
            if change > 0 and not any(s['reason_code'] == 'rising_7d' and
                    all(s['evidence'].get(k) == v for k, v in zip(('source', 'country', 'chart', 'category'), group_key))
                    for s in record['signals']):
                record['signals'].append({'reason_code': 'rising_7d',
                    'evidence': {'source': o['source'], 'country': o['country'], 'chart': o['chart'],
                                 'category': o['category'], 'before_date': before, 'after_date': after,
                                 'before_rank': series[before], 'after_rank': series[after], 'change': change},
                    'source_data_dates': [before, after],
                    'confidence_note': '실제로 관측된 두 날짜의 동일 차트 순위 차이이며 7일 연속 관측은 아닙니다.'})

    ai_total = 0
    newest_ai = ''
    for file in sorted((data / 'ai/items').glob('*.json')):
        try:
            obj = json_read(file)
        except (ValueError, OSError) as exc:
            print(f'[lab] 경고: AI 샤드 {file.name}을 읽지 못했습니다: {exc}')
            continue
        for key, ai in (obj.get('items') or {}).items():
            if not isinstance(ai, dict) or not isinstance(ai.get('analysis'), dict):
                continue
            ai_total += 1
            newest_ai = max(newest_ai, str(ai.get('analysed_at') or ''))
            record = records.setdefault(key, {'app_key': key, 'name': '', 'source': ai.get('source', key.split(':')[0]),
                'kind': 'game' if ai.get('source') == 'itch' else '', 'developer': '', 'category': '',
                'icon_url': '', 'detail_url': '', 'description': '', 'first_seen': '',
                'observations': [], 'signals': [], 'tags': [], 'has_ai': False,
                'ai_shard': None, 'difficulty': '', 'summary': '', 'analysed_at': ''})
            a = ai['analysis']
            # AI-only historical items are available in analysis, not fabricated as currently observed.
            record['name'] = record['name'] or ai.get('name') or key
            record['detail_url'] = record['detail_url'] or ai.get('detail_url') or ''
            record['category'] = record['category'] or ai.get('category') or ''
            record['has_ai'] = True
            record['ai_shard'] = ai_shard(key)
            record['tags'], record['tag_evidence'] = feature_tags_with_evidence(a)
            record['difficulty'] = str((a.get('difficulty_ko') or {}).get('level') or '')
            record['summary'] = str(a.get('summary_ko') or '')[:240]
            record['analysed_at'] = ai.get('analysed_at') or ''

    # Itch feeds are not ranked charts: retain observation date, feed and position verbatim.
    indie_history: dict[str, list[dict]] = defaultdict(list)
    for file in sorted((data / 'discoveries').glob('*/*/*.csv')):
        if not earliest <= file.stem <= day:
            continue
        with file.open(encoding='utf-8-sig', newline='') as stream:
            for row in csv.DictReader(stream):
                key = row.get('app_key')
                if not key or not row.get('date') or not row.get('feed'):
                    continue
                try:
                    position = int(row['position'])
                except (TypeError, ValueError):
                    continue
                indie_history[key].append({'date': row['date'], 'source': 'itch',
                    'country': 'GLOBAL', 'feed': row['feed'], 'position': position})

    # Ordering is deterministic; priority only orders evidence, never becomes a public score.
    for rec in records.values():
        rec['observations'].sort(key=lambda o: (o['stale'], -(int((o['date'] or '0000-00-00').replace('-', ''))),
            9999 if o['rank'] is None else o['rank'], o['country'] or ''))
    tag_groups = {tag: feature_family(tag) for rec in records.values() for tag in rec['tags']}
    results = {'schema_version': 1, 'generated_at': max(str(latest.get('generated_at') or ''), newest_ai, f'{day}T00:00:00+09:00'),
               'data_date': day, 'ai_count': ai_total, 'tag_groups': dict(sorted(tag_groups.items())),
               'items': sorted(records.values(), key=lambda r: (not bool(r['observations']), r['name'].casefold(), r['app_key']))}
    lab_dir = data / 'lab'
    lab_dir.mkdir(exist_ok=True)
    (lab_dir / 'index.json').write_text(json.dumps(results, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (lab_dir / 'indie_history.json').write_text(json.dumps(indie_history, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'[lab] {day} / entries {len(records)} / AI {ai_total} / indie history {len(indie_history)}')
    return {'entries': len(records), 'ai_count': ai_total, 'indie_history': len(indie_history)}


if __name__ == '__main__':
    build()
