// Map tab: worldwide heatmap / pins of every run with GPS data, plus a
// geographical information layer (Phase 1) and location-based Pins
// exploration with a location summary panel (Phase 2) from the Map Tab
// Redesign memo. Routes mode, per-activity GPS track loading and
// cross-tab navigation to Run Details are later phases and are not part
// of this pass.
(function () {
  const {
    filteredRuns, getRuns, getSelectedYears, fmtPace, fmtKm, fmtDate, dirty,
  } = window.RD.state;

  let leafletMap = null;
  let markerLayer = null;
  let heatLayer = null;
  let mapMode = "heat";
  let currentGroups = [];

  function setMapMode(mode) {
    mapMode = mode;
    document.getElementById("mapHeatBtn")?.classList.toggle("active", mode === "heat");
    document.getElementById("mapPinsBtn")?.classList.toggle("active", mode === "pins");
    const legend = document.getElementById("mapHeatLegend");
    if (legend) legend.style.display = mode === "heat" ? "flex" : "none";
    dirty.mappa = true;
    renderMappa();
    dirty.mappa = false;
  }

  document.getElementById("mapHeatBtn")?.addEventListener("click", () => setMapMode("heat"));
  document.getElementById("mapPinsBtn")?.addEventListener("click", () => setMapMode("pins"));
  document.getElementById("mapSidePanelClose")?.addEventListener("click", closeLocationPanel);

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
    // earlier visits fall outside the current selection.
    const globalFirstYear = new Map();
    getRuns().forEach(r => {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !r.location_city) return;
      const key = locationKey(r);
      const existing = globalFirstYear.get(key);
      if (existing === undefined || r.y < existing) globalFirstYear.set(key, r.y);
    });
    const newPlaces = referenceYear !== null
      ? known.filter(g => globalFirstYear.get(g.key) === referenceYear)
      : [];

    let favouriteCity = null;
    known.forEach(g => {
      if (!favouriteCity || g.km > favouriteCity.km || (g.km === favouriteCity.km && g.n > favouriteCity.n)) favouriteCity = g;
    });

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

    return { countries, cities, newPlaces, favouriteCity, mostTravelledYear, referenceYear };
  }

  function renderSummaryCards(stats) {
    const el = document.getElementById("mapStats");
    if (!el) return;
    const cards = [
      { icon: "🌐", label: "Countries", value: stats.countries, sub: "" },
      { icon: "🏙", label: "Cities", value: stats.cities, sub: "" },
      {
        icon: "📍", label: "New places", value: stats.newPlaces.length,
        sub: stats.referenceYear
          ? (stats.newPlaces.length ? `${stats.referenceYear} · ${stats.newPlaces.slice(0, 3).map(g => g.city).join(", ")}` : String(stats.referenceYear))
          : "",
      },
      {
        icon: "⭐", label: "Favourite city", value: stats.favouriteCity ? stats.favouriteCity.city : "—",
        sub: stats.favouriteCity ? `${fmtKm(stats.favouriteCity.km)} km · ${stats.favouriteCity.n} runs` : "",
      },
      {
        icon: "✈", label: "Most travelled year", value: stats.mostTravelledYear ? stats.mostTravelledYear.year : "—",
        sub: stats.mostTravelledYear ? `${stats.mostTravelledYear.countries.size} countries · ${stats.mostTravelledYear.cities.size} cities` : "",
      },
    ];
    el.innerHTML = cards.map(c => `
      <div class="map-stat-card">
        <div class="map-stat-icon">${c.icon}</div>
        <p class="map-stat-value">${escapeHtml(c.value)}</p>
        <p class="map-stat-label">${c.label}</p>
        <p class="map-stat-sub">${escapeHtml(c.sub || "")}</p>
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

  /* ---------- Location summary panel (memo section 5.2) ---------- */
  // "View runs in this location" (cross-tab navigation into the Runs
  // tab) is explicitly Phase 4 in the memo's own delivery plan and is
  // deliberately left out of this pass.
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
  function openLocationPanel(g) {
    const panel = document.getElementById("mapSidePanel");
    const content = document.getElementById("mapSidePanelContent");
    if (!panel || !content || !g) return;
    content.innerHTML = locationPanelHtml(g);
    panel.style.display = "block";
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

  /* ---------- Map canvas (heatmap / pins) ---------- */
  function renderMappa() {
    const runs = filteredRuns().filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    document.getElementById("mapCount").textContent = runs.length;
    closeLocationPanel();

    currentGroups = buildLocationGroups(runs);
    renderSummaryCards(computeSummaryCards(runs, currentGroups, getSelectedYears()));
    renderRecentLocations(currentGroups);
    renderTopCities(currentGroups);

    if (!leafletMap) {
      leafletMap = L.map("mapContainer", { scrollWheelZoom: true, worldCopyJump: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(leafletMap);
      markerLayer = L.markerClusterGroup();
    }

    if (markerLayer && leafletMap.hasLayer(markerLayer)) leafletMap.removeLayer(markerLayer);
    if (heatLayer && leafletMap.hasLayer(heatLayer)) leafletMap.removeLayer(heatLayer);
    markerLayer.clearLayers();

    if (runs.length === 0) {
      leafletMap.setView([20, 0], 2);
      setTimeout(() => leafletMap.invalidateSize(), 50);
      return;
    }

    if (mapMode === "heat") {
      // Each run contributes equally: visual density represents
      // quante volte hai corso in una determinata area geografica.
      const heatPoints = runs.map(r => [r.lat, r.lon, 0.65]);
      heatLayer = L.heatLayer(heatPoints, {
        radius: 24,
        blur: 20,
        maxZoom: 11,
        minOpacity: 0.28,
        gradient: {
          0.20: "#2a78d6",
          0.40: "#34d399",
          0.60: "#fbbf24",
          0.80: "#fb923c",
          1.00: "#e34948"
        }
      }).addTo(leafletMap);
    } else {
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

    const bounds = L.latLngBounds(runs.map(r => [r.lat, r.lon]));
    leafletMap.fitBounds(bounds, { padding: [24, 24], maxZoom: mapMode === "heat" ? 9 : 14 });
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.mappa = { render: renderMappa, getLeafletMap: () => leafletMap };
})();
