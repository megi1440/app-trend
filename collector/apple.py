"""Apple official modern RSS for overall apps; legacy RSS for category charts."""
import argparse
import json
import time
from urllib.parse import urlencode

from common import STAGING, atomic_json, config, fetch_bytes, group, timestamp, validate_items


def labeled(obj):
    if isinstance(obj, dict):
        return obj.get("label", "")
    return ""


def parse_modern(data, kind):
    feed = data.get("feed") or {}
    entries = feed.get("results")
    if not isinstance(entries, list):
        raise ValueError("INVALID_MODERN_SCHEMA")
    rows = []
    for rank, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            continue
        uid = str(entry.get("id") or "").strip()
        rows.append({"position": rank, "app_key": f"apple:{uid}" if uid else "", "source_id": uid,
                     "kind": kind, "name": entry.get("name", ""), "developer": entry.get("artistName", ""),
                     "primary_category": (entry.get("genres") or [{}])[0].get("name", "") if entry.get("genres") else "",
                     "icon_url": entry.get("artworkUrl100", ""), "detail_url": entry.get("url", ""),
                     "release_date": entry.get("releaseDate", "")})
    return rows


def parse_legacy(data, kind):
    feed = data.get("feed") or {}
    entries = feed.get("entry")
    if isinstance(entries, dict):
        entries = [entries]
    if not isinstance(entries, list):
        raise ValueError("INVALID_LEGACY_SCHEMA")
    rows = []
    for rank, entry in enumerate(entries, start=1):
        if not isinstance(entry, dict):
            continue
        uid = str(((entry.get("id") or {}).get("attributes") or {}).get("im:id", "")).strip()
        icons = entry.get("im:image") or []
        if isinstance(icons, dict):
            icons = [icons]
        link = entry.get("link") or {}
        if isinstance(link, list):
            link = link[0] if link else {}
        detail_url = (link.get("attributes") or {}).get("href", "")
        if not detail_url:
            detail_url = labeled(entry.get("id"))
        rows.append({"position": rank, "app_key": f"apple:{uid}" if uid else "", "source_id": uid,
                     "kind": kind, "name": labeled(entry.get("im:name")), "developer": labeled(entry.get("im:artist")),
                     "primary_category": ((entry.get("category") or {}).get("attributes") or {}).get("label", ""),
                     "icon_url": labeled(icons[-1]) if icons else "", "detail_url": detail_url,
                     "release_date": labeled(entry.get("im:releaseDate"))[:10]})
    return rows



def lookup_detail(country, source_id):
    """Small real-world Lookup probe; only first chart row in smoke mode."""
    query = urlencode({"id": source_id, "country": country.lower(), "entity": "software"})
    raw = json.loads(fetch_bytes(f"https://itunes.apple.com/lookup?{query}", timeout=30, retries=0).decode("utf-8-sig"))
    results = raw.get("results", [])
    app = next((x for x in results if str(x.get("trackId", "")) == str(source_id)), None)
    if not app:
        raise ValueError("LOOKUP_ID_NOT_FOUND")
    return {"name": app.get("trackName", ""), "description": app.get("description", ""),
            "rating": app.get("averageUserRating"), "rating_count": app.get("userRatingCount"),
            "primary_category": app.get("primaryGenreName", ""),
            "release_date": app.get("releaseDate", "")[:10]}


def collect(countries, mode, max_groups=None, sleep_sec=0.7):
    results = []
    cfg = config()
    for country in countries:
        charts = cfg["charts"] if mode == "full" else [c for c in cfg["charts"] if (c["category"], c["chart"]) in
                                               {("all_apps", "top_free"), ("all_apps", "top_paid"), ("game_puzzle", "top_free")}]
        for chart in charts:
            if max_groups is not None and len(results) >= max_groups:
                return results
            category, chart_type, limit = chart["category"], chart["chart"], chart["limit"]
            if mode == "smoke":
                limit = 5
            kind = chart["kind"]
            genre = chart["apple_genre"]
            kwargs = dict(source="apple", country=country, chart=chart_type, category=category)
            if category != "all_apps" and genre is None:
                results.append(group(**kwargs, status="skipped", message="APPLE_GENRE_NOT_MAPPED"))
                continue
            if category == "all_apps":
                slug = "top-free" if chart_type == "top_free" else "top-paid"
                url = f"https://rss.marketingtools.apple.com/api/v2/{country.lower()}/apps/{slug}/{limit}/apps.json"
                parser = parse_modern
            else:
                slug = "topfreeapplications" if chart_type == "top_free" else "toppaidapplications"
                url = f"https://itunes.apple.com/{country.lower()}/rss/{slug}/limit={limit}/genre={genre}/json"
                parser = parse_legacy
            try:
                # One attempt per chart per day. A 30s timeout allows slow responses
                # without a repeated request storm; a miss is retried next day.
                data = json.loads(fetch_bytes(url, timeout=30, retries=0).decode("utf-8-sig"))
                parsed = parser(data, kind)
                items = validate_items(parsed, limit)
                if not items:
                    raise ValueError("EMPTY_OR_INVALID_CHART")
                bad = len(parsed) - len(items)
                status = "partial" if bad else "success"
                entry = group(**kwargs, status=status, items=items,
                              message=f"INVALID_ITEMS:{bad}" if bad else "")
                if mode == "smoke" and category == "all_apps" and chart_type == "top_free":
                    try:
                        entry["detail_probe"] = {"status": "success", "result": lookup_detail(country, items[0]["source_id"])}
                    except Exception as detail_error:
                        entry["detail_probe"] = {"status": "failed", "message": f"{type(detail_error).__name__}: {detail_error}"[:220]}
                results.append(entry)
            except Exception as exc:
                results.append(group(**kwargs, status="failed", message=f"{type(exc).__name__}: {exc}"))
            time.sleep(sleep_sec)
    return results


def main():
    p = argparse.ArgumentParser(description="Apple RSS collection (staging only)")
    p.add_argument("--mode", choices=["smoke", "full"], default="smoke")
    p.add_argument("--country", choices=["US", "JP", "KR", "all"], default="all")
    p.add_argument("--max-groups", type=int, default=None)
    args = p.parse_args()
    countries = list(config()["countries"]) if args.country == "all" else [args.country]
    groups = collect(countries, args.mode, args.max_groups)
    out = {"schema_version": 1, "source": "apple", "mode": args.mode, "generated_at": timestamp(), "groups": groups}
    path = STAGING / "apple.json"
    atomic_json(path, out)
    print(f"[apple] groups={len(groups)} success={sum(g['status'] == 'success' for g in groups)} partial={sum(g['status']=='partial' for g in groups)} failed={sum(g['status']=='failed' for g in groups)} skipped={sum(g['status']=='skipped' for g in groups)} -> {path}")
    for g in groups:
        print(f"  {g['country']:2} {g['chart']:8} {g['category']:20} {g['status']:8} {g['item_count']:3} {g['message']}")
    return 0 if any(g["status"] in ("success", "partial") for g in groups) else 2


if __name__ == "__main__":
    raise SystemExit(main())
