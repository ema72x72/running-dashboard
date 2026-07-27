from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

from location_utils import (
    apply_location_fields,
    load_location_cache,
    resolve_location,
    save_location_cache,
)

CLIENT_ID = os.environ["STRAVA_CLIENT_ID"]
CLIENT_SECRET = os.environ["STRAVA_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["STRAVA_REFRESH_TOKEN"]

TOKEN_URL = "https://www.strava.com/oauth/token"
API_URL = "https://www.strava.com/api/v3"
DATA_FILE = Path("data/runs.json")
METADATA_FILE = Path("data/metadata.json")
TRACKS_DIR = Path("data/tracks")


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


def get_activity_streams(
    activity_id: int,
    access_token: str,
) -> dict[str, Any]:
    stream_keys = ",".join(
        [
            "latlng",
            "time",
            "distance",
            "heartrate",
            "cadence",
            "altitude",
            "velocity_smooth",
            "grade_smooth",
        ]
    )

    try:
        streams = api_get(
            (
                f"/activities/{activity_id}/streams"
                f"?keys={stream_keys}&key_by_type=true"
            ),
            access_token,
        )

        if isinstance(streams, dict):
            return streams

    except requests.HTTPError as error:
        print(
            f"Warning: cannot download streams "
            f"for activity {activity_id}: {error}"
        )

    return {}


def stream_data(
    streams: dict[str, Any],
    stream_name: str,
) -> list[Any]:
    stream = streams.get(stream_name)

    if not isinstance(stream, dict):
        return []

    data = stream.get("data")

    return data if isinstance(data, list) else []


def get_hr_zones_from_streams(
    streams: dict[str, Any],
) -> list[float]:
    time_data = stream_data(streams, "time")
    hr_data = stream_data(streams, "heartrate")

    if not time_data or not hr_data:
        return [0.0, 0.0, 0.0, 0.0, 0.0]

    return calculate_hr_zones(time_data, hr_data)

def get_activity_details(
    activity_id: int,
    access_token: str,
) -> dict[str, Any]:
    try:
        details = api_get(
            f"/activities/{activity_id}",
            access_token,
        )

        if isinstance(details, dict):
            return details

    except requests.HTTPError as error:
        print(
            f"Warning: cannot download details "
            f"for activity {activity_id}: {error}"
        )

    return {}

def value_at(
    values: list[Any],
    index: int,
    default: Any = None,
) -> Any:
    if index < len(values):
        return values[index]

    return default


def build_track_payload(
    activity: dict[str, Any],
    streams: dict[str, Any],
) -> dict[str, Any]:
    activity_id = str(activity["id"])

    latlng_data = stream_data(streams, "latlng")
    time_data = stream_data(streams, "time")
    distance_data = stream_data(streams, "distance")
    heartrate_data = stream_data(streams, "heartrate")
    cadence_data = stream_data(streams, "cadence")
    altitude_data = stream_data(streams, "altitude")
    velocity_data = stream_data(streams, "velocity_smooth")
    grade_data = stream_data(streams, "grade_smooth")

    # Il numero di punti deve dipendere dalle coordinate GPS.
    # In questo modo non si verifica un IndexError quando Strava
    # restituisce tempo o distanza ma non latlng.
    point_count = len(latlng_data)
    points: list[dict[str, Any]] = []

    for index in range(point_count):
        latlng = latlng_data[index]

        if (
            not isinstance(latlng, list)
            or len(latlng) < 2
        ):
            continue

        cadence = value_at(cadence_data, index)

        # Per la corsa Strava restituisce normalmente la cadenza
        # per una sola gamba; la convertiamo in passi al minuto.
        cadence_spm = (
            round(float(cadence) * 2, 1)
            if isinstance(cadence, (int, float))
            else None
        )

        point = {
            "lat": latlng[0],
            "lon": latlng[1],
            "t": value_at(time_data, index),
            "m": value_at(distance_data, index),
            "hr": value_at(heartrate_data, index),
            "cad": cadence_spm,
            "alt": value_at(altitude_data, index),
            "v": value_at(velocity_data, index),
            "grade": value_at(grade_data, index),
        }

        points.append(point)

    gear = activity.get("gear")
    gear_name = (
        gear.get("name")
        if isinstance(gear, dict)
        else None
    )

    return {
        "id": activity_id,
        "name": activity.get("name"),
        "start_local": activity.get("start_date_local"),
        "description": activity.get("description"),
        "gear_name": gear_name,
        "calories": activity.get("calories"),
        "suffer_score": activity.get("suffer_score"),
        "perceived_exertion": activity.get("perceived_exertion"),
        "points": points,
    }


def save_track(
    activity_id: int,
    payload: dict[str, Any],
) -> str:
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)

    track_path = TRACKS_DIR / f"{activity_id}.json"

    with track_path.open("w", encoding="utf-8") as file:
        json.dump(
            payload,
            file,
            ensure_ascii=False,
            separators=(",", ":"),
        )

    return track_path.as_posix()


