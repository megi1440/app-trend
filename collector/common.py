"""Step 1: collector protocol only. No persistent CSV modifications yet."""
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "sources.json"
STAGING = ROOT / "data" / "staging"
USER_AGENT = "app-trend/1.0 (personal public-app-chart research; once daily)"


def kst_now():
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))


def timestamp():
    return kst_now().isoformat(timespec="seconds")


def config():
    with CONFIG_PATH.open(encoding="utf-8") as fp:
        return json.load(fp)


def fetch_bytes(url, timeout=18, retries=1):
    """Bounded retry, never bypass blocks or scrape login walls."""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json,application/rss+xml,application/xml;q=0.8"})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                body = response.read(5_000_001)
                if len(body) > 5_000_000:
                    raise ValueError("RESPONSE_TOO_LARGE")
                return body
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == retries:
                raise RuntimeError(f"NETWORK_ERROR: {type(exc).__name__}") from exc


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".tmp-", suffix=".json", delete=False) as fp:
        tmp = Path(fp.name)
        try:
            json.dump(value, fp, ensure_ascii=False, indent=2)
            fp.write("\n")
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    os.replace(tmp, path)


def group(source, country, chart=None, category=None, feed=None, status="failed", items=None, message=""):
    return {
        "source": source,
        "country": country,
        "chart": chart,
        "category": category,
        "feed": feed,
        "status": status,
        "attempted_at": timestamp(),
        "item_count": len(items or []),
        "items": items or [],
        "message": str(message)[:300],
    }


def validate_items(items, maximum):
    """Preserve true source positions; discard invalid/duplicate entries (no renumbering)."""
    found_ids, found_positions = set(), set()
    valid = []
    for item in items[:maximum]:
        if not isinstance(item, dict):
            continue
        key, url, pos = item.get("app_key"), item.get("detail_url"), item.get("position")
        if not key or not isinstance(url, str) or not url.startswith("https://") or not isinstance(pos, int) or pos < 1:
            continue
        if key in found_ids or pos in found_positions:
            continue
        found_ids.add(key)
        found_positions.add(pos)
        valid.append(item)
    return valid
