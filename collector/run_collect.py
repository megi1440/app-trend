"""Run collectors independently. --persist merges FULL runs into durable CSVs."""
import argparse
import subprocess
import sys
from common import ROOT, kst_now


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["smoke", "full"], default="smoke")
    parser.add_argument("--source", choices=["all", "apple", "google", "itch"], default="all")
    parser.add_argument("--country", choices=["all", "US", "JP", "KR"], default="all")
    parser.add_argument("--max-groups", type=int, default=None, help="For short tests only")
    parser.add_argument("--persist", action="store_true", help="Merge FULL results into CSV/JSON")
    args = parser.parse_args()
    if args.persist and (args.mode != "full" or args.max_groups is not None or args.country != "all"):
        parser.error("--persist requires --mode full, --country all and no --max-groups")
    run_date = kst_now().date().isoformat()
    commands = {
        "apple": [sys.executable, str(ROOT / "collector/apple.py"), "--mode", args.mode, "--country", args.country],
        "google": ["node", str(ROOT / "collector/google.mjs"), "--mode", args.mode, "--country", args.country],
        "itch": [sys.executable, str(ROOT / "collector/itch.py"), "--mode", args.mode],
    }
    if args.max_groups is not None:
        for name in ("apple", "google"):
            commands[name].extend(["--max-groups", str(args.max_groups)])
    selected = list(commands) if args.source == "all" else [args.source]
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
        print("\n======= CSV / JSON 저장 =======", flush=True)
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode != 0:
            return result.returncode
        # Staging is transient. Keep only durable CSVs and web JSONs.
        for name in selected:
            (ROOT / "data/staging" / (name + ".json")).unlink(missing_ok=True)
        print("[data] 임시 staging JSON 정리 완료", flush=True)
        # A partial outage should not fail the whole pipeline if other groups
        # were safely persisted. Failures remain visible in status.json.
        return 0
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
