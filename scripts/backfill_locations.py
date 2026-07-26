#!/usr/bin/env python3

import json
import time
from pathlib import Path

import requests

RUNS_FILE = Path("data/runs.json")
CACHE_FILE = Path("data/location_cache.json")

USER_AGENT = "running-dashboard/1.0 (personal project)"


def load_cache():
    if CACHE_FILE.exists():
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)


def cache_key(lat, lon):
    # circa 100 metri
    return f"{round(lat,3):.3f},{round(lon,3):.3f}"


def reverse_geocode(lat, lon):

    r = requests.get(
        "https://nominatim.openstreetmap.org/reverse",
        params={
            "format": "jsonv2",
            "lat": lat,
            "lon": lon,
            "zoom": 10,
            "addressdetails": 1,
        },
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=20,
    )

    r.raise_for_status()

    address = r.json().get("address", {})

    return (
        address.get("city")
        or address.get("town")
        or address.get("village")
        or address.get("municipality")
        or address.get("county")
        or address.get("state")
    )


def main():

    with open(RUNS_FILE, "r", encoding="utf-8") as f:
        runs = json.load(f)

    cache = load_cache()

    queried = 0
    updated = 0

    for run in runs:

        if run.get("location"):
            continue

        lat = run.get("lat")
        lon = run.get("lon")

        if lat is None or lon is None:
            continue

        key = cache_key(lat, lon)

        if key not in cache:

            print(f"Looking up {lat:.4f}, {lon:.4f}")

            try:
                cache[key] = reverse_geocode(lat, lon)

            except Exception as e:
                print(e)
                cache[key] = None

            queried += 1

            save_cache(cache)

            # rispetto della policy di Nominatim
            time.sleep(1)

        run["location"] = cache[key]
        updated += 1

    with open(RUNS_FILE, "w", encoding="utf-8") as f:
        json.dump(runs, f, indent=2, ensure_ascii=False)

    print()
    print("--------------------------------")
    print(f"Runs updated : {updated}")
    print(f"Queries made : {queried}")
    print(f"Cache size   : {len(cache)}")


if __name__ == "__main__":
    main()
