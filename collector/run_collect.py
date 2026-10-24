"""Run collectors independently. --persist merges FULL runs into durable CSVs."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys
from common import ROOT, kst_now, atomic_json
from zoneinfo import ZoneInfo


def incomplete_groups(root: Path, run_date: str) -> list[dict]:
    """Today's failed/partial groups, never groups successfully completed already.

    Stop safely if the status is stale/missing, rather than accidentally scraping
    all sources under a retry-only invocation.
    """
    path = root / 'data/web/status.json'
    if not path.exists():
        raise ValueError('RETRY_STATUS_MISSING')
    status = json.loads(path.read_text(encoding='utf-8'))
    finished = dt.datetime.fromisoformat(status['finished_at'].replace('Z', '+00:00'))
    if (finished.tzinfo is None or
            finished.astimezone(ZoneInfo('Asia/Seoul')).date().isoformat() != run_date or
            status.get('overall_status') not in ('partial', 'success') or
            not status.get('accepted_groups')):
        raise ValueError('RETRY_STATUS_NOT_TODAY')
    return [
        {k: group.get(k) for k in ('source', 'country', 'chart', 'category', 'feed')}
        for group in status.get('groups', [])
        if group.get('source') in ('apple', 'google', 'itch')
        and group.get('status') in ('failed', 'partial')
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["smoke", "full"], default="smoke")
    parser.add_argument("--source", choices=["all", "apple", "google", "itch"], default="all")
    parser.add_argument("--country", choices=["all", "US", "JP", "KR"], default="all")
    parser.add_argument("--max-groups", type=int, default=None, help="For short tests only")
    parser.add_argument("--persist", action="store_true", help="Merge FULL results into CSV/JSON")
    parser.add_argument("--retry-failed", action="store_true", help="Retry only incomplete groups from today")
    args = parser.parse_args()
    if args.persist and (args.mode != "full" or args.max_groups is not None or args.country != "all"):
        parser.error("--persist requires --mode full, --country all and no --max-groups")
    run_date = kst_now().date().isoformat()
    if args.retry_failed and (not args.persist or args.source != 'all'):
        parser.error('--retry-failed requires --persist and --source all')
    targets = incomplete_groups(ROOT, run_date) if args.retry_failed else []
    if args.retry_failed and not targets:
        print('[SKIP] 재수집할 실패 그룹 없음', flush=True)
        return 0
    groups_file = ROOT / 'data/staging/retry_groups.json'
    if args.retry_failed:
        atomic_json(groups_file, {'groups': targets})
        print(f'[RETRY] 성공 그룹 제외, 실패/부분 그룹 {len(targets)}개만 재수집', flush=True)
    commands = {
        "apple": [sys.executable, str(ROOT / "collector/apple.py"), "--mode", args.mode, "--country", args.country],
        "google": ["node", str(ROOT / "collector/google.mjs"), "--mode", args.mode, "--country", args.country],
        "itch": [sys.executable, str(ROOT / "collector/itch.py"), "--mode", args.mode],
    }
    if args.max_groups is not None:
        for name in ("apple", "google"):
            commands[name].extend(["--max-groups", str(args.max_groups)])
    selected = list(commands) if args.source == "all" else [args.source]
    if args.retry_failed:
        selected = [source for source in selected if any(x['source'] == source for x in targets)]
        for source in commands:
            (ROOT / 'data/staging' / (source + '.json')).unlink(missing_ok=True)
        for source in selected:
            commands[source].extend(['--only-groups', str(groups_file)])
    failures = []
    for name in selected:
        # Removing a previous staging snapshot is essential: a crashed collector
        # must never accidentally import yesterday's successful JSON.
        staging_path = ROOT / "data/staging" / (name + ".json")
        staging_path.unlink(missing_ok=True)
        print(f"\n======= {name.upper()} ({args.mode}) =======", flush=True)
        try:
            result = subprocess.run(commands[name], cwd=ROOT, check=False)
            if result.returncode != 0:
                failures.append(name)
        except FileNotFoundError as exc:
            print(f"[ERROR] {name}: executable missing: {exc}", flush=True)
            failures.append(name)
    print(f"\nCollector results: {len(selected) - len(failures)} with at least one valid group; failed: {', '.join(failures) or 'none'}", flush=True)
    if args.persist:
        command = [sys.executable, str(ROOT / "collector/process_data.py"), "--date", run_date, "--source", args.source]
        if args.retry_failed:
            command.extend(['--only-groups', str(groups_file)])
        print("\n======= CSV / JSON 저장 =======", flush=True)
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode != 0:
            if args.retry_failed:
                groups_file.unlink(missing_ok=True)
            return result.returncode
        # Staging is transient. Keep only durable CSVs and web JSONs.
        for name in selected:
            (ROOT / "data/staging" / (name + ".json")).unlink(missing_ok=True)
        if args.retry_failed:
            groups_file.unlink(missing_ok=True)
        print("[data] 임시 staging JSON 정리 완료", flush=True)
        # A partial outage should not fail the whole pipeline if other groups
        # were safely persisted. Failures remain visible in status.json.
        return 0
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
