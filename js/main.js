// Composition root: wires up tab navigation, the year filter, data loading
// from Strava's synced JSON, and the pull-to-refresh gesture. Each tab's
// own rendering logic lives in js/tabs/*.js (loaded before this file).
(function () {
  const {
    getRuns, setRuns,
    getAllYears, setAllYears,
    getSelectedYears, setSelectedYears,
    dirty, markAllDirty, fetchJson, filteredRuns,
  } = window.RD.state;

  const tabs = window.RD.tabs;
  let activeTab = "totali";

  const RENDERERS = {
    totali: tabs.totali.render,
    runs: tabs.runs.render,
    annuale: tabs.annuale.render,
    trend: tabs.trend.render,
    cumulata: tabs.cumulata.render,
    passofc: tabs.passofc.render,
    efficienza: tabs.efficienza.render,
    settimana: tabs.settimana.render,
    mappa: tabs.mappa.render,
  };

  function renderActiveTab() {
    if (!dirty[activeTab]) return;
    RENDERERS[activeTab]();
    dirty[activeTab] = false;
  }

  // Exposed so js/theme.js can force a re-render of whichever tab is
  // currently visible right after a theme toggle (paired with
  // markAllDirty() + destroyAllCharts(), so the other tabs pick up the
  // new grid color lazily whenever the user switches to them).
  window.RD.renderActiveTab = renderActiveTab;

  // ---------- Year filter UI ----------
  const yearRow = document.getElementById("yearRow");
  let allChip = null;
  let yearChips = {};

  function createYearChip(y) {
    const chip = document.createElement("div");
    chip.className = "chip active";
    chip.textContent = y;
    chip.onclick = () => {
      const selectedYears = getSelectedYears();
      if (selectedYears.has(y)) selectedYears.delete(y); else selectedYears.add(y);
      refreshYearChips();
      markAllDirty();
      renderActiveTab();
    };
    yearChips[y] = chip;
    yearRow.appendChild(chip);
  }

  let olderYearsExpanded = false;
  let olderYearsChip = null;

  function rebuildYearChips() {
    yearRow.innerHTML = "";
    yearChips = {};
    olderYearsChip = null;

    allChip = document.createElement("div");
    allChip.className = "chip all active";
    allChip.textContent = "All";
    allChip.onclick = () => {
      const allYears = getAllYears();
      if (getSelectedYears().size === allYears.length) { getSelectedYears().clear(); }
      else { setSelectedYears(new Set(allYears)); }
      refreshYearChips();
      markAllDirty();
      renderActiveTab();
    };
    yearRow.appendChild(allChip);

    const allYears = getAllYears();
    const recentYears = allYears.slice(0, 5);
    const olderYears = allYears.slice(5);

    recentYears.forEach(createYearChip);

    if (olderYears.length) {
      olderYearsChip = document.createElement("div");
      olderYearsChip.className = "chip";
      olderYearsChip.textContent = olderYearsExpanded ? "Hide earlier years" : "Earlier years";
      olderYearsChip.onclick = () => {
        olderYearsExpanded = !olderYearsExpanded;
        rebuildYearChips();
      };
      yearRow.appendChild(olderYearsChip);

      if (olderYearsExpanded) {
        olderYears.forEach(createYearChip);
      }
    }

    refreshYearChips();
  }

  function refreshYearChips() {
    const allYears = getAllYears();
    const selectedYears = getSelectedYears();
    allYears.forEach(y => yearChips[y] && yearChips[y].classList.toggle("active", selectedYears.has(y)));
    if (allChip) allChip.classList.toggle("active", selectedYears.size === allYears.length);
    updatePeriodIndicator();
  }

  // Small header line summarising the current year filter, e.g.
  // "All selected years • May 2014 – Jul 2026". The year label reflects the
  // selection itself; the date range reflects the actual first/last run
  // dates within that selection (not just the calendar years).
  function updatePeriodIndicator() {
    const el = document.getElementById("periodIndicator");
    if (!el) return;
    const allYears = getAllYears();
    const selectedYears = getSelectedYears();

    let label;
    if (!allYears.length) {
      label = "";
    } else if (selectedYears.size === allYears.length) {
      label = "All selected years";
    } else if (selectedYears.size === 1) {
      label = String([...selectedYears][0]);
    } else if (selectedYears.size === 0) {
      label = "No years selected";
    } else {
      label = `${selectedYears.size} years selected`;
    }

    const runs = filteredRuns();
    if (!runs.length) {
      el.textContent = label;
      return;
    }
    const dates = runs.map(r => r.d).sort();
    const monthYear = d => new Date(d + "T00:00:00Z").toLocaleDateString("en-IT", { month: "short", year: "numeric", timeZone: "UTC" });
    el.textContent = label ? `${label} • ${monthYear(dates[0])} – ${monthYear(dates[dates.length - 1])}` : "";
  }

  // ---------- Tabs ----------
  // Factored out of the click handler so other tabs can switch the
  // active tab programmatically (e.g. the Map tab's "Open run details"
  // action jumping into the Runs tab with a specific run selected).
  function activateTab(tabKey) {
    const targetTabEl = document.querySelector(`.tab[data-tab="${tabKey}"]`);
    const targetPanelEl = document.getElementById("tab-" + tabKey);
    if (!targetTabEl || !targetPanelEl) return;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tabpanel").forEach(p => p.classList.remove("active"));
    targetTabEl.classList.add("active");
    targetPanelEl.classList.add("active");
    activeTab = tabKey;
    renderActiveTab();
    if (activeTab === "mappa" && tabs.mappa.getLeafletMap()) setTimeout(() => tabs.mappa.getLeafletMap().invalidateSize(), 50);
    if (activeTab === "runs" && tabs.runs.getRunDetailMap()) setTimeout(() => tabs.runs.getRunDetailMap().invalidateSize(), 50);
  }
  window.RD.activateTab = activateTab;

  document.querySelectorAll(".tab").forEach(el => {
    el.addEventListener("click", () => activateTab(el.dataset.tab));
  });

  // ---------- Data loading, metadata and GitHub sync ----------
  const RUNS_DATA_URL = "./data/runs.json";
  const METADATA_URL = "./data/metadata.json";
  const GITHUB_WORKFLOW_URL = "https://github.com/ema72x72/running-dashboard/actions/workflows/sync-strava.yml";

  async function loadDashboardData() {
    const [runs, metadata] = await Promise.all([
      fetchJson(RUNS_DATA_URL),
      fetchJson(METADATA_URL).catch(() => null)
    ]);
    if (!Array.isArray(runs)) throw new Error("data/runs.json does not contain a valid JSON array");
    return {runs, metadata};
  }

  function openGitHubWorkflow() {
    window.open(GITHUB_WORKFLOW_URL, "_blank", "noopener,noreferrer");
  }

  function formatLastUpdate(value) {
    if (!value) return "Last sync unavailable";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Last sync unavailable";
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const wasYesterday = date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate();
    const time = new Intl.DateTimeFormat("en-IT", {hour:"2-digit", minute:"2-digit"}).format(date);
    if (sameDay) return `Last sync • today ${time}`;
    if (wasYesterday) return `Last sync • yesterday ${time}`;
    const day = new Intl.DateTimeFormat("en-IT", {day:"numeric", month:"short"}).format(date).replace(".", "");
    return `Last sync • ${day} ${time}`;
  }

  let dashboardLoading = false;
  async function refreshDashboardData({pull=false} = {}) {
    if (dashboardLoading) return;
    dashboardLoading = true;
    const status = document.getElementById("stravaStatus");
    const dot = document.getElementById("syncDot");
    const button = document.getElementById("stravaBtn");
    const label = document.getElementById("stravaBtnLabel");
    const spinner = document.getElementById("stravaSpin");
    const refreshIcon = document.getElementById("refreshIcon");

    button.disabled = true;
    spinner.classList.add("show");
    refreshIcon.style.display = "none";
    label.textContent = pull ? "Refreshing" : "Loading";
    status.textContent = pull ? "Refreshing data…" : "Loading data…";
    dot.className = "syncdot loading";

    try {
      const loaded = await loadDashboardData();
      setRuns(loaded.runs);
      const allYears = [...new Set(getRuns().map(run => run.y).filter(Number.isFinite))].sort((a,b)=>b-a);
      setAllYears(allYears);
      if (!getSelectedYears().size || [...getSelectedYears()].some(y => !allYears.includes(y))) setSelectedYears(new Set(allYears));

      rebuildYearChips();
      markAllDirty();
      renderActiveTab();

      status.textContent = formatLastUpdate(loaded.metadata && loaded.metadata.last_sync);
      dot.className = "syncdot";
      label.textContent = "Update";
    } catch (error) {
      console.error(error);
      status.textContent = "Data unavailable";
      dot.className = "syncdot error";
      label.textContent = "Retry";
    } finally {
      button.disabled = false;
      spinner.classList.remove("show");
      refreshIcon.style.display = "inline";
      dashboardLoading = false;
    }
  }

  // Pull to refresh: reloads runs.json and metadata.json without leaving the app.
  const pullIndicator = document.getElementById("pullIndicator");
  const pullText = document.getElementById("pullText");
  let pullStartY = null;
  let pullDistance = 0;
  let pullTracking = false;

  window.addEventListener("touchstart", event => {
    if (window.scrollY <= 0 && event.touches.length === 1 && !dashboardLoading) {
      pullStartY = event.touches[0].clientY;
      pullDistance = 0;
      pullTracking = true;
    }
  }, {passive:true});

  window.addEventListener("touchmove", event => {
    if (!pullTracking || pullStartY === null) return;
    const delta = Math.max(0, event.touches[0].clientY - pullStartY);
    pullDistance = Math.min(100, delta * 0.55);
    if (pullDistance > 6) {
      pullIndicator.classList.add("visible");
      pullIndicator.style.transform = `translate(-50%, ${Math.min(58, pullDistance)}px)`;
      pullText.textContent = pullDistance >= 54 ? "Release to refresh" : "Pull to refresh";
    }
  }, {passive:true});

  window.addEventListener("touchend", async () => {
    if (!pullTracking) return;
    const shouldRefresh = pullDistance >= 54;
    pullTracking = false;
    pullStartY = null;
    if (shouldRefresh) {
      pullText.textContent = "Refreshing…";
      pullIndicator.classList.add("refreshing");
      await refreshDashboardData({pull:true});
    }
    pullIndicator.classList.remove("visible", "refreshing");
    pullIndicator.style.transform = "translate(-50%, -46px)";
    pullDistance = 0;
  }, {passive:true});

  document.getElementById("stravaBtn").addEventListener("click", openGitHubWorkflow);
  refreshDashboardData();
})();
