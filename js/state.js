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
  const HRZ_LABELS = ["Easy <130","Moderate 130-145","Steady 145-160","Hard 160-175","Maximum 175+"];
  const HRZ_COLORS = ["#60a5fa","#34d399","#fbbf24","#fb923c","#e34948"];

  const isDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const gridColor = isDark ? "#2c2c2a" : "#e1e0d9";
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

  function filteredRuns() {
    return RUNS.filter(r => selectedYears.has(r.y));
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
    YEAR_COLORS, WD_LABELS, HRZ_LABELS, HRZ_COLORS, gridColor,
    dirty, markAllDirty, filteredRuns,
    fmtPace, fmtKm, fmtDate, runDateToLocalTime, groupByYear, fetchJson,
    upsertChart, destroyChart,
  };
})();
