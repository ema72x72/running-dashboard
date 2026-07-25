from __future__ import annotations

import json
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
    return response.json()


def api_get(path: str, access_token: str) -> Any:
    response = requests.get(
        f"{API_URL}{path}",
        headers={
            "Authorization": f"Bearer {access_token}"
        },
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
        raise ValueError(
            "data/runs.json deve contenere un array JSON"
        )

    return data


def save_runs(runs: list[dict[str, Any]]) -> None:
    DATA_FILE.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    runs.sort(
        key=lambda run: (
            run["d"],
            str(run.get("id", ""))
        )
    )

    with DATA_FILE.open(
        "w",
        encoding="utf-8"
    ) as file:
        json.dump(
            runs,
            file,
            ensure_ascii=False,
            separators=(",", ":"),
        )


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


def calculate_hr_zones(
    time_stream: list[int],
    hr_stream: list[float],
) -> list[float]:
    zones = [0.0, 0.0, 0.0, 0.0, 0.0]
    limit = min(
        len(time_stream),
        len(hr_stream)
    )

    for index in range(limit - 1):
        elapsed = (
            time_stream[index + 1]
            - time_stream[index]
        )
        heart_rate = hr_stream[index]

        if (
            0 < elapsed < 120
            and isinstance(
                heart_rate,
                (int, float)
            )
        ):
            zones[
                hr_zone_index(float(heart_rate))
            ] += elapsed

    return zones


def date_fields(
    date_string: str,
) -> tuple[int, int, int]:
    date = datetime.strptime(
        date_string,
        "%Y-%m-%d"
    )

    return (
        date.year,
        date.timetuple().tm_yday,
        date.weekday(),
    )


def download_activities(
    access_token: str,
    after_epoch: int,
) -> list[dict[str, Any]]:
    activities: list[dict[str, Any]] = []
    page = 1

    while True:
        batch = api_get(
            "/athlete/activities"
            f"?after={after_epoch}"
            f"&page={page}"
            "&per_page=100",
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


def get_hr_zones(
    activity_id: int,
    access_token: str,
) -> list[float]:
    try:
        streams = api_get(
            f"/activities/{activity_id}/streams"
            "?keys=time,heartrate"
            "&key_by_type=true",
            access_token,
        )

        time_data = (
            streams
            .get("time", {})
            .get("data", [])
        )

        hr_data = (
            streams
            .get("heartrate", {})
            .get("data", [])
        )

        return calculate_hr_zones(
            time_data,
            hr_data,
        )

    except requests.HTTPError:
        return [0.0, 0.0, 0.0, 0.0, 0.0]


def convert_activity(
    activity: dict[str, Any],
    access_token: str,
) -> dict[str, Any]:
    date_string = activity[
        "start_date_local"
    ][:10]

    year, day_of_year, weekday = date_fields(
        date_string
    )

    start_latlng = (
        activity.get("start_latlng")
        or [None, None]
    )

    activity_id = int(activity["id"])
    average_cadence = activity.get(
        "average_cadence"
    )

    cadence_spm = (
        round(
            float(average_cadence) * 2,
            1,
        )
        if isinstance(
            average_cadence,
            (int, float)
        )
        else None
    )

    return {
        "id": str(activity_id),
        "d": date_string,
        "y": year,
        "doy": day_of_year,
        "wd": weekday,
        "km": round(
            float(
                activity.get("distance", 0)
            ) / 1000,
            3,
        ),
        "min": round(
            float(
                activity.get("moving_time", 0)
            ) / 60,
            2,
        ),
        "hr": activity.get(
            "average_heartrate"
        ),
        "mhr": activity.get(
            "max_heartrate"
        ),
        "cad": cadence_spm,
        "lat": start_latlng[0],
        "lon": start_latlng[1],
        "hrz": get_hr_zones(
            activity_id,
            access_token,
        ),
    }


def main() -> None:
    runs = load_runs()

    existing_ids = {
        str(run["id"])
        for run in runs
        if run.get("id") is not None
    }

    dated_runs = [
        run["d"]
        for run in runs
        if isinstance(run.get("d"), str)
    ]

    if dated_runs:
        last_date = max(dated_runs)

        after_epoch = int(
            datetime.strptime(
                last_date,
                "%Y-%m-%d",
            )
            .replace(tzinfo=timezone.utc)
            .timestamp()
        ) - 86_400
    else:
        after_epoch = 0

    token_data = refresh_access_token()
    access_token = token_data["access_token"]

    activities = download_activities(
        access_token,
        after_epoch,
    )

    added = 0

    for activity in activities:
        activity_id = str(activity["id"])
        sport_type = activity.get(
            "sport_type",
            "",
        )

        if "Run" not in sport_type:
            continue

        if activity_id in existing_ids:
            continue

        runs.append(
            convert_activity(
                activity,
                access_token,
            )
        )

        existing_ids.add(activity_id)
        added += 1

    save_runs(runs)

    print(
        f"Sincronizzazione completata: "
        f"{added} nuove corse"
    )
    print(f"Totale corse: {len(runs)}")


if __name__ == "__main__":
    main()
