#!/usr/bin/env python3
"""One-off / periodic maintenance script: backfill location_city/state/country
for every run in data/runs.json that has GPS coordinates but no location yet.

This used to duplicate the reverse-geocoding logic with its own (incompatible)
field names and cache format. It now shares a single implementation with the
automated sync (see location_utils.py and sync_strava.py), so the cache and
the fields written here are exactly what the frontend reads.

Run this locally whenever you want to backfill older runs that predate the
automated sync's own location lookups (e.g. right after importing historical
tracks with tcx_import.py). It is safe to re-run: cached coordinates are
never re-queried.
"""
from __future__ import annotations

import json
from pathlib import Path

from location_utils import (
    apply_location_fields,
    load_location_cache,
    resolve_location,
    save_location_cache,
)

RUNS_FILE = Path("data/runs.json")


def main() -> None:
    with RUNS_FILE.open("r", encoding="utf-8") as file:
        runs = json.load(file)

    cache = load_location_cache()
    queried = 0
    updated = 0

    for run in runs:
        if run.get("location_city") or run.get("location_country"):
            continue

        lat, lon = run.get("lat"), run.get("lon")
        if lat is None or lon is None:
            continue

        try:
            location, used_network = resolve_location(lat, lon, cache)
        except Exception as error:
            print(f"Warning: reverse geocoding failed for {run.get('d')}: {error}")
            continue

        if used_network:
            queried += 1
            save_location_cache(cache)  # persist incrementally in case of interruption

        if apply_location_fields(run, location):
            updated += 1

    with RUNS_FILE.open("w", encoding="utf-8") as file:
        json.dump(runs, file, ensure_ascii=False, separators=(",", ":"))

    save_location_cache(cache)

    print()
    print("--------------------------------")
    print(f"Runs updated : {updated}")
    print(f"Queries made : {queried}")
    print(f"Cache size   : {len(cache)}")


if __name__ == "__main__":
    main()
