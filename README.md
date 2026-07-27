# running-dashboard

Single-page running dashboard (`index.html`) backed by data synced from Strava.

## Data pipeline

- `scripts/sync_strava.py` — runs on a schedule via `.github/workflows/sync-strava.yml`.
  Pulls new/updated activities from Strava, writes `data/runs.json`,
  `data/metadata.json` and per-run GPS tracks in `data/tracks/<id>.json`.
  Also reverse-geocodes each run's start coordinates (via `location_utils.py`)
  and writes `location_city` / `location_state` / `location_country` /
  `location_country_code`, caching lookups in `data/location_cache.json` so
  Nominatim is only queried once per ~100 m grid cell.

- `scripts/tcx_import.py` — **local-only** maintenance script, not part of
  the GitHub Action. Backfills `data/tracks/*.json` for historical runs from
  local Smashrun `.tcx` exports instead of Strava's streams API (which is
  only ever queried for the small incremental sync window, and would take
  days to backfill hundreds of activities against Strava's rate limits).
  Run it whenever you have a folder of `smashrun-YYYY-MM-DD-<id>.tcx` files
  to import:

  ```
  python scripts/tcx_import.py --tcx-dir /path/to/tcx/folder
  ```

  Safe to re-run repeatedly (idempotent): tracks it already generated get
  refreshed if the parser improves, tracks that came from Strava are never
  touched. Runs that were never uploaded to Strava (no numeric id) get a
  stable synthetic id `sr<smashrun-id>` so the frontend can address them
  like any other run.

- `scripts/backfill_locations.py` — **local-only** maintenance script.
  Backfills `location_city`/`location_state`/`location_country` for runs
  that already existed before the automated sync started doing this itself
  (e.g. right after importing historical tracks with `tcx_import.py`).
  Shares its cache and field names with the automated sync, so this is
  safe to run at any time:

  ```
  python scripts/backfill_locations.py
  ```

## Known limitation

Around 60 historical runs have no matching Strava activity and no local
`.tcx` export either, so they have no GPS track and no `id`. They still show
up in the "Runs" tab with their basic stats (distance, time, heart rate).
