// Shared state and utilities used by more than one tab.
//
// Plain classic script (not an ES module): ES module scripts are blocked by
// browsers when the page is opened directly from disk (file://), which
// would silently break the whole app (no tab clicks, no data) for anyone
// previewing it with a double-click instead of a real web server. Loading
// this file first via a normal <script src="js/state.js"> and attaching
// everything to a single global RD namespace works from file:// and from
// any server exactly like the original single-file script did.
(function () {
  let RUNS = [];
  let ALL_YEARS = [];
  let selectedYears = new Set(ALL_YEARS);

  const YEAR_COLORS = {2014:"#94a3b8",2015:"#60a5fa",2016:"#34d399",2017:"#a78bfa",2018:"#fb923c",2019:"#f87171",2020:"#fbbf24",2021:"#38bdf8",2022:"#4ade80",2023:"#f472b6",2024:"#c084fc",2025:"#2a78d6",2026:"#e34948",2027:"#0f6e56",2028:"#993556"};
  const WD_LABELS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  // Boundaries match the athlete's actual current Strava HR zone config
  // (checked via the Strava zones endpoint on 2026-08-25: 0-108 / 109-134 /
  // 135-148 / 149-161 / 162+, source "MaxHeartRateFromAge"), which is what
  // the per-run `hrz` seconds-per-zone breakdown below is actually bucketed
  // against. The old hardcoded ranges here (Easy <130 / Moderate 130-145 /
  // Steady 145-160 / Hard 160-175 / Maximum 175+) didn't match Strava's own
  // zones at all and overstated the athlete's real max HR (~165bpm,
  // confirmed 2026-08-24) - Strava's Z5 cutoff of 162 is much closer to
  // that reality than the old "175+" label ever was.
  const HRZ_LABELS = ["Easy <109","Moderate 109-134","Steady 135-148","Hard 149-161","Maximum 162+"];
  const HRZ_COLORS = ["#60a5fa","#34d399","#fbbf24","#fb923c","#e34948"];

  const darkMediaQuery = matchMedia("(prefers-color-scheme: dark)");

  // Mirrors the CSS rule in style.css: an explicit choice from the theme
  // toggle (data-theme attribute, set by js/theme.js) wins over the
  // system/browser preference. Kept as a function rather than a value
  // snapshotted once at page load, so charts re-rendered after a theme
  // toggle pick up the right grid color instead of the original one.
  function getGridColor() {
    const explicit = document.documentElement.getAttribute("data-theme");
    const isDark = explicit ? explicit === "dark" : darkMediaQuery.matches;
    return isDark ? "#2c2c2a" : "#e1e0d9";
  }
  const mutedColor = "#898781";
  Chart.defaults.color = mutedColor;

  // Per-tab "needs re-render" flags and the Chart.js instance registry used
  // by upsertChart/destroyChart. Both are mutated in place (never
  // reassigned as a whole), so sharing the object itself is safe.
  const dirty = {totali:true, runs:true, annuale:true, trend:true, cumulata:true, passofc:true, efficienza:true, settimana:true, mappa:true};
  const charts = {};

  function markAllDirty() {
    for (const k in dirty) dirty[k] = true;
  }

  // Activities under 300m are treated as accidental watch starts/stops,
  // not real runs: their pace is meaningless and, landing in otherwise
  // quiet stretches, they can swing the Trend tab's 30-day averages
  // wildly (e.g. a 166m/3.4min entry once made the pace chart spike to
  // 20:00/km). sync_strava.py already skips these for future syncs; this
  // is a defense-in-depth filter in case any such entry ever ends up in
  // data/runs.json regardless of source (manual edit, other import, etc).
  const MIN_RUN_KM = 0.3;

  function filteredRuns() {
    return RUNS.filter(r => selectedYears.has(r.y) && r.km >= MIN_RUN_KM);
  }

  function fmtPace(s) {
    const total = Math.round(Number(s));
    if (!Number.isFinite(total)) return "—";
    const m = Math.floor(total / 60), sec = total % 60;
    return m + ":" + String(sec).padStart(2, "0");
  }
  function fmtKm(n) {
    return n.toLocaleString("en-IT", { maximumFractionDigits: 1 });
  }
  function fmtDate(d) {
    return d.toLocaleDateString("en-IT", { day: "numeric", month: "short", year: "numeric" });
  }

  function runDateToLocalTime(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(year, month - 1, day).getTime();
  }

  function groupByYear(runs) {
    const m = new Map();
    runs.forEach(r => {
      if (!m.has(r.y)) m.set(r.y, {km:0, min:0, n:0, hr:[], mhr:0, cad:[], hrz:[0,0,0,0,0]});
      const g = m.get(r.y);
      g.km += r.km; g.min += r.min; g.n += 1;
      if (r.hr) g.hr.push(r.hr);
      if (r.mhr) g.mhr = Math.max(g.mhr, r.mhr);
      if (r.cad) g.cad.push(r.cad);
      if (r.hrz) r.hrz.forEach((v,i) => g.hrz[i] += v);
    });
    return m;
  }

  async function fetchJson(url) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetch(url + separator + "v=" + Date.now(), {cache:"no-store"});
    if (!response.ok) throw new Error(`Unable to load ${url}: HTTP ${response.status}`);
    return response.json();
  }

  function destroyChart(id) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }

  // Used by js/theme.js after a theme toggle: existing Chart.js instances
  // baked in the old grid color at creation time, so the simplest correct
  // fix is to drop them all and let the next render (triggered by
  // markAllDirty + renderActiveTab) recreate them with getGridColor()'s
  // current value.
  function destroyAllCharts() {
    Object.keys(charts).forEach(destroyChart);
  }

  function upsertChart(canvasId, type, data, options) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const mergedOptions = Object.assign({ responsive:true, maintainAspectRatio:false }, options, {
      plugins: Object.assign({legend:{display:false}}, options.plugins)
    });
    if (charts[canvasId]) {
      charts[canvasId].data = data;
      charts[canvasId].options = mergedOptions;
      charts[canvasId].update();
    } else {
      charts[canvasId] = new Chart(canvas, { type, data, options: mergedOptions });
    }
  }

  window.RD = window.RD || {};
  window.RD.state = {
    getRuns: () => RUNS,
    setRuns: (v) => { RUNS = v; },
    getAllYears: () => ALL_YEARS,
    setAllYears: (v) => { ALL_YEARS = v; },
    getSelectedYears: () => selectedYears,
    setSelectedYears: (v) => { selectedYears = v; },
    YEAR_COLORS, WD_LABELS, HRZ_LABELS, HRZ_COLORS, getGridColor,
    dirty, markAllDirty, filteredRuns,
    fmtPace, fmtKm, fmtDate, runDateToLocalTime, groupByYear, fetchJson,
    upsertChart, destroyChart, destroyAllCharts,
  };
})();
