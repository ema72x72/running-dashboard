from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import requests

from location_utils import (
    apply_location_fields,
    load_location_cache,
    resolve_location,
    save_location_cache,
    valid_lat_lon,
)

DATA_FILE = Path("data/runs.json")


def load_runs() -> list[dict[str, Any]]:
    with DATA_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, list):
        raise ValueError("data/runs.json must contain a JSON array")
    return data


def save_runs(runs: list[dict[str, Any]]) -> None:
    temporary = DATA_FILE.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as file:
        json.dump(runs, file, ensure_ascii=False, separators=(",", ":"))
    temporary.replace(DATA_FILE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Add readable locations to historical runs.")
    parser.add_argument(
        "--max-new-lookups",
        type=int,
        default=100,
        help="Maximum uncached Nominatim requests in this execution; 0 means unlimited (default: 100).",
    )
    parser.add_argument(
        "--language",
        default="en,it",
        help="Preferred response languages, in Accept-Language format (default: en,it).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    runs = load_runs()
    cache = load_location_cache()
    session = requests.Session()

    changed_runs = 0
    network_lookups = 0
    already_complete = 0
    no_coordinates = 0
    deferred = 0

    for index, run in enumerate(runs, start=1):
        if run.get("place"):
            already_complete += 1
            continue

        lat, lon = run.get("lat"), run.get("lon")
        if not valid_lat_lon(lat, lon):
            no_coordinates += 1
            continue

        if args.max_new_lookups > 0 and network_lookups >= args.max_new_lookups:
            # Cached coordinates can still be completed without another request.
            from location_utils import coordinate_key

            if coordinate_key(float(lat), float(lon)) not in cache:
                deferred += 1
                continue

        try:
            location, used_network = resolve_location(
                lat,
                lon,
                cache,
                language=args.language,
                session=session,
            )
        except requests.RequestException as error:
            print(f"Warning: location lookup failed for run {run.get('id', index)}: {error}")
            continue

        if used_network:
            network_lookups += 1
            save_location_cache(cache)

        if apply_location_fields(run, location):
            changed_runs += 1

        if index % 100 == 0:
            print(f"Processed {index}/{len(runs)} runs...")

    if changed_runs:
        save_runs(runs)
    save_location_cache(cache)

    remaining = sum(1 for run in runs if not run.get("place") and valid_lat_lon(run.get("lat"), run.get("lon")))
    print(f"Runs updated: {changed_runs}")
    print(f"New reverse-geocoding requests: {network_lookups}")
    print(f"Already had a place: {already_complete}")
    print(f"Runs without coordinates: {no_coordinates}")
    print(f"Deferred by lookup limit: {deferred}")
    print(f"Runs with coordinates still missing a place: {remaining}")


if __name__ == "__main__":
    main()
