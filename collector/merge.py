"""Merge full-mode collector snapshots into durable CSVs.

Per (source, country, chart, category) or (itch, feed) group, a failure
never removes a previously successful observation. Smoke data is rejected.
"""
import csv
import datetime as dt
import os
from pathlib import Path
import tempfile

from common import config

APP_FIELDS = ["app_key", "source", "source_id", "kind", "developer", "primary_category",
              "icon_url", "detail_url", "release_date", "first_seen", "last_seen", "info_updated_at"]
LOCALE_FIELDS = ["app_key", "country", "lang", "name", "description", "rating", "rating_count",
                 "installs_range", "ad_supported", "in_app_purchases", "updated_at"]
RANK_FIELDS = ["date", "collected_at", "source", "country", "chart", "category", "rank", "app_key"]
DISC_FIELDS = ["date", "collected_at", "source", "feed", "position", "app_key"]


def read_csv(path, columns):
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != columns:
            raise ValueError(f"CSV_HEADER_MISMATCH: {path}: {reader.fieldnames}")
        return list(reader)


def write_csv(path, columns, records):
    """Atomic and stable; no rewrite if identical."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="", dir=path.parent,
                                     prefix=".csv-", delete=False) as fp:
        temp = Path(fp.name)
        try:
            writer = csv.DictWriter(fp, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            for row in records:
                writer.writerow({k: csv_value(row.get(k)) for k in columns})
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    if path.exists() and path.read_bytes() == temp.read_bytes():
        temp.unlink()
    else:
        os.replace(temp, path)


def csv_value(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def group_key(group):
    if group["source"] == "itch":
        return ("itch", "GLOBAL", "", group["feed"])
    return (group["source"], group["country"], group["chart"], group["category"])


def group_of_row(row, *, discovery=False):
    if discovery:
        return ("itch", "GLOBAL", "", row["feed"])
    return (row["source"], row["country"], row["chart"], row["category"])


def expected_groups(sources):
    cfg = config()
    groups = []
    for src in sources:
        if src == "itch":
            groups.extend({"source": "itch", "country": "GLOBAL", "chart": None,
                           "category": None, "feed": f} for f in cfg["itch_feeds"])
        else:
            groups.extend({"source": src, "country": country, "chart": ch["chart"],
                           "category": ch["category"], "feed": None}
                          for country in cfg["countries"] for ch in cfg["charts"])
    return groups


def validate_group(g):
    """Validate the whole group before replacing a successful chart snapshot."""
    if g["status"] not in ("success", "partial"):
        return False, "NO_SUCCESSFUL_DATA"
    items = g.get("items", [])
    if not items or not isinstance(items, list):
        return False, "EMPTY_GROUP"
    identifiers, positions = set(), set()
    for item in items:
        key, rank = item.get("app_key", ""), item.get("position")
        if (not isinstance(key, str) or not key.startswith(g["source"] + ":")
                or not item.get("source_id") or not str(item.get("detail_url", "")).startswith("https://")
                or type(rank) is not int or rank < 1 or key in identifiers or rank in positions):
            return False, "INVALID_OR_DUPLICATE_RECORD"
        identifiers.add(key)
        positions.add(rank)
    maximum = 100 if g["source"] == "itch" else next(
        (x["limit"] for x in config()["charts"] if x["chart"] == g["chart"]
         and x["category"] == g["category"]), 0)
    if maximum and len(items) > maximum:
        return False, "CHART_OVER_LIMIT"
    return True, ""


def nonempty_update(existing, item, columns):
    for field in columns:
        value = item.get(field)
        if value is not None and value != "":
            existing[field] = csv_value(value)


def merge(root, run_date, snapshots, sources):
    """Return per-group run statuses. Existing daily charts are never emptied on failure."""
    day = dt.date.fromisoformat(run_date)
    rank_path = root / "data/rankings" / day.strftime("%Y/%m") / (run_date + ".csv")
    disc_path = root / "data/discoveries" / day.strftime("%Y/%m") / (run_date + ".csv")
    apps_path, locales_path = root / "data/apps.csv", root / "data/app_locales.csv"
    ranking_rows = read_csv(rank_path, RANK_FIELDS)
    discovery_rows = read_csv(disc_path, DISC_FIELDS)
    apps = {r["app_key"]: r for r in read_csv(apps_path, APP_FIELDS)}
    locales = {(r["app_key"], r["country"]): r for r in read_csv(locales_path, LOCALE_FIELDS)}

    # Most recent saved group counts provide a basic defense against malformed
    # full-mode pages suddenly returning only one record where there were dozens.
    previous_counts = {}
    ranking_base = root / "data/rankings"
    discovery_base = root / "data/discoveries"
    for base, columns, disc in ((ranking_base, RANK_FIELDS, False), (discovery_base, DISC_FIELDS, True)):
        for path in sorted(base.glob("*/*/*.csv")):
            if path.stem > run_date:
                continue
            counts = {}
            for row in read_csv(path, columns):
                key = group_of_row(row, discovery=disc)
                counts[key] = counts.get(key, 0) + 1
            previous_counts.update(counts)

    incoming = {}
    for src, document in snapshots.items():
        if document is None:
            continue
        if document.get("mode") != "full":
            raise ValueError(f"REFUSE_SMOKE_DATA: {src}")
        # The collector must have run *this KST date*, preventing stale staging imports.
        ts = dt.datetime.fromisoformat(document["generated_at"].replace("Z", "+00:00"))
        kst_day = ts.astimezone(dt.timezone(dt.timedelta(hours=9))).date()
        if kst_day != day:
            raise ValueError(f"STALE_STAGING_DATE: {src}: {kst_day} != {day}")
        for group in document["groups"]:
            if group.get("source") != src:
                raise ValueError(f"SOURCE_MISMATCH: {src}")
            key = group_key(group)
            if key in incoming:
                raise ValueError(f"DUPLICATE_GROUP: {key}")
            incoming[key] = group

    statuses = []
    seen = set()
    for target in expected_groups(sources):
        key = group_key(target)
        if key in seen:
            raise ValueError(f"DUPLICATE_CONFIG_GROUP: {key}")
        seen.add(key)
        g = incoming.get(key)
        outcome = dict(target)
        if g is None:
            outcome.update(status="failed", item_count=0, attempted_at="", message="COLLECTOR_OUTPUT_MISSING", accepted=False)
            statuses.append(outcome)
            continue
        outcome.update(status=g["status"], item_count=len(g.get("items", [])),
                       attempted_at=g.get("attempted_at", ""), message=g.get("message", ""), accepted=False)
        valid, why = validate_group(g)
        if not valid:
            if outcome["status"] in ("success", "partial"):
                outcome["status"] = "failed"
                outcome["message"] = why
            statuses.append(outcome)
            continue

        # Don't overwrite a large valid snapshot with a suspiciously tiny result.
        previous = previous_counts.get(key, 0)
        if previous >= 10 and len(g["items"]) < max(3, int(previous * 0.35)):
            outcome["status"] = "partial"
            outcome["message"] = f"SUSPICIOUS_DROP: {previous} -> {len(g['items'])}; old data kept"
            statuses.append(outcome)
            continue

        if g["source"] == "itch":
            discovery_rows = [row for row in discovery_rows if group_of_row(row, discovery=True) != key]
        else:
            ranking_rows = [row for row in ranking_rows if group_of_row(row) != key]
        attempted_at = g.get("attempted_at") or snapshots[g["source"]]["generated_at"]
        for item in g["items"]:
            app_key = item["app_key"]
            if g["source"] == "itch":
                discovery_rows.append(dict(date=run_date, collected_at=attempted_at, source="itch",
                                           feed=g["feed"], position=item["position"], app_key=app_key))
            else:
                ranking_rows.append(dict(date=run_date, collected_at=attempted_at, source=g["source"],
                                         country=g["country"], chart=g["chart"], category=g["category"],
                                         rank=item["position"], app_key=app_key))
            app = apps.setdefault(app_key, {k: "" for k in APP_FIELDS})
            if not app["first_seen"] or run_date < app["first_seen"]:
                app["first_seen"] = run_date
            if not app["last_seen"] or run_date > app["last_seen"]:
                app["last_seen"] = run_date
            nonempty_update(app, item, ["app_key", "source_id", "developer", "primary_category",
                                        "icon_url", "detail_url", "release_date"])
            app["source"] = g["source"]
            if item.get("kind") == "game" or not app["kind"]:
                app["kind"] = item.get("kind", "app")
            if not app["info_updated_at"]:
                app["info_updated_at"] = attempted_at
            loc_key = (app_key, g["country"])
            locale = locales.setdefault(loc_key, {k: "" for k in LOCALE_FIELDS})
            locale["app_key"], locale["country"] = loc_key
            locale["lang"] = config()["countries"].get(g["country"], "")
            old_data = {k: locale[k] for k in LOCALE_FIELDS if k != "updated_at"}
            nonempty_update(locale, item, ["name", "description", "rating", "rating_count",
                                           "installs_range", "ad_supported", "in_app_purchases"])
            # Smoke-only detail_probe isn't a normal full-mode detail fetch.
            if not locale["updated_at"] or old_data != {k: locale[k] for k in LOCALE_FIELDS if k != "updated_at"}:
                locale["updated_at"] = attempted_at
        outcome["accepted"] = True
        statuses.append(outcome)

    # Distinct CSV headers and deterministic order on every run.
    if ranking_rows:
        ranking_rows.sort(key=lambda r: (r["source"], r["country"], r["chart"], r["category"], int(r["rank"])))
        write_csv(rank_path, RANK_FIELDS, ranking_rows)
    if discovery_rows:
        discovery_rows.sort(key=lambda r: (r["feed"], int(r["position"])))
        write_csv(disc_path, DISC_FIELDS, discovery_rows)
    if apps:
        write_csv(apps_path, APP_FIELDS, [apps[k] for k in sorted(apps)])
    if locales:
        write_csv(locales_path, LOCALE_FIELDS, [locales[k] for k in sorted(locales)])
    return statuses
