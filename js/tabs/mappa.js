// Map tab: worldwide pins / routes of every run with GPS data, plus a
// geographical information layer (Phase 1), location-based Pins
// exploration (Phase 2), and Routes exploration with an activity panel
// and cross-tab navigation into Run Details (Phases 3-4 of the Map Tab
// Redesign memo). Phase 5 (bottom-sheet animation, deep accessibility
// polish) is not part of this pass.
//
// Revision after live user testing of the first version: the standalone
// Heatmap mode was dropped (Routes mode already falls back to the same
// heatmap when zoomed out, so a third button was redundant); the base
// map tiles are fixed to a light style (a dark basemap tested elegant
// but hard to read); Pins mode now shows the actual number of RUNS in
// a cluster instead of Leaflet.markercluster's default "number of
// markers" count; a single click/tap on empty map zooms in; overlapping
// runs at the same spot in Routes mode can be cycled with prev/next
// controls or a swipe; and "Recent locations" was replaced with "Top
// countries by distance" to mirror "Top cities by distance".
(function () {
  const {
    filteredRuns, getRuns, getSelectedYears, fmtPace, fmtKm, fmtDate, fetchJson, dirty,
  } = window.RD.state;

  let leafletMap = null;
  let markerLayer = null;
  let heatLayer = null;
  let routeLayer = null;
  let tileLayer = null;
  // Default mode is "routes": at low zoom it falls back to the heatmap
  // (preserving the global overview from memo section 1), and reveals
  // individual GPS routes as the user zooms in - a single mode that
  // covers what used to be two separate buttons (Heatmap + Routes).
  let mapMode = "routes";
  let currentGroups = [];
  let currentRuns = [];

  /* ---------- Base map ---------- */
  // Fixed to a light basemap: a dark one (CartoDB dark_all, matching the
  // Run Details map elsewhere in the app) was tried first but tested
  // hard to read against the heatmap/pin overlays, so light_all (also
  // CartoDB, same tile family/attribution) is used unconditionally
  // regardless of the app's own light/dark theme toggle.
  const TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";

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
  // "Nearby/overlapping" for the activity panel's prev/next cycling is
  // defined as a fixed PIXEL distance at the current zoom, not a fixed
  // geographic one: a first version used a flat ~100m radius, which on
  // real data pulled in 400+ runs at once for a runner whose runs mostly
  // start from home (100m absolute is "the same house", not "visually
  // overlapping on screen"). Converting the pixel radius to degrees at
  // the current zoom keeps the definition tied to what's actually
  // visually overlapping, however far in the user has zoomed.
  const NEARBY_PIXEL_RADIUS = 14;
  function nearbyThresholdDeg(lat, zoom) {
    const z = Number.isFinite(zoom) ? zoom : ROUTE_ZOOM_THRESHOLD;
    const metersPerPixel = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, z);
    const metersPerDegree = 111320 * Math.cos(lat * Math.PI / 180) || 1;
    return (metersPerPixel * NEARBY_PIXEL_RADIUS) / metersPerDegree;
  }

  let routeTrackCache = new Map(); // activity id (string) -> simplified [lat,lon][] or null (load failed / no track)
  let routeRenderToken = 0; // bumped on every bounds/zoom recompute; stale async loads are ignored
  let selectedRouteId = null;
  let lastVisibleRuns = [];
  let activeNearbyRuns = [];
  let activeNearbyIndex = 0;

  function setMapMode(mode) {
    mapMode = mode;
    document.getElementById("mapPinsBtn")?.classList.toggle("active", mode === "pins");
    document.getElementById("mapRoutesBtn")?.classList.toggle("active", mode === "routes");
    dirty.mappa = true;
    renderMappa();
    dirty.mappa = false;
  }

  document.getElementById("mapPinsBtn")?.addEventListener("click", () => setMapMode("pins"));
  document.getElementById("mapRoutesBtn")?.addEventListener("click", () => setMapMode("routes"));
  document.getElementById("mapSidePanelClose")?.addEventListener("click", closeLocationPanel);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeLocationPanel(); });

  /* ---------- Fullscreen ---------- */
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
  function stopMarkerClickPropagation(e) {
    // Prevents a click on a pin/route/cluster from also being seen by
    // the map's own "click empty space to zoom in" handler below.
    if (typeof L !== "undefined" && L.DomEvent && L.DomEvent.stopPropagation) L.DomEvent.stopPropagation(e);
  }
  function handleMapBackgroundClick(e) {
    if (!leafletMap || !e || !e.latlng) return;
    const currentZoom = leafletMap.getZoom ? leafletMap.getZoom() : 2;
    leafletMap.setView(e.latlng, Math.min(currentZoom + 2, 18));
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

  // One entry per country, aggregating across all of that country's
  // location groups (memo section 8's "Top cities by distance", applied
  // one level up per the user's request).
  function buildCountryGroups(groups) {
    const byCountry = new Map();
    groups.filter(g => !g.isUnknown && g.country).forEach(g => {
      if (!byCountry.has(g.country)) {
        byCountry.set(g.country, { country: g.country, km: 0, n: 0, cities: new Set(), topCity: null });
      }
      const c = byCountry.get(g.country);
      c.km += g.km; c.n += g.n; c.cities.add(g.key);
      if (!c.topCity || g.km > c.topCity.km) c.topCity = g;
    });
    return [...byCountry.values()];
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

  /* ---------- Top countries by distance (replaces Recent locations) ---------- */
  function renderTopCountries(groups) {
    const el = document.getElementById("mapTopCountriesList");
    if (!el) return;
    const countryGroups = buildCountryGroups(groups);
    const top = countryGroups.slice().sort((a, b) => b.km - a.km).slice(0, 6);
    if (!top.length) { el.innerHTML = '<p class="empty">No locations in the selected period</p>'; return; }
    const maxKm = top[0].km || 1;
    el.innerHTML = top.map((c, i) => `
      <div class="map-topcity-row" data-country="${escapeHtml(c.country)}">
        <span class="map-topcity-rank">${i + 1}</span>
        <div class="map-topcity-main">
          <p class="map-topcity-title">${escapeHtml(c.country)} · ${c.cities.size} cit${c.cities.size === 1 ? "y" : "ies"} · ${c.n} run${c.n === 1 ? "" : "s"}</p>
          <div class="map-topcity-bar-track"><div class="map-topcity-bar" style="width:${Math.max(4, (c.km / maxKm) * 100)}%"></div></div>
        </div>
        <span class="map-topcity-value">${fmtKm(c.km)} km</span>
      </div>
    `).join("");
    el.querySelectorAll(".map-topcity-row").forEach(row => {
      row.addEventListener("click", () => {
        selectCountry(countryGroups.find(c => c.country === row.dataset.country));
      });
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
  function countryPanelHtml(c) {
    return `
      <div class="map-panel-header">
        <p class="map-panel-city">${escapeHtml(c.country)}</p>
        <p class="map-panel-country">${c.cities.size} cit${c.cities.size === 1 ? "y" : "ies"}</p>
      </div>
      <div class="map-panel-grid">
        <div class="map-panel-item"><span>Runs</span><strong>${c.n}</strong></div>
        <div class="map-panel-item"><span>Total distance</span><strong>${fmtKm(c.km)} km</strong></div>
        <div class="map-panel-item" style="grid-column:1 / -1;"><span>Top city</span><strong>${c.topCity ? `${escapeHtml(c.topCity.city)} · ${fmtKm(c.topCity.km)} km` : "—"}</strong></div>
      </div>
    `;
  }

  /* ---------- Side panel: activity summary (memo section 5.1) ---------- */
  function runStartText(run) {
    const date = new Date(run.start_local || `${run.d}T12:00:00`);
    if (Number.isNaN(date.getTime())) return run.d;
    return new Intl.DateTimeFormat("en-IT", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  function activityPanelHtml(run, nearbyCount, nearbyIndex) {
    const pace = run.km > 0 && run.min > 0 ? (run.min * 60) / run.km : null;
    const location = [run.location_city, run.location_country].filter(Boolean).join(", ");
    const nav = nearbyCount > 1 ? `
      <div class="map-panel-nav">
        <button class="map-panel-nav-btn" id="mapActivityPrev" type="button" aria-label="Previous overlapping run">‹</button>
        <span class="map-panel-nav-label">${nearbyIndex + 1} of ${nearbyCount} runs here</span>
        <button class="map-panel-nav-btn" id="mapActivityNext" type="button" aria-label="Next overlapping run">›</button>
      </div>` : "";
    return `
      ${nav}
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
    activeNearbyRuns = [];
    const panel = document.getElementById("mapSidePanel");
    const content = document.getElementById("mapSidePanelContent");
    if (!panel || !content || !g) return;
    content.innerHTML = locationPanelHtml(g);
    panel.style.display = "block";
  }
  function openCountryPanel(c) {
    activeNearbyRuns = [];
    const panel = document.getElementById("mapSidePanel");
    const content = document.getElementById("mapSidePanelContent");
    if (!panel || !content || !c) return;
    content.innerHTML = countryPanelHtml(c);
    panel.style.display = "block";
  }
  // Runs starting within ~100m of `run` (itself included), used so
  // overlapping/stacked runs at the same spot can be cycled through
  // instead of only ever showing whichever one happened to be drawn
  // (and therefore clicked) on top (memo section 13 edge case).
  // Even with a zoom-scaled pixel radius, a runner whose runs mostly
  // start from the same house/gym can still have hundreds of "nearby"
  // matches at a moderate zoom - not usefully "overlapping routes to
  // cycle through", just "the same neighbourhood". Capped so prev/next
  // never has to page through dozens of entries; when over the cap, the
  // runs closest in TIME to the clicked one win, on the assumption that
  // "same spot, a day or two apart" is what someone actually meant to
  // compare, not an arbitrary slice.
  const NEARBY_MAX_RESULTS = 12;
  function findNearbyRuns(run) {
    const zoom = leafletMap && leafletMap.getZoom ? leafletMap.getZoom() : ROUTE_ZOOM_THRESHOLD;
    const threshold = nearbyThresholdDeg(run.lat, zoom);
    const matches = currentRuns.filter(r => Math.abs(r.lat - run.lat) < threshold && Math.abs(r.lon - run.lon) < threshold);
    const byDate = (a, b) => a.d.localeCompare(b.d) || String(a.id).localeCompare(String(b.id));
    if (matches.length <= NEARBY_MAX_RESULTS) return matches.sort(byDate);
    const runTime = new Date(run.d).getTime();
    return matches
      .map(r => ({ r, dt: Math.abs(new Date(r.d).getTime() - runTime) }))
      .sort((a, b) => a.dt - b.dt)
      .slice(0, NEARBY_MAX_RESULTS)
      .map(x => x.r)
      .sort(byDate);
  }
  function renderActivityPanel() {
    const panel = document.getElementById("mapSidePanel");
    const content = document.getElementById("mapSidePanelContent");
    if (!panel || !content || !activeNearbyRuns.length) return;
    const run = activeNearbyRuns[activeNearbyIndex];
    content.innerHTML = activityPanelHtml(run, activeNearbyRuns.length, activeNearbyIndex);
    panel.style.display = "block";
    document.getElementById("mapOpenRunDetails")?.addEventListener("click", () => openRunDetails(run));
    document.getElementById("mapActivityPrev")?.addEventListener("click", () => stepActivity(-1));
    document.getElementById("mapActivityNext")?.addEventListener("click", () => stepActivity(1));
    selectedRouteId = String(run.id);
    drawRoutePolylines(lastVisibleRuns);
  }
  function stepActivity(delta) {
    if (activeNearbyRuns.length < 2) return;
    activeNearbyIndex = (activeNearbyIndex + delta + activeNearbyRuns.length) % activeNearbyRuns.length;
    renderActivityPanel();
  }
  function openActivityPanel(run) {
    activeNearbyRuns = findNearbyRuns(run);
    const idx = activeNearbyRuns.findIndex(r => String(r.id) === String(run.id));
    activeNearbyIndex = idx >= 0 ? idx : 0;
    renderActivityPanel();
  }
  // Wired once (not per-render) directly on the persistent panel content
  // element, so repeated navigations don't stack up duplicate listeners.
  function wireActivityPanelSwipeOnce() {
    const content = document.getElementById("mapSidePanelContent");
    if (!content) return;
    let startX = null;
    content.addEventListener("touchstart", e => {
      if (!activeNearbyRuns.length || e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
    }, { passive: true });
    content.addEventListener("touchend", e => {
      if (startX === null || !activeNearbyRuns.length) return;
      const touch = e.changedTouches && e.changedTouches[0];
      const endX = touch ? touch.clientX : startX;
      const delta = endX - startX;
      startX = null;
      if (Math.abs(delta) < 40) return; // ignore taps/small movements
      stepActivity(delta < 0 ? 1 : -1); // swipe left -> next, right -> previous
    }, { passive: true });
  }

  function closeLocationPanel() {
    activeNearbyRuns = [];
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
  function selectCountry(c) {
    if (!c) return;
    const memberGroups = currentGroups.filter(g => !g.isUnknown && g.country === c.country);
    if (leafletMap && memberGroups.length) {
      const bounds = L.latLngBounds(memberGroups.map(g => [g.lat, g.lon]));
      leafletMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
    }
    openCountryPanel(c);
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
  function updateHeatLegendVisibility(show) {
    const legend = document.getElementById("mapHeatLegend");
    if (legend) legend.style.display = show ? "flex" : "none";
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
        line.on("click", e => { stopMarkerClickPropagation(e); selectRoute(run); });
        routeLayer.addLayer(line);
      } else if (routeTrackCache.has(id)) {
        // Track finished loading but has no usable points (or no track
        // file at all): still show the run as a point instead of making
        // it disappear from Routes mode (memo section 13 edge case).
        const marker = L.circleMarker([run.lat, run.lon], { radius: 5, color: "#2a78d6", weight: 2, fillColor: "#2a78d6", fillOpacity: 0.5 });
        marker.on("click", e => { stopMarkerClickPropagation(e); selectRoute(run); });
        routeLayer.addLayer(marker);
      }
      // Not yet in the cache (still loading): draw nothing this pass;
      // the pending fetch redraws once it resolves.
    });
  }
  function selectRoute(run) {
    openActivityPanel(run);
  }
  function renderHeatLayer(runs) {
    updateHeatLegendVisibility(true);
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
    updateHeatLegendVisibility(false);
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

  /* ---------- Pins mode ---------- */
  // Cluster/marker badges show the SUM of runs at that location (or
  // group of nearby locations), not Leaflet.markercluster's default
  // "number of markers in this cluster" - the default would count
  // distinct places, not activities, so the numbers on screen wouldn't
  // add up to "Runs with GPS data in the selected period" like the user
  // expects when "All" years are selected.
  function clusterBadgeColor(count) {
    if (count >= 100) return "red";
    if (count >= 20) return "orange";
    return "green";
  }
  function runCountDivIcon(count, size) {
    const color = clusterBadgeColor(count);
    return L.divIcon({
      html: `<div class="map-cluster-badge map-cluster-badge-${color}" style="width:${size}px;height:${size}px;line-height:${size}px;">${count}</div>`,
      className: "map-cluster-icon",
      iconSize: [size, size],
    });
  }
  function renderPinsMode(runs) {
    // Pins mode represents LOCATIONS, not individual activities (memo
    // section 3.2): one marker per location group, badge shows the run
    // count, and clicking opens the location summary panel rather than
    // a single-run popup.
    currentGroups.forEach(g => {
      const marker = L.marker([g.lat, g.lon], {
        runCount: g.n,
        icon: runCountDivIcon(g.n, 34),
      });
      marker.bindTooltip(`${g.isUnknown ? "Unknown location" : g.city} · ${g.n} run${g.n === 1 ? "" : "s"}`, { direction: "top" });
      marker.on("click", e => { stopMarkerClickPropagation(e); selectLocation(g); });
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
    renderTopCountries(currentGroups);
    renderTopCities(currentGroups);

    if (!leafletMap) {
      leafletMap = L.map("mapContainer", { scrollWheelZoom: true, worldCopyJump: true });
      tileLayer = L.tileLayer(TILE_URL, { maxZoom: 20, attribution: TILE_ATTRIBUTION }).addTo(leafletMap);
      markerLayer = L.markerClusterGroup({
        iconCreateFunction: cluster => {
          const total = cluster.getAllChildMarkers().reduce((sum, m) => sum + (m.options.runCount || 0), 0);
          const size = total >= 100 ? 48 : total >= 20 ? 42 : 36;
          return runCountDivIcon(total, size);
        }
      });
      routeLayer = L.layerGroup();
      leafletMap.on("zoomend moveend", refreshRoutesForCurrentView);
      leafletMap.on("click", handleMapBackgroundClick);
      wireActivityPanelSwipeOnce();
    }

    clearModeLayers();
    updateRouteHint(false);
    updateHeatLegendVisibility(false);

    if (runs.length === 0) {
      leafletMap.setView([20, 0], 2);
      setTimeout(() => leafletMap.invalidateSize(), 50);
      return;
    }

    if (mapMode === "pins") renderPinsMode(runs);
    else renderRoutesMode(runs);

    const bounds = L.latLngBounds(runs.map(r => [r.lat, r.lon]));
    leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: mapMode === "pins" ? 14 : 9 });
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.mappa = { render: renderMappa, getLeafletMap: () => leafletMap };
})();
