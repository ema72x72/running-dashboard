from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any

import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
DEFAULT_USER_AGENT = "running-dashboard/1.0 (https://github.com/ema72x72/running-dashboard)"
CACHE_FILE = Path("data/location_cache.json")


def _valid_coordinate(value: Any, minimum: float, maximum: float) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and minimum <= number <= maximum


def valid_lat_lon(lat: Any, lon: Any) -> bool:
    return _valid_coordinate(lat, -90, 90) and _valid_coordinate(lon, -180, 180)


def coordinate_key(lat: float, lon: float, decimals: int = 3) -> str:
    """Cache coordinates at roughly 100 m resolution."""
    return f"{round(float(lat), decimals):.{decimals}f},{round(float(lon), decimals):.{decimals}f}"


def load_location_cache(path: Path = CACHE_FILE) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as file:
        data = json.load(file)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def save_location_cache(cache: dict[str, dict[str, Any]], path: Path = CACHE_FILE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        json.dump(cache, file, ensure_ascii=False, indent=2, sort_keys=True)
        file.write("\n")


def choose_place(address: dict[str, Any]) -> str | None:
    """Return the most useful human-readable locality from a Nominatim address."""
    for field in (
        "city",
        "town",
        "village",
        "municipality",
        "borough",
        "suburb",
        "hamlet",
        "county",
        "state_district",
        "state",
    ):
        value = address.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def reverse_geocode(
    lat: float,
    lon: float,
    *,
    language: str = "en,it",
    session: requests.Session | None = None,
) -> dict[str, Any]:
    if not valid_lat_lon(lat, lon):
        raise ValueError(f"Invalid coordinates: {lat}, {lon}")

    client = session or requests.Session()
    user_agent = os.getenv("NOMINATIM_USER_AGENT", DEFAULT_USER_AGENT).strip()
    if not user_agent or user_agent.startswith("python-requests"):
        raise RuntimeError("Set NOMINATIM_USER_AGENT to a stable application identifier")

    response = client.get(
        NOMINATIM_URL,
        params={
            "lat": f"{float(lat):.7f}",
            "lon": f"{float(lon):.7f}",
            "format": "jsonv2",
            "addressdetails": 1,
            "zoom": 10,
            "accept-language": language,
        },
        headers={"User-Agent": user_agent},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    address = payload.get("address") if isinstance(payload, dict) else None
    if not isinstance(address, dict):
        address = {}

    return {
        "place": choose_place(address),
        "country": address.get("country"),
        "country_code": address.get("country_code"),
        "state": address.get("state"),
        "display_name": payload.get("display_name") if isinstance(payload, dict) else None,
        "source": "nominatim",
    }


def resolve_location(
    lat: Any,
    lon: Any,
    cache: dict[str, dict[str, Any]],
    *,
    language: str = "en,it",
    session: requests.Session | None = None,
    request_delay_seconds: float = 1.05,
) -> tuple[dict[str, Any] | None, bool]:
    """Resolve a locality and return (result, used_network_request)."""
    if not valid_lat_lon(lat, lon):
        return None, False

    lat_float, lon_float = float(lat), float(lon)
    key = coordinate_key(lat_float, lon_float)
    cached = cache.get(key)
    if isinstance(cached, dict):
        return cached, False

    result = reverse_geocode(lat_float, lon_float, language=language, session=session)
    cache[key] = result
    time.sleep(max(1.0, request_delay_seconds))
    return result, True


def apply_location_fields(run: dict[str, Any], location: dict[str, Any] | None) -> bool:
    """Write reverse-geocoding results onto a run using the field names the
    frontend actually reads (see runLocation() in index.html)."""
    if not location:
        return False

    changed = False
    mapping = {
        "location_city": location.get("place"),
        "location_country": location.get("country"),
        "location_country_code": location.get("country_code"),
        "location_state": location.get("state"),
    }
    for field, value in mapping.items():
        if value and run.get(field) != value:
            run[field] = value
            changed = True
    return changed
