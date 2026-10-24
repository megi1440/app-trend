"""Read itch.io public RSS; no account or API key."""
import argparse
import hashlib
import json
from pathlib import Path
import html
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlsplit, urlunsplit

from common import STAGING, atomic_json, config, fetch_bytes, group, timestamp, validate_items


def canonical_url(raw):
    raw = (raw or "").strip()
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.hostname or not (parsed.hostname == "itch.io" or parsed.hostname.endswith(".itch.io")):
        return ""
    return urlunsplit(("https", parsed.netloc.lower(), parsed.path.rstrip("/") or "/", "", ""))


def strip_html(value):
    return html.unescape(re.sub(r"<[^>]*>", " ", value or "")).strip()


def parse_rss(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = root.findall("./channel/item")
    if root.tag != "rss" or root.find("./channel") is None:
        raise ValueError("INVALID_RSS_SCHEMA")
    output = []
    for position, row in enumerate(items, start=1):
        detail = canonical_url(row.findtext("link", ""))
        if not detail:
            continue
        # Key is deterministic from canonical game URL, not mutable RSS GUID.
        source_id = hashlib.sha256(detail.encode("utf-8")).hexdigest()[:20]
        description = row.findtext("description", "") or ""
        creator = row.findtext("author", "") or ""
        media = row.find("{http://search.yahoo.com/mrss/}content")
        thumb = row.find("{http://search.yahoo.com/mrss/}thumbnail")
        image = ""
        if media is not None:
            image = media.get("url", "")
        if not image and thumb is not None:
            image = thumb.get("url", "")
        if not image:
            found = re.search(r'<img[^>]+src=["\']([^"\']+)', description, re.I)
            image = html.unescape(found.group(1)) if found else ""
        output.append({"position": position, "app_key": f"itch:{source_id}", "source_id": source_id,
                       "kind": "game", "name": row.findtext("title", "") or "", "developer": creator,
                       "primary_category": "", "description": strip_html(description)[:1200],
                       "icon_url": image if image.startswith("https://") else "", "detail_url": detail,
                       "release_date": ""})
    return output


def collect(feeds, sleep_sec=0.7):
    groups = []
    for feed, url in feeds.items():
        kwargs = dict(source="itch", country="GLOBAL", feed=feed)
        if not url.startswith("https://itch.io/"):
            groups.append(group(**kwargs, status="skipped", message="FEED_NOT_CONFIGURED"))
            continue
        try:
            parsed = parse_rss(fetch_bytes(url))
            items = validate_items(parsed, 100)
            if not items:
                raise ValueError("EMPTY_OR_INVALID_FEED")
            count_bad = len(parsed) - len(items)
            groups.append(group(**kwargs, status="partial" if count_bad else "success", items=items,
                                message=f"INVALID_ITEMS:{count_bad}" if count_bad else ""))
        except Exception as exc:
            groups.append(group(**kwargs, status="failed", message=f"{type(exc).__name__}: {exc}"))
        time.sleep(sleep_sec)
    return groups


def main():
    p = argparse.ArgumentParser(description="itch.io public RSS collection (staging only)")
    p.add_argument("--mode", choices=["smoke", "full"], default="smoke")
    p.add_argument("--feed", choices=["all", "featured", "new", "puzzle", "idle"], default="all")
    p.add_argument("--only-groups", default="")
    args = p.parse_args()
    feeds = config()["itch_feeds"]
    if args.feed != "all":
        feeds = {args.feed: feeds[args.feed]}
    if args.only_groups:
        targets = json.loads(Path(args.only_groups).read_text(encoding='utf-8'))['groups']
        permitted = {r['feed'] for r in targets if r['source'] == 'itch'}
        feeds = {name: url for name, url in feeds.items() if name in permitted}
    results = collect(feeds)
    path = STAGING / "itch.json"
    atomic_json(path, {"schema_version": 1, "source": "itch", "mode": args.mode, "generated_at": timestamp(), "groups": results})
    print(f"[itch] groups={len(results)} success={sum(g['status']=='success' for g in results)} failed={sum(g['status']=='failed' for g in results)} -> {path}")
    for g in results:
        print(f"  {g['feed']:10} {g['status']:8} {g['item_count']:3} {g['message']}")
    return 0 if any(g["status"] in ("success", "partial") for g in results) else 2


if __name__ == "__main__":
    raise SystemExit(main())
