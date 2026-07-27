#!/usr/bin/env python3
"""Rebuild historical GPS tracks from local Smashrun .tcx exports.

Why this exists
----------------
data/tracks/<id>.json is normally built by sync_strava.py from Strava's
per-activity streams API, but that only ever runs for the small incremental
window pulled on each scheduled sync. Backfilling the entire history that
way would mean re-fetching streams for ~900 activities (two API calls each),
hitting Strava's rate limits and taking days.

The full history already exists locally as Smashrun .tcx exports (one file
per run, "smashrun-YYYY-MM-DD-<smashrun-id>.tcx"), which contain the actual
GPS trackpoints (and, for more recent years, heart rate and cadence too).
This script parses those files directly and produces the exact same
data/tracks/<id>.json shape the frontend already expects, with no network
access and no dependency on Strava at all.

This is a local maintenance script, not part of the GitHub Actions sync:
the .tcx archive lives outside the git repo, so it is meant to be re-run by
hand whenever new .tcx exports are added.

What it does
------------
- Matches each .tcx file to a run in data/runs.json by date (and, on days
  with more than one run, by closest total distance).
- Runs that already have a Strava "id" and an existing track file are left
  untouched (the Strava-derived version is authoritative) -- except that a
  dangling data/runs.json entry whose track file already exists on disk but
  whose "track_file" pointer is empty gets that pointer fixed.
- Runs that were never uploaded to Strava (no "id" at all) are assigned a
  stable synthetic id "sr<smashrun-id>" so the frontend can address them
  like any other run, and a track file is generated for them.
- Before matching, drops exact-duplicate entries: a same-day, same-distance
  run that has no id when another entry for that day already has one.

Usage
-----
    python scripts/tcx_import.py --tcx-dir /path/to/tcx/folder [--force] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = radians(lat1), radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lambda = radians(lon2 - lon1)
    a = sin(d_phi / 2) ** 2 + cos(p1) * cos(p2) * sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * asin(sqrt(a))

RUNS_FILE = Path("data/runs.json")
TRACKS_DIR = Path("data/tracks")

TCX_NS = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
EXT_NS = "http://www.garmin.com/xmlschemas/ActivityExtension/v2"
FILENAME_RE = re.compile(r"^smashrun-(\d{4}-\d{2}-\d{2})-(\d+)\.tcx$")

DEDUP_KM_TOLERANCE = 0.05


def tag(ns: str, name: str) -> str:
    return f"{{{ns}}}{name}"


def parse_time(text: str) -> datetime:
    # TCX timestamps are almost always "...000Z" but tolerate no-fraction too.
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")


def parse_tcx(path: Path) -> dict[str, Any] | None:
    """Parse one .tcx file into {"start_local", "points", "distance_m"}.

    Cumulative distance is derived purely from consecutive GPS coordinates
    (haversine), not from the file's own <DistanceMeters> field. That field
    turns out to be inconsistent across this archive: in some exports it
    resets to ~0 at every Lap boundary, in others it keeps accumulating
    across the whole activity -- silently mixing the two conventions
    produced distances many times too large for a chunk of the 2015-2016
    files. Deriving distance from GPS instead sidesteps the ambiguity
    entirely and matches how Strava/most tools compute it anyway. Wall-clock
    Time is absolute throughout the file, so elapsed seconds are derived
    directly from it.
    """
    tree = ET.parse(path)
    root = tree.getroot()
    activity = root.find(f".//{tag(TCX_NS, 'Activity')}")
    if activity is None:
        return None

    points: list[dict[str, Any]] = []
    cumulative_distance = 0.0
    prev_lat: float | None = None
    prev_lon: float | None = None
    start_dt: datetime | None = None

    for lap in activity.findall(tag(TCX_NS, "Lap")):
        # A Lap can contain more than one <Track> segment (e.g. pause/resume
        # while recording); walk all of them in order, or the tail of the
        # lap's trackpoints is silently dropped.
        tracks = lap.findall(tag(TCX_NS, "Track"))
        if not tracks:
            continue

        for trackpoint in (tp for track in tracks for tp in track.findall(tag(TCX_NS, "Trackpoint"))):
            time_el = trackpoint.find(tag(TCX_NS, "Time"))
            if time_el is None or not time_el.text:
                continue
            point_dt = parse_time(time_el.text)
            if start_dt is None:
                start_dt = point_dt

            position = trackpoint.find(tag(TCX_NS, "Position"))
            if position is None:
                continue
            lat_el = position.find(tag(TCX_NS, "LatitudeDegrees"))
            lon_el = position.find(tag(TCX_NS, "LongitudeDegrees"))
            if lat_el is None or lon_el is None or not lat_el.text or not lon_el.text:
                continue
            lat, lon = float(lat_el.text), float(lon_el.text)

            if prev_lat is not None:
                cumulative_distance += haversine_m(prev_lat, prev_lon, lat, lon)
            prev_lat, prev_lon = lat, lon

            altitude_el = trackpoint.find(tag(TCX_NS, "AltitudeMeters"))
            altitude = float(altitude_el.text) if altitude_el is not None and altitude_el.text else None

            hr_el = trackpoint.find(f"{tag(TCX_NS, 'HeartRateBpm')}/{tag(TCX_NS, 'Value')}")
            heart_rate = float(hr_el.text) if hr_el is not None and hr_el.text else None

            tpx = trackpoint.find(f"{tag(TCX_NS, 'Extensions')}/{tag(EXT_NS, 'TPX')}")
            speed = cadence_spm = None
            if tpx is not None:
                speed_el = tpx.find(tag(EXT_NS, "Speed"))
                cadence_el = tpx.find(tag(EXT_NS, "RunCadence"))
                if speed_el is not None and speed_el.text:
                    speed = float(speed_el.text)
                if cadence_el is not None and cadence_el.text:
                    # TCX RunCadence is per-leg, same convention Strava uses.
                    cadence_spm = round(float(cadence_el.text) * 2, 1)

            points.append({
                "lat": lat,
                "lon": lon,
                "t": int((point_dt - start_dt).total_seconds()),
                "m": round(cumulative_distance, 1),
                "hr": heart_rate,
                "cad": cadence_spm,
                "alt": altitude,
                "v": speed,
                "grade": None,
            })

    if not points:
        return None

    return {
        "start_local": start_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if start_dt else None,
        "points": points,
        "distance_m": cumulative_distance,
    }


def is_regeneratable(track_path: Path) -> bool:
    """True if an existing track file was itself produced by this script
    (marked "source": "tcx") and can therefore be safely rewritten, e.g.
    after a bug fix. Genuine Strava-derived track files never carry this
    marker and are always left alone."""
    try:
        with track_path.open("r", encoding="utf-8") as file:
            existing = json.load(file)
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(existing, dict) and existing.get("source") == "tcx"


def load_runs() -> list[dict[str, Any]]:
    with RUNS_FILE.open("r", encoding="utf-8") as file:
        return json.load(file)


def save_runs(runs: list[dict[str, Any]]) -> None:
    runs.sort(key=lambda run: (run.get("d", ""), str(run.get("id", ""))))
    with RUNS_FILE.open("w", encoding="utf-8") as file:
        json.dump(runs, file, ensure_ascii=False, separators=(",", ":"))


def drop_duplicate_orphans(runs: list[dict[str, Any]]) -> int:
    """Remove no-id entries that are exact duplicates of an id'd entry on
    the same day (same distance within tolerance). See the 2026-06-19 case
    found during the audit: two entries for the same run, one properly
    synced from Strava, one a stray leftover without an id."""
    by_date: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        by_date.setdefault(run["d"], []).append(run)

    to_remove = []
    for date, group in by_date.items():
        with_id = [r for r in group if r.get("id")]
        without_id = [r for r in group if not r.get("id")]
        if not with_id or not without_id:
            continue
        for orphan in without_id:
            if any(abs(orphan.get("km", 0) - sibling.get("km", 0)) <= DEDUP_KM_TOLERANCE for sibling in with_id):
                to_remove.append(orphan)

    for run in to_remove:
        runs.remove(run)
    return len(to_remove)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tcx-dir", required=True, help="Folder containing the smashrun-*.tcx files")
    parser.add_argument("--force", action="store_true", help="Overwrite track files that already exist")
    parser.add_argument("--dry-run", action="store_true", help="Report what would happen without writing anything")
    args = parser.parse_args()

    tcx_files = sorted(Path(args.tcx_dir).glob("smashrun-*.tcx"))
    runs = load_runs()

    removed_duplicates = drop_duplicate_orphans(runs)

    by_date: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        by_date.setdefault(run["d"], []).append(run)

    TRACKS_DIR.mkdir(parents=True, exist_ok=True)

    written = 0
    pointer_fixed = 0
    ids_assigned = 0
    no_matching_run = 0
    parse_errors = 0
    no_gps_data = 0

    for tcx_path in tcx_files:
        match = FILENAME_RE.match(tcx_path.name)
        if not match:
            continue
        date_str, smashrun_id = match.groups()

        candidates = by_date.get(date_str, [])
        if not candidates:
            no_matching_run += 1
            continue

        # Parsing every .tcx file (thousands of trackpoints each) is the
        # slow part. Days with a single candidate run don't need the parsed
        # distance to pick which run to match, so defer parsing until we
        # actually know we need to write something -- this makes re-running
        # the script over an already-imported archive nearly instant.
        parsed: dict[str, Any] | None = None

        if len(candidates) == 1:
            run = candidates[0]
        else:
            try:
                parsed = parse_tcx(tcx_path)
            except Exception as error:
                print(f"ERROR parsing {tcx_path.name}: {error}")
                parse_errors += 1
                continue
            if not parsed:
                # Multiple runs that day and no GPS to disambiguate by distance.
                no_matching_run += 1
                continue
            tcx_km = parsed["distance_m"] / 1000
            run = min(candidates, key=lambda r: abs(r.get("km", 0) - tcx_km))

        # Assign a stable id even when the .tcx has no GPS trackpoints, so
        # runs that were never uploaded to Strava still get a consistent
        # identity the frontend can key on.
        run_id = run.get("id")
        if not run_id:
            run_id = f"sr{smashrun_id}"
            run["id"] = run_id
            ids_assigned += 1

        track_path = TRACKS_DIR / f"{run_id}.json"

        if track_path.exists() and not args.force and not is_regeneratable(track_path):
            if not run.get("track_file"):
                run["track_file"] = track_path.as_posix()
                pointer_fixed += 1
            continue

        if parsed is None:
            try:
                parsed = parse_tcx(tcx_path)
            except Exception as error:
                print(f"ERROR parsing {tcx_path.name}: {error}")
                parse_errors += 1
                continue
            if not parsed:
                no_gps_data += 1
                continue

        payload = {
            "id": run_id,
            "name": run.get("name"),
            "start_local": run.get("start_local") or parsed["start_local"],
            "description": run.get("description"),
            "gear_name": run.get("gear_name"),
            "calories": run.get("calories"),
            "suffer_score": None,
            "perceived_exertion": None,
            "points": parsed["points"],
            "source": "tcx",
        }

        if not args.dry_run:
            with track_path.open("w", encoding="utf-8") as file:
                json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))

        run["track_file"] = track_path.as_posix()
        run.setdefault("start_local", parsed["start_local"])
        written += 1

    if not args.dry_run:
        save_runs(runs)

    print("--------------------------------")
    print(f"{'[DRY RUN] ' if args.dry_run else ''}tcx files scanned      : {len(tcx_files)}")
    print(f"Duplicate orphan runs removed : {removed_duplicates}")
    print(f"New track files written       : {written}")
    print(f"Existing track pointer fixed  : {pointer_fixed}")
    print(f"Synthetic ids assigned        : {ids_assigned}")
    print(f"No same-day run in runs.json  : {no_matching_run}")
    print(f"tcx had no GPS trackpoints    : {no_gps_data}")
    print(f"Parse errors                  : {parse_errors}")


if __name__ == "__main__":
    main()
