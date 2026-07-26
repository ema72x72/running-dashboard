from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from functools import lru_cache

import requests

CLIENT_ID = os.environ["STRAVA_CLIENT_ID"]
CLIENT_SECRET = os.environ["STRAVA_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["STRAVA_REFRESH_TOKEN"]

TOKEN_URL = "https://www.strava.com/oauth/token"
API_URL = "https://www.strava.com/api/v3"
DATA_FILE = Path("data/runs.json")
METADATA_FILE = Path("data/metadata.json")


def refresh_access_token() -> dict[str, Any]:
    response = requests.post(
        TOKEN_URL,
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "refresh_token": REFRESH_TOKEN,
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    response.raise_for_status()
    token_data = response.json()

    returned_refresh = token_data.get("refresh_token")
    if returned_refresh and returned_refresh != REFRESH_TOKEN:
        print("NOTICE: Strava returned a new refresh token. Update the GitHub secret STRAVA_REFRESH_TOKEN before the next run.")

    return token_data


def api_get(path: str, access_token: str) -> Any:
    response = requests.get(
        f"{API_URL}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def load_runs() -> list[dict[str, Any]]:
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, list):
        raise ValueError("data/runs.json must contain a JSON array")
    return data


def save_runs(runs: list[dict[str, Any]]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    runs.sort(key=lambda run: (run.get("d", ""), str(run.get("id", ""))))
    with DATA_FILE.open("w", encoding="utf-8") as file:
        json.dump(runs, file, ensure_ascii=False, separators=(",", ":"))




def save_metadata(runs: list[dict[str, Any]], added: int) -> None:
    dated_runs = [run.get("d") for run in runs if isinstance(run.get("d"), str)]
    metadata = {
        "last_sync": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "run_count": len(runs),
        "last_activity_date": max(dated_runs) if dated_runs else None,
        "new_runs": added,
    }
    METADATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with METADATA_FILE.open("w", encoding="utf-8") as file:
        json.dump(metadata, file, ensure_ascii=False, indent=2)
        file.write("\n")


def hr_zone_index(hr: float) -> int:
    if hr < 130:
        return 0
    if hr < 145:
        return 1
    if hr < 160:
        return 2
    if hr < 175:
        return 3
    return 4


def calculate_hr_zones(time_stream: list[int], hr_stream: list[float]) -> list[float]:
    zones = [0.0, 0.0, 0.0, 0.0, 0.0]
    limit = min(len(time_stream), len(hr_stream))
    for index in range(limit - 1):
        elapsed = time_stream[index + 1] - time_stream[index]
        heart_rate = hr_stream[index]
        if 0 < elapsed < 120 and isinstance(heart_rate, (int, float)):
            zones[hr_zone_index(float(heart_rate))] += elapsed
    return zones


def date_fields(date_string: str) -> tuple[int, int, int]:
    date = datetime.strptime(date_string, "%Y-%m-%d")
    return date.year, date.timetuple().tm_yday, date.weekday()


def download_activities(access_token: str, after_epoch: int) -> list[dict[str, Any]]:
    activities: list[dict[str, Any]] = []
    page = 1
    while True:
        batch = api_get(
            f"/athlete/activities?after={after_epoch}&page={page}&per_page=100",
            access_token,
        )
        if not batch:
            break
        activities.extend(batch)
        if len(batch) < 100:
            break
        page += 1
        time.sleep(0.2)
    return activities


def get_hr_zones(activity_id: int, access_token: str) -> list[float]:
    try:
        streams = api_get(
            f"/activities/{activity_id}/streams?keys=time,heartrate&key_by_type=true",
            access_token,
        )
        time_data = streams.get("time", {}).get("data", [])
        hr_data = streams.get("heartrate", {}).get("data", [])
        return calculate_hr_zones(time_data, hr_data)
    except requests.HTTPError as error:
        print(f"Warning: no HR streams for activity {activity_id}: {error}")
        return [0.0, 0.0, 0.0, 0.0, 0.0]

from functools import lru_cache

@lru_cache(maxsize=512)
def reverse_geocode(lat, lon):
    if lat is None or lon is None:
        return None

    try:
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
                "User-Agent": "running-dashboard"
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
        )

    except Exception as e:
        print(f"Reverse geocoding failed: {e}")
        return None

def convert_activity(activity: dict[str, Any], access_token: str) -> dict[str, Any]:
    date_string = activity["start_date_local"][:10]
    year, day_of_year, weekday = date_fields(date_string)
    start_latlng = activity.get("start_latlng") or [None, None]
    location = reverse_geocode(start_latlng[0], start_latlng[1])
    activity_id = int(activity["id"])
    average_cadence = activity.get("average_cadence")
    cadence_spm = (
        round(float(average_cadence) * 2, 1)
        if isinstance(average_cadence, (int, float))
        else None
    )

    return {
        "id": str(activity_id),
        "d": date_string,
        "y": year,
        "doy": day_of_year,
        "wd": weekday,
        "km": round(float(activity.get("distance", 0)) / 1000, 3),
        "min": round(float(activity.get("moving_time", 0)) / 60, 2),
        "hr": activity.get("average_heartrate"),
        "mhr": activity.get("max_heartrate"),
        "cad": cadence_spm,
        "lat": start_latlng[0],
        "lon": start_latlng[1],
        "location": location,
        "hrz": get_hr_zones(activity_id, access_token),
    }


def main() -> None:
    runs = load_runs()
    existing_ids = {str(run["id"]) for run in runs if run.get("id") is not None}
    dated_runs = [run["d"] for run in runs if isinstance(run.get("d"), str)]

    if dated_runs:
        last_date = max(dated_runs)
        after_epoch = int(
            datetime.strptime(last_date, "%Y-%m-%d")
            .replace(tzinfo=timezone.utc)
            .timestamp()
        ) - 86_400
    else:
        after_epoch = 0

    token_data = refresh_access_token()
    access_token = token_data["access_token"]
    activities = download_activities(access_token, after_epoch)

    added = 0
    for activity in activities:
        activity_id = str(activity["id"])
        sport_type = activity.get("sport_type", "")
        if "Run" not in sport_type or activity_id in existing_ids:
            continue
        runs.append(convert_activity(activity, access_token))
        existing_ids.add(activity_id)
        added += 1

    save_runs(runs)
    save_metadata(runs, added)
    print(f"Sync complete: {added} new runs")
    print(f"Total runs: {len(runs)}")


if __name__ == "__main__":
    main()
