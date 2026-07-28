// Map tab: worldwide heatmap / pins / routes of every run with GPS data,
// plus a geographical information layer (Phase 1), location-based Pins
// exploration (Phase 2), and now Routes exploration with an activity
// panel and cross-tab navigation into Run Details (Phases 3-4 of the Map
// Tab Redesign memo). Phase 5 (bottom-sheet animation, deep accessibility
// polish) is not part of this pass.
(function () {
  const {
    filteredRuns, getRuns, getSelectedYears, fmtPace, fmtKm, fmtDate, fetchJson, dirty,
  } = window.RD.state;

  let leafletMap = null;
  let markerLayer = null;
  let heatLayer = null;
  let routeLayer = null;
  let tileLayer = null;
  let tileLayerIsDark = null;
  let mapMode = "heat";
  let currentGroups = [];
  let currentRuns = [];

  /* ---------- Theme-aware base map (matches the app's light/dark toggle) ---------- */
  // The rest of the app (including the Run Details map in js/tabs/runs.js)
  // already uses CartoDB's dark basemap; this tab previously always used
  // plain OpenStreetMap tiles regardless of theme, which is why it looked
  // washed-out/light next to the mockup and the rest of a dark-mode UI.
  // Re-checked on every render (not just once at map creation) so a
  // theme toggle - which redraws charts via markAllDirty(), not the
  // Leaflet map - still picks up the right tiles next time this tab
  // renders, the same way getGridColor() is re-read on every chart draw.
  function isDarkTheme() {
    const explicit = document.documentElement.getAttribute("data-theme");
    return explicit ? explicit === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function ensureTileLayer() {
    const dark = isDarkTheme();
    if (tileLayer && tileLayerIsDark === dark) return;
    if (tileLayer) leafletMap.removeLayer(tileLayer);
    const style = dark ? "dark_all" : "light_all";
    tileLayer = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    }).addTo(leafletMap);
    tileLayerIsDark = dark;
  }

  /* ---------- Routes mode state (memo sections 3.3, 4, 10) ---------- */
  // Recommended zoom threshold from the memo (11-12); picked 12 as the
  // "definitely detailed enough" end of that range. Below it, Routes mode
  // falls back to the heatmap instead of an empty map.
  const ROUTE_ZOOM_THRESHOLD = 12;
  // Display-only simplification (memo 10.1): a historical track can have
  // thousands of points, but the overview map only needs enough to look
  // like the real route. This never touches the underlying track file.
  const ROUTE_MAX_POINTS = 400;
  // Safety cap for very dense areas (memo section 13's "Bologna" example
  // and the edge case "large dense areas: ... limit visible routes").
  const ROUTE_MAX_VISIBLE = 150;
  const ROUTE_MAX_CONCURRENT_FETCHES = 4;

  let routeTrackCache = new Map(); // activity id (string) -> simplified [lat,lon][] or null (load failed / no track)
  let routeRenderToken = 0; // bumped on every bounds/zoom recompute; stale async loads are ignored
  let selectedRouteId = null;
  let lastVisibleRuns = [];

  function setMapMode(mode) {
    mapMode = mode;
    document.getElementById("mapHeatBtn")?.classList.toggle("active", mode === "heat");
    document.getElementById("mapPinsBtn")?.classList.toggle("active", mode === "pins");
    document.getElementById("mapRoutesBtn")?.classList.toggle("active", mode === "routes");
    const legend = document.getElementById("mapHeatLegend");
    if (legend) legend.style.display = mode === "heat" ? "flex" : "none";
    dirty.mappa = true;
    renderMappa();
    dirty.mappa = false;
  }

  document.getElementById("mapHeatBtn")?.addEventListener("click", () => setMapMode("heat"));
  document.getElementById("mapPinsBtn")?.addEventListener("click", () => setMapMode("pins"));
  document.getElementById("mapRoutesBtn")?.addEventListener("click", () => setMapMode("routes"));
  document.getElementById("mapSidePanelClose")?.addEventListener("click", closeLocationPanel);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeLocationPanel(); });

  /* ---------- Fullscreen (easy win from the memo's mockup toolbar) ---------- */
  function isFullscreen() { return !!document.fullscreenElement; }
  function toggleFullscreen() {
    const wrap = document.querySelector(".map-canvas-wrap");
    if (!wrap) return;
    if (!isFullscreen()) {
      (wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.msRequestFullscreen)?.call(wrap);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen)?.call(document);
    }
  }
  document.getElementById("mapFullscreenBtn")?.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => {
    document.getElementById("mapFullscreenBtn")?.classList.toggle("active", isFullscreen());
    setTimeout(() => leafletMap && leafletMap.invalidateSize(), 60);
  });

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  }

  /* ---------- Location grouping (memo sections 6.1 and 13) ---------- */
  // Runs are grouped by normalised city/state/country so that "Bologna"
  // and " bologna " count as the same place, and "Cambridge, UK" is kept
  // separate from "Cambridge, USA" (state+country included in the key,
  // not just the display label). Runs with coordinates but no location
  // text are grouped into a coarse ~1km coordinate cluster instead of
  // being dropped or counted one row per run.
  function normalizeKeyPart(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  function locationKey(run) {
    if (run.location_city) {
      return "city:" + normalizeKeyPart(run.location_city) + "|" + normalizeKeyPart(run.location_state) + "|" + normalizeKeyPart(run.location_country);
    }
    const latRound = Math.round(run.lat * 100) / 100;
    const lonRound = Math.round(run.lon * 100) / 100;
    return "unk:" + latRound + "," + lonRound;
  }

  // runs passed in must already be filtered to those with valid lat/lon.
  function buildLocationGroups(runs) {
    const groups = new Map();
    runs.forEach(r => {
      const key = locationKey(r);
      if (!groups.has(key)) {
        groups.set(key, {
          key, isUnknown: !r.location_city,
          city: r.location_city || "Unknown location",
          state: r.location_state || "",
          country: r.location_country || "",
          km: 0, min: 0, n: 0, latSum: 0, lonSum: 0,
          firstDate: r.d, lastDate: r.d, years: new Set(),
        });
      }
      const g = groups.get(key);
      g.km += r.km; g.min += r.min; g.n += 1;
      g.latSum += r.lat; g.lonSum += r.lon;
      if (r.d < g.firstDate) g.firstDate = r.d;
      if (r.d > g.lastDate) g.lastDate = r.d;
      if (Number.isFinite(r.y)) g.years.add(r.y);
    });
    groups.forEach(g => {
      g.lat = g.latSum / g.n;
      g.lon = g.lonSum / g.n;
      g.avgKm = g.n > 0 ? g.km / g.n : 0;
      g.label = g.isUnknown ? "Unknown location" : [g.city, g.country].filter(Boolean).join(", ");
    });
    return [...groups.values()];
  }

  /* ---------- Geographical summary cards (memo section 6) ---------- */
  function computeSummaryCards(runs, groups, selectedYears) {
    const known = groups.filter(g => !g.isUnknown);
    const countries = new Set(known.map(g => g.country).filter(Boolean)).size;
    const cities = known.length;

    const years = [...selectedYears].sort((a, b) => b - a);
    const referenceYear = years.length ? years[0] : null;

    // "First visit" is computed from the runner's ENTIRE history (not
    // just the currently filtered years): otherwise narrowing the year
    // filter could make a long-known city look "new" just because its
    // earlier visits fall outside the current selection. Tracked at both
    // city and country level: a country only counts as "new this year"
    // if the very first run recorded in ANY of its cities happened this
    // year - visiting a second city of an already-known country doesn't
    // make the country new again.
    const globalFirstYearByCity = new Map();
    const globalFirstYearByCountry = new Map();
    getRuns().forEach(r => {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !r.location_city) return;
      const key = locationKey(r);
      const existingCity = globalFirstYearByCity.get(key);
      if (existingCity === undefined || r.y < existingCity) globalFirstYearByCity.set(key, r.y);
      if (r.location_country) {
        const existingCountry = globalFirstYearByCountry.get(r.location_country);
        if (existingCountry === undefined || r.y < existingCountry) globalFirstYearByCountry.set(r.location_country, r.y);
      }
    });
    const newPlaces = referenceYear !== null
      ? known.filter(g => globalFirstYearByCity.get(g.key) === referenceYear)
      : [];
    const newCountriesCount = referenceYear !== null
      ? new Set(known.map(g => g.country).filter(country => country && globalFirstYearByCountry.get(country) === referenceYear)).size
      : 0;

    let favouriteCity = null;
    known.forEach(g => {
      if (!favouriteCity || g.km > favouriteCity.km || (g.km === favouriteCity.km && g.n > favouriteCity.n)) favouriteCity = g;
    });
    const totalKnownKm = known.reduce((sum, g) => sum + g.km, 0);
    const favouriteSharePct = favouriteCity && totalKnownKm > 0 ? (favouriteCity.km / totalKnownKm) * 100 : null;

    // Most travelled year needs per-calendar-year distinct country/city
    // counts, which the location groups (already merged across years)
    // can't give directly, so this re-scans the raw runs by year.
    const byYear = new Map();
    runs.forEach(r => {
      if (!r.location_city || !Number.isFinite(r.y)) return;
      if (!byYear.has(r.y)) byYear.set(r.y, { countries: new Set(), cities: new Set(), km: 0 });
      const e = byYear.get(r.y);
      if (r.location_country) e.countries.add(r.location_country);
      e.cities.add(locationKey(r));
      e.km += r.km;
    });
    let mostTravelledYear = null;
    byYear.forEach((e, y) => {
      const candidate = { year: y, countries: e.countries, cities: e.cities, km: e.km };
      if (!mostTravelledYear
        || candidate.countries.size > mostTravelledYear.countries.size
        || (candidate.countries.size === mostTravelledYear.countries.size && candidate.cities.size > mostTravelledYear.cities.size)
        || (candidate.countries.size === mostTravelledYear.countries.size && candidate.cities.size === mostTravelledYear.cities.size && candidate.km > mostTravelledYear.km)) {
        mostTravelledYear = candidate;
      }
    });

    return { countries, cities, newPlaces, newCountriesCount, favouriteCity, favouriteSharePct, mostTravelledYear, referenceYear };
  }

  function renderSummaryCards(stats) {
    const el = document.getElementById("mapStats");
    if (!el) return;
    const cards = [
      {
        icon: "🌐", color: "purple", label: "Countries", value: stats.countries,
        sub: stats.newCountriesCount > 0 ? `+${stats.newCountriesCount} this year` : "",
        subAccent: "green",
      },
      {
        icon: "🏙", color: "blue", label: "Cities", value: stats.cities,
        sub: stats.newPlaces.length > 0 ? `+${stats.newPlaces.length} this year` : "",
        subAccent: "green",
      },
      {
        icon: "📍", color: "green", label: "New places", value: stats.newPlaces.length,
        sub: stats.referenceYear
          ? (stats.newPlaces.length ? `${stats.referenceYear} · ${stats.newPlaces.slice(0, 3).map(g => g.city).join(", ")}` : String(stats.referenceYear))
          : "",
      },
      {
        icon: "⭐", color: "orange", label: "Favourite city", labelAccent: "orange", value: stats.favouriteCity ? stats.favouriteCity.city : "—",
        sub: stats.favouriteCity
          ? `${stats.favouriteCity.n} runs · ${fmtKm(stats.favouriteCity.km)} km`
            + (Number.isFinite(stats.favouriteSharePct) ? ` · ${Math.round(stats.favouriteSharePct)}% of total distance` : "")
          : "",
      },
      {
        icon: "✈", color: "purple", label: "Most travelled year", value: stats.mostTravelledYear ? stats.mostTravelledYear.year : "—",
        sub: stats.mostTravelledYear ? `${stats.mostTravelledYear.countries.size} countries · ${stats.mostTravelledYear.cities.size} cities` : "",
      },
    ];
    el.innerHTML = cards.map(c => `
      <div class="map-stat-card">
        <div class="map-stat-icon map-stat-icon-${c.color}">${c.icon}</div>
        <p class="map-stat-value">${escapeHtml(c.value)}</p>
        <p class="map-stat-label${c.labelAccent ? ` map-stat-accent-${c.labelAccent}` : ""}">${c.label}</p>
        <p class="map-stat-sub${c.subAccent ? ` map-stat-accent-${c.subAccent}` : ""}">${escapeHtml(c.sub || "")}</p>
      </div>
    `).join("");
  }

  /* ---------- Recent locations (memo section 7) ---------- */
  function renderRecentLocations(groups) {
    const el = document.getElementById("mapRecentList");
    if (!el) return;
    const recent = groups.filter(g => !g.isUnknown).sort((a, b) => b.lastDate.localeCompare(a.lastDate)).slice(0, 5);
    if (!recent.length) { el.innerHTML = '<p class="empty">No locations in the selected period</p>'; return; }
    el.innerHTML = recent.map(g => `
      <div class="map-list-row" data-key="${escapeHtml(g.key)}">
        <div class="map-list-row-icon">📍</div>
        <div class="map-list-row-main">
          <p class="map-list-row-title">${escapeHtml(g.city)}, ${escapeHtml(g.country)}</p>
          <p class="map-list-row-sub">${fmtDate(new Date(g.lastDate + "T00:00:00"))} · ${g.n} run${g.n === 1 ? "" : "s"}</p>
        </div>
        <div class="map-list-row-value">${fmtKm(g.km)} km</div>
      </div>
    `).join("");
    el.querySelectorAll(".map-list-row").forEach(row => {
      row.addEventListener("click", () => selectLocationByKey(row.dataset.key));
    });
  }

  /* ---------- Top cities by distance (memo section 8) ---------- */
  function renderTopCities(groups) {
    const el = document.getElementById("mapTopCitiesList");
    if (!el) return;
    const top = groups.filter(g => !g.isUnknown).sort((a, b) => b.km - a.km).slice(0, 6);
    if (!top.length) { el.innerHTML = '<p class="empty">No locations in the selected period</p>'; return; }
    const maxKm = top[0].km || 1;
    el.innerHTML = top.map((g, i) => `
      <div class="map-topcity-row" data-key="${escapeHtml(g.key)}">
        <span class="map-topcity-rank">${i + 1}</span>
        <div class="map-topcity-main">
          <p class="map-topcity-title">${escapeHtml(g.city)}, ${escapeHtml(g.country)} · ${g.n} run${g.n === 1 ? "" : "s"}</p>
          <div class="map-topcity-bar-track"><div class="map-topcity-bar" style="width:${Math.max(4, (g.km / maxKm) * 100)}%"></div></div>
        </div>
        <span class="map-topcity-value">${fmtKm(g.km)} km</span>
      </div>
    `).join("");
    el.querySelectorAll(".map-topcity-row").forEach(row => {
      row.addEventListener("click", () => selectLocationByKey(row.dataset.key));
    });
  }

  /* ---------- Side panel: location summary (memo section 5.2) ---------- */
  // "View runs in this location" (cross-tab navigation into the Runs
  // tab with a location filter) is explicitly Phase 4 of the memo's own
  // delivery plan and is left out here; only the Routes-mode activity
  // panel's "Open run details" (also Phase 4, but for a single run) is
  // in scope for this pass.
  function locationPanelHtml(g) {
    return `
      <div class="map-panel-header">
        <p class="map-panel-city">${escapeHtml(g.city)}</p>
        <p class="map-panel-country">${escapeHtml([g.state, g.country].filter(Boolean).join(", "))}</p>
      </div>
      <div class="map-panel-grid">
        <div class="map-panel-item"><span>Runs</span><strong>${g.n}</strong></div>
        <div class="map-panel-item"><span>Total distance</span><strong>${fmtKm(g.km)} km</strong></div>
        <div class="map-panel-item"><span>Avg. distance</span><strong>${fmtKm(g.avgKm)} km</strong></div>
        <div class="map-panel-item"><span>First run</span><strong>${fmtDate(new Date(g.firstDate + "T00:00:00"))}</strong></div>
        <div class="map-panel-item" style="grid-column:1 / -1;"><span>Most recent run</span><strong>${fmtDate(new Date(g.lastDate + "T00:00:00"))}</strong></div>
      </div>
    `;
  }

  /* ---------- Side panel: activity summary (memo section 5.1) ---------- */
  function runStartText(run) {
    const date = new Date(run.start_local || `${run.d}T12:00:00`);
    if (Number.isNaN(date.getTime())) return run.d;
    return new Intl.DateTimeFormat("en-IT", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  function activityPanelHtml(run) {
    const pace = run.km > 0 && run.min > 0 ? (run.min * 60) / run.km : null;
    const location = [run.location_city, run.location_country].filter(Boolean).join(", ");
    return `
      <div class="map-panel-header">
        <p class="map-panel-city">${escapeHtml(run.name || "Run")}</p>
        <p class="map-panel-country">${escapeHtml(runStartText(run))}${location ? " · " + escapeHtml(location) : ""}</p>
      </div>
      <div class="map-panel-grid">
        <div class="map-panel-item"><span>Distance</span><strong>${fmtKm(run.km)} km</strong></div>
        <div class="map-panel-item"><span>Pace</span><strong>${pace ? fmtPace(pace) + " /km" : "—"}</strong></div>
        <div class="map-panel-item"><span>Avg HR</span><strong>${Number.isFinite(run.hr) ? Math.round(run.hr) + " bpm" : "—"}</strong></div>
        <div class="map-panel-item"><span>Elevation gain</span><strong>${Number.isFinite(run.elev) ? Math.round(run.elev) + " m" : "—"}</strong></div>
      </div>
      <button class="map-panel-action" id="mapOpenRunDetails" type="button">Open run details →</button>
    `;
  }
  function openRunDetails(run) {
    if (window.RD.tabs.runs && window.RD.tabs.runs.selectRunById) window.RD.tabs.runs.selectRunById(run.id);
    if (window.RD.activateTab) window.RD.activateTab("runs");
  }

  function openLocationPanel(g) {
    const panel = document.getElementById("mapSidePanel");
    const content = document.getElementById("mapSidePanelContent");
    if (!panel || !content || !g) return;
    content.innerHTML = locationPanelHtml(g);
    panel.style.display = "block";
  }
  function openActivityPanel(run) {
    const panel = document.getElementById("mapSidePanel");
    const content = document.getElementById("mapSidePanelContent");
    if (!panel || !content || !run) return;
    content.innerHTML = activityPanelHtml(run);
    panel.style.display = "block";
    document.getElementById("mapOpenRunDetails")?.addEventListener("click", () => openRunDetails(run));
  }
  function closeLocationPanel() {
    const panel = document.getElementById("mapSidePanel");
    if (panel) panel.style.display = "none";
  }
  function selectLocation(g) {
    if (!g) return;
    if (leafletMap) {
      const targetZoom = Math.max(leafletMap.getZoom ? leafletMap.getZoom() : 0, 11);
      leafletMap.setView([g.lat, g.lon], targetZoom);
    }
    openLocationPanel(g);
  }
  function selectLocationByKey(key) {
    selectLocation(currentGroups.find(group => group.key === key));
  }

  /* ---------- Routes mode (memo sections 3.3, 4, 10, 13) ---------- */
  function trackPath(run) {
    if (run.track_file) return run.track_file;
    if (run.id !== null && run.id !== undefined && String(run.id).trim()) return `data/tracks/${String(run.id).trim()}.json`;
    return null;
  }
  async function loadRouteTrack(run) {
    const id = String(run.id);
    if (routeTrackCache.has(id)) return routeTrackCache.get(id);
    const path = trackPath(run);
    if (!path) { routeTrackCache.set(id, null); return null; }
    try {
      const track = await fetchJson(path);
      const points = Array.isArray(track?.points) ? track.points : [];
      const step = Math.max(1, Math.ceil(points.length / ROUTE_MAX_POINTS));
      const simplified = points
        .filter((_, i) => i % step === 0 || i === points.length - 1)
        .map(p => [Number(p.lat), Number(p.lon)])
        .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
      routeTrackCache.set(id, simplified.length >= 2 ? simplified : null);
      return routeTrackCache.get(id);
    } catch (error) {
      console.error("Route track load failed", path, error);
      routeTrackCache.set(id, null);
      return null;
    }
  }
  // Simple bounded-concurrency pool (memo 10.2 "limit concurrent
  // fetches") without pulling in a dependency: a fixed number of workers
  // each pull the next item off a shared queue until it's empty.
  async function loadTracksWithLimit(runsNeeding) {
    const queue = runsNeeding.slice();
    const workerCount = Math.min(ROUTE_MAX_CONCURRENT_FETCHES, queue.length);
    const workers = new Array(workerCount).fill(0).map(async () => {
      while (queue.length) {
        const run = queue.shift();
        await loadRouteTrack(run);
      }
    });
    await Promise.all(workers);
  }
  function updateRouteHint(show) {
    const hint = document.getElementById("mapRouteHint");
    if (hint) hint.style.display = show ? "block" : "none";
  }
  function drawRoutePolylines(runsToShow) {
    if (!routeLayer) return;
    routeLayer.clearLayers();
    runsToShow.forEach(run => {
      const id = String(run.id);
      const latlngs = routeTrackCache.get(id);
      if (latlngs && latlngs.length >= 2) {
        const isSelected = selectedRouteId === id;
        const line = L.polyline(latlngs, {
          color: isSelected ? "#e34948" : "#2a78d6",
          // Selection is shown with a visibly thicker line, not colour
          // alone (memo section 12 accessibility requirement).
          weight: isSelected ? 5 : 3,
          opacity: isSelected ? 0.95 : 0.6,
        });
        line.on("click", () => selectRoute(run));
        routeLayer.addLayer(line);
      } else if (routeTrackCache.has(id)) {
        // Track finished loading but has no usable points (or no track
        // file at all): still show the run as a point instead of making
        // it disappear from Routes mode (memo section 13 edge case).
        const marker = L.circleMarker([run.lat, run.lon], { radius: 5, color: "#2a78d6", weight: 2, fillColor: "#2a78d6", fillOpacity: 0.5 });
        marker.on("click", () => selectRoute(run));
        routeLayer.addLayer(marker);
      }
      // Not yet in the cache (still loading): draw nothing this pass;
      // the pending fetch redraws once it resolves.
    });
  }
  function selectRoute(run) {
    selectedRouteId = String(run.id);
    drawRoutePolylines(lastVisibleRuns);
    openActivityPanel(run);
  }
  function renderHeatLayer(runs) {
    if (heatLayer && leafletMap.hasLayer(heatLayer)) return;
    const heatPoints = runs.map(r => [r.lat, r.lon, 0.65]);
    heatLayer = L.heatLayer(heatPoints, {
      radius: 24, blur: 20, maxZoom: 11, minOpacity: 0.28,
      gradient: { 0.20: "#2a78d6", 0.40: "#34d399", 0.60: "#fbbf24", 0.80: "#fb923c", 1.00: "#e34948" }
    }).addTo(leafletMap);
  }
  function renderRoutesMode(runs) {
    if (!leafletMap) return;
    const zoom = leafletMap.getZoom ? leafletMap.getZoom() : 0;
    if (!Number.isFinite(zoom) || zoom < ROUTE_ZOOM_THRESHOLD) {
      // Performance rule (memo 3.3): never load/draw routes at world
      // scale. Fall back to the heatmap so the view isn't empty while
      // the user zooms in, instead of a hard "blank until zoomed" cut.
      updateRouteHint(true);
      if (routeLayer && leafletMap.hasLayer(routeLayer)) leafletMap.removeLayer(routeLayer);
      renderHeatLayer(runs);
      return;
    }
    updateRouteHint(false);
    if (heatLayer && leafletMap.hasLayer(heatLayer)) leafletMap.removeLayer(heatLayer);
    if (!leafletMap.hasLayer(routeLayer)) leafletMap.addLayer(routeLayer);

    const bounds = leafletMap.getBounds ? leafletMap.getBounds() : null;
    const visible = (bounds ? runs.filter(r => bounds.contains([r.lat, r.lon])) : runs).slice(0, ROUTE_MAX_VISIBLE);
    lastVisibleRuns = visible;

    const token = ++routeRenderToken;
    drawRoutePolylines(visible); // draw whatever is already cached immediately
    const needFetch = visible.filter(r => !routeTrackCache.has(String(r.id)));
    if (needFetch.length) {
      loadTracksWithLimit(needFetch).then(() => {
        if (token !== routeRenderToken) return; // map moved on meanwhile; stale
        drawRoutePolylines(visible);
      });
    }
  }
  // Re-evaluates which routes are visible as the user pans/zooms, without
  // touching the current view (memo 10: "listen to zoomend and moveend").
  function refreshRoutesForCurrentView() {
    if (mapMode !== "routes") return;
    renderRoutesMode(currentRuns);
  }

  function renderHeatMode(runs) { renderHeatLayer(runs); }
  function renderPinsMode(runs) {
    // Pins mode represents LOCATIONS, not individual activities (memo
    // section 3.2): one marker per location group, tooltip shows the
    // run count, and clicking opens the location summary panel rather
    // than a single-run popup.
    currentGroups.forEach(g => {
      const marker = L.marker([g.lat, g.lon]);
      marker.bindTooltip(`${g.isUnknown ? "Unknown location" : g.city} · ${g.n} run${g.n === 1 ? "" : "s"}`, { direction: "top" });
      marker.on("click", () => selectLocation(g));
      markerLayer.addLayer(marker);
    });
    leafletMap.addLayer(markerLayer);
  }
  function clearModeLayers() {
    if (markerLayer && leafletMap.hasLayer(markerLayer)) leafletMap.removeLayer(markerLayer);
    if (heatLayer && leafletMap.hasLayer(heatLayer)) leafletMap.removeLayer(heatLayer);
    if (routeLayer && leafletMap.hasLayer(routeLayer)) leafletMap.removeLayer(routeLayer);
    if (markerLayer) markerLayer.clearLayers();
    if (routeLayer) routeLayer.clearLayers();
  }

  /* ---------- Map canvas ---------- */
  function renderMappa() {
    const runs = filteredRuns().filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    document.getElementById("mapCount").textContent = runs.length;
    closeLocationPanel();
    currentRuns = runs;
    selectedRouteId = null;

    currentGroups = buildLocationGroups(runs);
    renderSummaryCards(computeSummaryCards(runs, currentGroups, getSelectedYears()));
    renderRecentLocations(currentGroups);
    renderTopCities(currentGroups);

    if (!leafletMap) {
      leafletMap = L.map("mapContainer", { scrollWheelZoom: true, worldCopyJump: true });
      markerLayer = L.markerClusterGroup();
      routeLayer = L.layerGroup();
      leafletMap.on("zoomend moveend", refreshRoutesForCurrentView);
    }
    ensureTileLayer();

    clearModeLayers();
    updateRouteHint(false);

    if (runs.length === 0) {
      leafletMap.setView([20, 0], 2);
      setTimeout(() => leafletMap.invalidateSize(), 50);
      return;
    }

    if (mapMode === "heat") renderHeatMode(runs);
    else if (mapMode === "pins") renderPinsMode(runs);
    else if (mapMode === "routes") renderRoutesMode(runs);

    const bounds = L.latLngBounds(runs.map(r => [r.lat, r.lon]));
    leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: mapMode === "pins" ? 14 : 9 });
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.mappa = { render: renderMappa, getLeafletMap: () => leafletMap };
})();
