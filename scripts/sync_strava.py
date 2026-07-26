from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

CLIENT_ID = os.environ["STRAVA_CLIENT_ID"]
CLIENT_SECRET = os.environ["STRAVA_CLIENT_SECRET"]
REFRESH_TOKEN = os.environ["STRAVA_REFRESH_TOKEN"]

TOKEN_URL = "https://www.strava.com/oauth/token"
API_URL = "https://www.strava.com/api/v3"
DATA_FILE = Path("data/runs.json")
METADATA_FILE = Path("data/metadata.json")
TRACKS_DIR = Path("data/tracks")

# Each detailed historical activity requires two API calls: activity details + streams.
# Together with activity-list calls, 40 stays below Strava's short-window read limit.
BACKFILL_LIMIT = 40


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
        print(
            "NOTICE: Strava returned a new refresh token. "
            "Update the GitHub secret STRAVA_REFRESH_TOKEN before the next run."
        )
    return token_data


def api_get(path: str, access_token: str) -> Any:
    response = requests.get(
        f"{API_URL}{path}",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=45,
    )
    if not response.ok:
        print(f"Strava API error {response.status_code} for {path}: {response.text[:500]}")
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


def save_metadata(runs: list[dict[str, Any]], added: int, tracks_added: int) -> None:
    dated_runs = [run.get("d") for run in runs if isinstance(run.get("d"), str)]
    detailed_count = sum(1 for run in runs if run.get("track_file"))
    metadata = {
        "last_sync": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "run_count": len(runs),
        "last_activity_date": max(dated_runs) if dated_runs else None,
        "new_runs": added,
        "detailed_runs": detailed_count,
        "tracks_added": tracks_added,
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


def download_all_activities(access_token: str) -> list[dict[str, Any]]:
    activities: list[dict[str, Any]] = []
    page = 1
    while True:
        batch = api_get(
            f"/athlete/activities?page={page}&per_page=100",
            access_token,
        )
        if not batch:
            break
        activities.extend(batch)
        if len(batch) < 100:
            break
        page += 1
        time.sleep(0.15)
    return activities


def is_run(activity: dict[str, Any]) -> bool:
    sport_type = str(activity.get("sport_type") or activity.get("type") or "")
    return "Run" in sport_type


def activity_summary(activity: dict[str, Any]) -> dict[str, Any]:
    date_string = activity["start_date_local"][:10]
    year, day_of_year, weekday = date_fields(date_string)
    start_latlng = activity.get("start_latlng") or [None, None]
    average_cadence = activity.get("average_cadence")
    cadence_spm = (
        round(float(average_cadence) * 2, 1)
        if isinstance(average_cadence, (int, float))
        else None
    )
    return {
        "id": str(activity["id"]),
        "d": date_string,
        "start_local": activity.get("start_date_local"),
        "name": activity.get("name") or "Run",
        "y": year,
        "doy": day_of_year,
        "wd": weekday,
        "km": round(float(activity.get("distance", 0)) / 1000, 3),
        "min": round(float(activity.get("moving_time", 0)) / 60, 2),
        "elapsed_min": round(float(activity.get("elapsed_time", 0)) / 60, 2),
        "hr": activity.get("average_heartrate"),
        "mhr": activity.get("max_heartrate"),
        "cad": cadence_spm,
        "elev": activity.get("total_elevation_gain"),
        "lat": start_latlng[0],
        "lon": start_latlng[1],
        "location_city": activity.get("location_city"),
        "location_state": activity.get("location_state"),
        "location_country": activity.get("location_country"),
        "hrz": [0.0, 0.0, 0.0, 0.0, 0.0],
    }


def update_run_from_activity(run: dict[str, Any], activity: dict[str, Any]) -> None:
    summary = activity_summary(activity)
    # Preserve historically imported values when Strava omits a field.
    for key, value in summary.items():
        if value is not None or key not in run:
            run[key] = value


def match_existing_runs(
    runs: list[dict[str, Any]], activities: list[dict[str, Any]]
) -> tuple[int, int]:
    """Attach Strava IDs to imported rows by date, distance and duration."""
    used_ids = {str(run["id"]) for run in runs if run.get("id") is not None}
    unmatched_runs = [run for run in runs if not run.get("id")]
    matches = 0
    added = 0

    for activity in activities:
        if not is_run(activity):
            continue
        activity_id = str(activity["id"])
        if activity_id in used_ids:
            continue

        summary = activity_summary(activity)
        candidates: list[tuple[float, dict[str, Any]]] = []
        for run in unmatched_runs:
            if run.get("d") != summary["d"]:
                continue
            distance_difference = abs(float(run.get("km", 0)) - float(summary["km"]))
            duration_difference = abs(float(run.get("min", 0)) - float(summary["min"]))
            if distance_difference <= 0.25 and duration_difference <= 8:
                score = distance_difference * 20 + duration_difference
                candidates.append((score, run))

        if candidates:
            _, run = min(candidates, key=lambda item: item[0])
            update_run_from_activity(run, activity)
            used_ids.add(activity_id)
            unmatched_runs.remove(run)
            matches += 1
        else:
            runs.append(summary)
            used_ids.add(activity_id)
            added += 1

    return matches, added


def safe_stream_data(streams: dict[str, Any], key: str) -> list[Any]:
    value = streams.get(key, {})
    data = value.get("data", []) if isinstance(value, dict) else []
    return data if isinstance(data, list) else []


def build_track_payload(
    activity_id: str,
    detailed: dict[str, Any],
    streams: dict[str, Any],
) -> dict[str, Any]:
    time_data = safe_stream_data(streams, "time")
    distance_data = safe_stream_data(streams, "distance")
    latlng_data = safe_stream_data(streams, "latlng")
    heartrate_data = safe_stream_data(streams, "heartrate")
    cadence_data = safe_stream_data(streams, "cadence")
    altitude_data = safe_stream_data(streams, "altitude")
    velocity_data = safe_stream_data(streams, "velocity_smooth")
    grade_data = safe_stream_data(streams, "grade_smooth")

    lengths = [len(x) for x in [time_data, distance_data, latlng_data] if x]
    point_count = min(lengths) if lengths else 0
    points: list[dict[str, Any]] = []

    for index in range(point_count):
        latlng = latlng_data[index]
        if not isinstance(latlng, list) or len(latlng) != 2:
            continue
        point: dict[str, Any] = {
            "lat": round(float(latlng[0]), 6),
            "lon": round(float(latlng[1]), 6),
            "t": int(time_data[index]) if index < len(time_data) else None,
            "m": round(float(distance_data[index]), 1) if index < len(distance_data) else None,
        }
        if index < len(heartrate_data):
            point["hr"] = heartrate_data[index]
        if index < len(cadence_data):
            # Strava running cadence is recorded per foot.
            point["cad"] = round(float(cadence_data[index]) * 2, 1)
        if index < len(altitude_data):
            point["alt"] = altitude_data[index]
        if index < len(velocity_data):
            point["v"] = velocity_data[index]
        if index < len(grade_data):
            point["grade"] = grade_data[index]
        points.append(point)

    payload = {
        "id": activity_id,
        "name": detailed.get("name") or "Run",
        "start_local": detailed.get("start_date_local"),
        "description": detailed.get("description"),
        "gear_name": (detailed.get("gear") or {}).get("name") if isinstance(detailed.get("gear"), dict) else None,
        "calories": detailed.get("calories"),
        "suffer_score": detailed.get("suffer_score"),
        "perceived_exertion": detailed.get("perceived_exertion"),
        "points": points,
    }
    return payload


def enrich_and_save_track(
    run: dict[str, Any], access_token: str
) -> bool:
    activity_id = str(run.get("id") or "")
    if not activity_id:
        return False

    track_path = TRACKS_DIR / f"{activity_id}.json"
    if track_path.exists():
        run["track_file"] = f"data/tracks/{activity_id}.json"
        return False

    try:
        detailed = api_get(f"/activities/{activity_id}", access_token)
        streams = api_get(
            f"/activities/{activity_id}/streams"
            "?keys=time,distance,latlng,heartrate,cadence,altitude,velocity_smooth,grade_smooth"
            "&key_by_type=true",
            access_token,
        )
    except requests.HTTPError as error:
        print(f"Warning: unable to download details for {activity_id}: {error}")
        return False

    update_run_from_activity(run, detailed)
    run["calories"] = detailed.get("calories")
    run["description"] = detailed.get("description")
    run["gear_name"] = (detailed.get("gear") or {}).get("name") if isinstance(detailed.get("gear"), dict) else None

    time_data = safe_stream_data(streams, "time")
    hr_data = safe_stream_data(streams, "heartrate")
    if time_data and hr_data:
        run["hrz"] = calculate_hr_zones(time_data, hr_data)

    payload = build_track_payload(activity_id, detailed, streams)
    TRACKS_DIR.mkdir(parents=True, exist_ok=True)
    with track_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
    run["track_file"] = f"data/tracks/{activity_id}.json"
    return True


def main() -> None:
    runs = load_runs()
    token_data = refresh_access_token()
    access_token = token_data["access_token"]

    activities = download_all_activities(access_token)
    activities = [activity for activity in activities if is_run(activity)]
    matched, added = match_existing_runs(runs, activities)

    # Refresh summary fields for activities already linked to Strava.
    activity_by_id = {str(activity["id"]): activity for activity in activities}
    for run in runs:
        activity = activity_by_id.get(str(run.get("id")))
        if activity:
            update_run_from_activity(run, activity)

    # Prioritise the newest activities, then gradually backfill historical tracks.
    candidates = [
        run for run in sorted(runs, key=lambda item: item.get("d", ""), reverse=True)
        if run.get("id") and not run.get("track_file")
    ]
    tracks_added = 0
    for run in candidates[:BACKFILL_LIMIT]:
        if enrich_and_save_track(run, access_token):
            tracks_added += 1
        time.sleep(0.2)

    # Ensure existing track files remain linked even after a previous partial run.
    for run in runs:
        activity_id = str(run.get("id") or "")
        if activity_id and (TRACKS_DIR / f"{activity_id}.json").exists():
            run["track_file"] = f"data/tracks/{activity_id}.json"

    save_runs(runs)
    save_metadata(runs, added, tracks_added)
    print(f"Sync complete: {added} new runs, {matched} historical matches")
    print(f"Detailed tracks added this run: {tracks_added}")
    print(f"Total runs: {len(runs)}")


if __name__ == "__main__":
    main()
