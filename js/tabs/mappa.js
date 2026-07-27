// Map tab: worldwide heatmap / pins of every run with GPS data.
(function () {
  const { filteredRuns, fmtPace, dirty } = window.RD.state;

  let leafletMap = null;
  let markerLayer = null;
  let heatLayer = null;
  let mapMode = "heat";

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

  function renderMappa() {
    const runs = filteredRuns().filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    document.getElementById("mapCount").textContent = runs.length;

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
      const markers = runs.map(r => {
        const m = L.marker([r.lat, r.lon]);
        const pace = r.km > 0 ? fmtPace((r.min*60)/r.km) : "-";
        m.bindPopup(`<div class="popuprun"><b>${r.d}</b><br>${r.km.toFixed(2)} km &middot; ${pace} /km${r.hr ? " · " + Math.round(r.hr) + " bpm" : ""}</div>`);
        return m;
      });
      markers.forEach(m => markerLayer.addLayer(m));
      leafletMap.addLayer(markerLayer);
    }

    const bounds = L.latLngBounds(runs.map(r => [r.lat, r.lon]));
    leafletMap.fitBounds(bounds, { padding: [24,24], maxZoom: mapMode === "heat" ? 9 : 14 });
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.mappa = { render: renderMappa, getLeafletMap: () => leafletMap };
})();
