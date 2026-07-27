// Overview tab: KPI cards + comparison with the previous period.
(function () {
  const { filteredRuns, fmtPace, fmtKm, getRuns, runDateToLocalTime } = window.RD.state;

  function renderTotali() {
    const runs = filteredRuns();
    const grid = document.getElementById("kpiGrid");
    const foot = document.getElementById("kpiFoot");
    if (runs.length === 0) {
      grid.innerHTML = "";
      foot.innerHTML = '<span class="empty" style="display:block;">No year selected</span>';
    } else {
      const km = runs.reduce((s,r) => s + r.km, 0);
      const min = runs.reduce((s,r) => s + r.min, 0);
      const hrRuns = runs.filter(r => Number.isFinite(r.hr) && r.hr > 0);
      const avgHr = hrRuns.length ? hrRuns.reduce((s,r) => s + r.hr, 0) / hrRuns.length : null;
      const avgPaceSec = km > 0 ? (min*60) / km : 0;
      const longest = runs.reduce((a,b) => b.km > a.km ? b : a, runs[0]);

      const cards = [
        {cls:"kpi-blue", icon:"▥", value:Math.round(km).toLocaleString("en-IT"), unit:"km", label:"Total"},
        {cls:"kpi-green", icon:"◷", value:Math.round(min/60).toLocaleString("en-IT"), unit:"h", label:"Total time"},
        {cls:"kpi-purple", icon:"⌁", value:runs.length.toLocaleString("en-IT"), unit:"runs", label:"Total"},
        {cls:"kpi-amber secondary", icon:"◴", value:fmtPace(avgPaceSec), unit:"/km", label:"Average pace"},
        {cls:"kpi-red secondary", icon:"♥", value:avgHr ? Math.round(avgHr).toLocaleString("en-IT") : "—", unit:avgHr ? "bpm" : "", label:"Average HR"},
        {cls:"kpi-cyan secondary", icon:"≈", value:longest.km.toLocaleString("en-IT", {minimumFractionDigits:2, maximumFractionDigits:2}), unit:"km", label:"Longest run"},
      ];
      grid.innerHTML = cards.map(c => `
        <div class="kpicard ${c.cls}">
          <div class="kpiicon" aria-hidden="true">${c.icon}</div>
          <p class="value">${c.value}</p>
          <p class="unit">${c.unit}</p>
          <p class="label">${c.label}</p>
        </div>`).join("");
      foot.textContent = "";
    }
    renderComparisonTable();
  }

  function startOfLocalDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  function sumKmInRange(start, end) {
    return getRuns().filter(r => {
      const t = runDateToLocalTime(r.d);
      return t >= start && t < end;
    }).reduce((s,r) => s + r.km, 0);
  }

  function renderComparisonTable() {
    const DAY = 86400000;
    const todayStart = startOfLocalDay();
    const tomorrowStart = todayStart + DAY;
    const periods = [
      {label:"Last 7 days", days:7},
      {label:"Last 30 days", days:30},
      {label:"Last 90 days", days:90},
      {label:"Last year", days:365},
    ];
    const body = document.getElementById("cmpBody");
    body.innerHTML = periods.map(p => {
      // Includes today and exactly p.days - 1 preceding calendar dates.
      const curStart = todayStart - (p.days - 1) * DAY;
      const prevStart = curStart - p.days * DAY;
      const cur = sumKmInRange(curStart, tomorrowStart);
      const prev = sumKmInRange(prevStart, curStart);
      let deltaTxt, deltaClass, arrow;
      if (prev > 0) {
        const pct = ((cur - prev) / prev) * 100;
        deltaTxt = (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%";
        deltaClass = pct >= 0 ? "delta-pos" : "delta-neg";
        arrow = pct >= 0 ? "▲" : "▼";
      } else if (cur > 0) {
        deltaTxt = "new"; deltaClass = "delta-pos"; arrow = "▲";
      } else {
        deltaTxt = "—"; deltaClass = ""; arrow = "";
      }
      return `<div class="compare-card">
        <p class="compare-label">${p.label}</p>
        <p class="compare-value">${fmtKm(cur)} km</p>
        <p class="compare-delta ${deltaClass}">${arrow} ${deltaTxt}</p>
        <p class="compare-vs">vs previous</p>
      </div>`;
    }).join("");
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.totali = { render: renderTotali };
})();