def convert_activity(
    activity: dict[str, Any],
    access_token: str,
    location_cache: dict[str, Any],
) -> dict[str, Any]:
    date_string = activity["start_date_local"][:10]
    year, day_of_year, weekday = date_fields(date_string)

    activity_id = int(activity["id"])

    details = get_activity_details(
        activity_id,
        access_token,
    )

    # Il dettaglio attività è più completo del record restituito
    # da /athlete/activities.
    source = {**activity, **details}

    streams = get_activity_streams(
        activity_id,
        access_token,
    )

    track_payload = build_track_payload(
        source,
        streams,
    )

    if track_payload.get("points"):
        track_file = save_track(
            activity_id,
            track_payload,
        )
    else:
        track_file = None

    start_latlng = source.get("start_latlng") or [None, None]

    average_cadence = source.get("average_cadence")
    cadence_spm = (
        round(float(average_cadence) * 2, 1)
        if isinstance(average_cadence, (int, float))
        else None
    )

    gear = source.get("gear")
    gear_name = (
        gear.get("name")
        if isinstance(gear, dict)
        else None
    )

    run = {
        "id": str(activity_id),
        "d": date_string,
        "y": year,
        "doy": day_of_year,
        "wd": weekday,

        "km": round(
            float(source.get("distance", 0)) / 1000,
            3,
        ),
        "min": round(
            float(source.get("moving_time", 0)) / 60,
            2,
        ),
        "elapsed_min": round(
            float(source.get("elapsed_time", 0)) / 60,
            2,
        ),

        "hr": source.get("average_heartrate"),
        "mhr": source.get("max_heartrate"),
        "cad": cadence_spm,

        "lat": start_latlng[0],
        "lon": start_latlng[1],

        "start_local": source.get("start_date_local"),
        "name": source.get("name"),

        "elev": round(
            float(source.get("total_elevation_gain", 0)),
            1,
        ),

        "calories": source.get("calories"),
        "description": source.get("description"),
        "gear_name": gear_name,

        "track_file": track_file,

        "hrz": get_hr_zones_from_streams(streams),
    }

    if run["lat"] is not None and run["lon"] is not None:
        try:
            location, _used_network = resolve_location(
                run["lat"], run["lon"], location_cache,
            )
            apply_location_fields(run, location)
        except Exception as error:
            print(
                f"Warning: reverse geocoding failed for activity "
                f"{activity_id}: {error}"
            )

    return run




def main() -> None:
    """Incremental sync: download only activities newer than the last one
    already saved, convert them, and append them.

    This intentionally does not try to re-process or "catch up" runs that
    are already in data/runs.json (no backfill-from-empty fallback, no
    re-downloading tracks for already-synced activities). Historical data
    is built and maintained separately by tcx_import.py; this script's only
    job is to keep adding what's new since the last run.
    """
    runs = load_runs()
    existing_ids = {str(run["id"]) for run in runs if run.get("id") is not None}
    dated_runs = [run["d"] for run in runs if isinstance(run.get("d"), str)]

    last_date = max(dated_runs)
    after_epoch = int(
        datetime.strptime(last_date, "%Y-%m-%d")
        .replace(tzinfo=timezone.utc)
        .timestamp()
    ) - 86_400

    token_data = refresh_access_token()
    access_token = token_data["access_token"]
    activities = download_activities(access_token, after_epoch)
    location_cache = load_location_cache()

    added = 0

    for activity in activities:
        activity_id = str(activity["id"])
        sport_type = activity.get("sport_type", "")

        if "Run" not in sport_type:
            continue
        if activity_id in existing_ids:
            continue

        runs.append(
            convert_activity(
                activity,
                access_token,
                location_cache,
            )
        )

        existing_ids.add(activity_id)
        added += 1

    save_runs(runs)
    save_metadata(runs, added)
    save_location_cache(location_cache)
    print(f"Sync complete: {added} added")
    print(f"Total runs: {len(runs)}")


if __name__ == "__main__":
    main()
