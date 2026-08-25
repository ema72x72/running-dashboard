// Overview tab: current-status strip, KPI cards, comparison with the
// previous period, and a season-goal card. "Current status" and the
// comparison/season-goal blocks intentionally use getRuns() (unfiltered)
// rather than filteredRuns(): they describe where things actually stand
// right now, independently of whatever years the user has selected for
// the rest of the dashboard - the KPI cards above them already show the
// filtered totals, so this keeps a clear, existing convention (the
// comparison panel already says so explicitly) rather than introducing
// two different meanings of "now" on the same page.
(function () {
  const { filteredRuns, getRuns, fmtPace, fmtKm, fmtDate, runDateToLocalTime, upsertChart } = window.RD.state;

  const DAY = 86400000;

  function startOfLocalDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  function isPaceValidRun(r) {
    if (!(r.km > 0) || !(r.min > 0)) return false;
    const seconds = (r.min * 60) / r.km;
    return seconds >= 150 && seconds <= 900;
  }
  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }
  function statsInRange(runs, start, end) {
    const rs = runs.filter(r => { const t = runDateToLocalTime(r.d); return t >= start && t < end; });
    return { km: rs.reduce((s, r) => s + r.km, 0), count: rs.length };
  }
  function paceInRange(runs, start, end) {
    const rs = runs.filter(r => { const t = runDateToLocalTime(r.d); return t >= start && t < end && isPaceValidRun(r); });
    const km = rs.reduce((s, r) => s + r.km, 0);
    const min = rs.reduce((s, r) => s + r.min, 0);
    return km > 0 ? (min * 60) / km : null;
  }

  function renderTotali() {
    renderCurrentStatus();

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

      // "+X in <year>" only makes sense as a breakdown when the current
      // selection actually spans more than one year - otherwise it would
      // just restate the total above it.
      const yearsInSelection = new Set(runs.map(r => r.y));
      const latestYear = Math.max(...yearsInSelection);
      const showYearBreakdown = yearsInSelection.size >= 2;
      const yearRuns = runs.filter(r => r.y === latestYear);
      const yearKm = yearRuns.reduce((s,r) => s + r.km, 0);
      const yearMin = yearRuns.reduce((s,r) => s + r.min, 0);

      const allRuns = getRuns();
      const todayStart = startOfLocalDay();
      const w90Start = todayStart - 89 * DAY;
      const w90Runs = allRuns.filter(r => { const t = runDateToLocalTime(r.d); return t >= w90Start && t < todayStart + DAY; });
      const w90Pace = paceInRange(allRuns, w90Start, todayStart + DAY);
      const w90HrRuns = w90Runs.filter(r => Number.isFinite(r.hr) && r.hr > 0);
      const w90Hr = w90HrRuns.length ? w90HrRuns.reduce((s,r) => s + r.hr, 0) / w90HrRuns.length : null;

      const cards = [
        {cls:"kpi-blue", icon:"▥", value:Math.round(km).toLocaleString("en-IT"), unit:"km", label:"Total",
          sub: showYearBreakdown ? `+${fmtKm(yearKm)} km in ${latestYear}` : ""},
        {cls:"kpi-green", icon:"◷", value:Math.round(min/60).toLocaleString("en-IT"), unit:"h", label:"Total time",
          sub: showYearBreakdown ? `+${Math.round(yearMin/60).toLocaleString("en-IT")} h in ${latestYear}` : ""},
        {cls:"kpi-purple", icon:"⌁", value:runs.length.toLocaleString("en-IT"), unit:"runs", label:"Total",
          sub: showYearBreakdown ? `+${yearRuns.length.toLocaleString("en-IT")} runs in ${latestYear}` : ""},
        {cls:"kpi-amber secondary", icon:"◴", value:fmtPace(avgPaceSec), unit:"/km", label:"Average pace",
          sub: w90Pace !== null ? `${fmtPace(w90Pace)} /km last 90 days` : ""},
        {cls:"kpi-red secondary", icon:"♥", value:avgHr ? Math.round(avgHr).toLocaleString("en-IT") : "—", unit:avgHr ? "bpm" : "", label:"Average HR",
          sub: w90Hr !== null ? `${Math.round(w90Hr)} bpm last 90 days` : ""},
        {cls:"kpi-cyan secondary", icon:"≈", value:longest.km.toLocaleString("en-IT", {minimumFractionDigits:2, maximumFractionDigits:2}), unit:"km", label:"Longest run",
          sub: fmtDate(new Date(runDateToLocalTime(longest.d)))},
      ];
      grid.innerHTML = cards.map(c => `
        <div class="kpicard ${c.cls}">
          <div class="kpiicon" aria-hidden="true">${c.icon}</div>
          <p class="value">${c.value}</p>
          <p class="unit">${c.unit}</p>
          <p class="label">${c.label}</p>
          ${c.sub ? `<p class="kpi-sub">${c.sub}</p>` : ""}
        </div>`).join("");
      foot.textContent = "";
    }
    renderComparisonTable();
    renderSeasonGoal();
  }

  /* ---------- Current status ---------- */
  function relativeDayLabel(dateString) {
    const t = runDateToLocalTime(dateString);
    const diffDays = Math.round((startOfLocalDay() - t) / DAY);
    if (diffDays === 0) return "today";
    if (diffDays === 1) return "yesterday";
    return fmtDate(new Date(t));
  }
  function statusItemHtml({icon, color, eyebrow, value, note}) {
    return `
      <div class="status-item">
        <div class="status-icon ${color}" aria-hidden="true">${icon}</div>
        <div class="status-body">
          <p class="status-eyebrow ${color}">${eyebrow}</p>
          <p class="status-value">${value}</p>
          <p class="status-note">${note}</p>
        </div>
      </div>
    `;
  }

  function renderCurrentStatus() {
    const panel = document.getElementById("statusPanel");
    const row = document.getElementById("statusRow");
    if (!panel || !row) return;
    const runs = getRuns();
    if (!runs.length) { panel.style.display = "none"; return; }
    panel.style.display = "";

    const sorted = runs.slice().sort((a,b) => a.d.localeCompare(b.d));
    const last = sorted[sorted.length - 1];
    const lastLocation = last.location_city || (last.location_country || "");

    const todayStart = startOfLocalDay();
    const weekStart = todayStart - 6 * DAY;
    const weekStats = statsInRange(runs, weekStart, todayStart + DAY);

    // "Current trend" compares a 90-day window against the previous
    // 90-day window - the same idea used in the Trend tab, at its default
    // window length, kept here as a quick one-line summary.
    // "Current trend" compares the last 90 days against the trailing
    // 365-day average rather than the previous 90-day period: a
    // period-over-period comparison can say "falling" right after an
    // unusually strong quarter even while you're still running well above
    // your normal recent pace, which reads as a contradiction. Comparing
    // against your own trailing-year average answers the question people
    // actually mean by "trend": am I running more or less than usual.
    const windowDays = 90;
    const curStart = todayStart - (windowDays - 1) * DAY;
    const baselineStart = todayStart - 364 * DAY;
    const curVol = statsInRange(runs, curStart, todayStart + DAY).km;
    const baselineVol = statsInRange(runs, baselineStart, todayStart + DAY).km;
    const curRate = curVol / (windowDays / 7);
    const baselineRate = baselineVol / (365 / 7);
    let volumeLabel = "Volume stable";
    if (baselineRate > 0) {
      const pct = ((curRate - baselineRate) / baselineRate) * 100;
      if (pct >= 10) volumeLabel = "Volume rising";
      else if (pct <= -10) volumeLabel = "Volume falling";
    } else if (curRate > 0) {
      volumeLabel = "Volume rising";
    }

    const curPace = paceInRange(runs, curStart, todayStart + DAY);
    const baselinePace = paceInRange(runs, baselineStart, todayStart + DAY);
    let paceLabel = "Pace stable";
    if (curPace !== null && baselinePace !== null) {
      const delta = curPace - baselinePace;
      if (delta <= -5) paceLabel = "Pace improving";
      else if (delta >= 5) paceLabel = "Pace declining";
    }

    row.innerHTML = [
      statusItemHtml({
        icon: "👟", color: "blue", eyebrow: "Last run",
        value: `${last.km.toLocaleString("en-IT", {minimumFractionDigits:1, maximumFractionDigits:1})} km`,
        note: [lastLocation, relativeDayLabel(last.d)].filter(Boolean).join(" • ")
      }),
      statusItemHtml({
        icon: "📅", color: "green", eyebrow: "This week",
        value: `${weekStats.count} run${weekStats.count === 1 ? "" : "s"}`,
        note: `${fmtKm(weekStats.km)} km`
      }),
      statusItemHtml({
        icon: "↗", color: "purple", eyebrow: "Current trend",
        value: volumeLabel, note: paceLabel
      })
    ].join("");
  }

  /* ---------- Comparison with the previous period ---------- */
  function renderComparisonTable() {
    const todayStart = startOfLocalDay();
    const tomorrowStart = todayStart + DAY;
    const periods = [
      {label:"Last 7 days", days:7},
      {label:"Last 30 days", days:30},
      {label:"Last 90 days", days:90},
      {label:"Last year", days:365},
    ];
    const allRuns = getRuns();
    const body = document.getElementById("cmpBody");
    body.innerHTML = periods.map(p => {
      // Includes today and exactly p.days - 1 preceding calendar dates.
      const curStart = todayStart - (p.days - 1) * DAY;
      const prevStart = curStart - p.days * DAY;
      const cur = statsInRange(allRuns, curStart, tomorrowStart);
      const prev = statsInRange(allRuns, prevStart, curStart);
      let deltaTxt, deltaClass, arrow;
      if (prev.km > 0) {
        const pct = ((cur.km - prev.km) / prev.km) * 100;
        deltaTxt = (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%";
        deltaClass = pct >= 0 ? "delta-pos" : "delta-neg";
        arrow = pct >= 0 ? "▲" : "▼";
      } else if (cur.km > 0) {
        deltaTxt = "new"; deltaClass = "delta-pos"; arrow = "▲";
      } else {
        deltaTxt = "—"; deltaClass = ""; arrow = "";
      }
      // Km/run reads better for short windows with a handful of runs;
      // runs/week is more meaningful once the window spans months.
      const metaTxt = p.days > 90
        ? `${cur.count} runs · ${(cur.count / (p.days / 7)).toLocaleString("en-IT", {maximumFractionDigits:1})} runs/week`
        : `${cur.count} runs${cur.count ? ` · ${fmtKm(cur.km / cur.count)} km/run` : ""}`;
      return `<div class="compare-card">
        <p class="compare-label">${p.label}</p>
        <p class="compare-value">${fmtKm(cur.km)} km</p>
        <p class="compare-delta ${deltaClass}">${arrow} ${deltaTxt}</p>
        <p class="compare-vs">vs previous</p>
        <p class="compare-meta">${metaTxt}</p>
      </div>`;
    }).join("");
  }

  /* ---------- Season goal ---------- */
  function buildDoyCumulative(yearRuns) {
    const daily = new Array(367).fill(0);
    const sorted = yearRuns.slice().sort((a,b) => Number(a.doy) - Number(b.doy));
    let total = 0, idx = 0;
    for (let day = 1; day <= 366; day++) {
      while (idx < sorted.length && Number(sorted[idx].doy) <= day) { total += Number(sorted[idx].km) || 0; idx++; }
      daily[day] = Math.round(total * 10) / 10;
    }
    return daily;
  }

  function renderSeasonGoal() {
    const card = document.getElementById("seasonGoalCard");
    if (!card) return;
    const allRuns = getRuns();
    const years = [...new Set(allRuns.map(r => r.y))];
    const currentYear = years.length ? Math.max(...years) : null;
    const otherYears = years.filter(y => y !== currentYear);
    if (currentYear === null || !otherYears.length) { card.style.display = "none"; return; }
    card.style.display = "";

    const byYear = new Map();
    years.forEach(y => byYear.set(y, []));
    allRuns.forEach(r => { if (byYear.has(r.y)) byYear.get(r.y).push(r); });

    const currentYearRuns = byYear.get(currentYear);
    const currentDaily = buildDoyCumulative(currentYearRuns);
    const lastDoy = currentYearRuns.length ? Math.max(...currentYearRuns.map(r => Number(r.doy) || 0)) : 0;
    const currentKm = currentDaily[lastDoy] || 0;

    let bestYear = otherYears[0];
    const finalByYear = new Map();
    const dailyByOtherYear = new Map();
    otherYears.forEach(y => {
      const daily = buildDoyCumulative(byYear.get(y));
      dailyByOtherYear.set(y, daily);
      finalByYear.set(y, daily[366]);
    });
    otherYears.forEach(y => { if (finalByYear.get(y) > finalByYear.get(bestYear)) bestYear = y; });
    const bestKm = finalByYear.get(bestYear);
    const bestDaily = dailyByOtherYear.get(bestYear);

    // Two different comparisons on purpose: the headline is "at the same
    // point in the year" (apples to apples, like the Cumulative tab's own
    // "vs best year" card), while the km/week figure is always about
    // catching the best year's eventual FULL total by year-end, which is
    // what "beat your best year" as a season-long goal actually means.
    const bestKmSameDate = bestDaily[Math.min(lastDoy, 366)];
    const distanceSameDate = bestKmSameDate - currentKm;
    const distanceToRecord = bestKm - currentKm;
    const daysInYear = isLeapYear(currentYear) ? 366 : 365;
    const remainingWeeks = Math.max(0, daysInYear - lastDoy) / 7;

    const titleEl = document.getElementById("seasonGoalTitle");
    const subtitleEl = document.getElementById("seasonGoalSubtitle");
    const metricValueEl = document.getElementById("seasonGoalMetricValue");
    const metricLabelEl = document.getElementById("seasonGoalMetricLabel");
    const paceValueEl = document.getElementById("seasonGoalPaceValue");
    const paceLabelEl = document.getElementById("seasonGoalPaceLabel");
    const legendEl = document.getElementById("seasonGoalLegend");

    if (distanceToRecord <= 0) {
      titleEl.textContent = "New yearly record";
      subtitleEl.textContent = `You've already beaten ${bestYear}`;
      metricValueEl.textContent = `+${fmtKm(Math.abs(distanceToRecord))} km`;
      metricLabelEl.textContent = `ahead of your best year`;
      paceValueEl.textContent = "🎉";
      paceLabelEl.textContent = "keep it up";
    } else {
      titleEl.textContent = "Season goal";
      subtitleEl.textContent = "Beat your best year";
      metricValueEl.textContent = distanceSameDate <= 0
        ? `+${fmtKm(Math.abs(distanceSameDate))} km`
        : `${fmtKm(distanceSameDate)} km`;
      metricLabelEl.textContent = distanceSameDate <= 0
        ? `ahead of ${bestYear}'s pace`
        : `behind ${bestYear}'s pace`;
      const perWeek = remainingWeeks > 0 ? distanceToRecord / remainingWeeks : null;
      paceValueEl.textContent = perWeek !== null ? `~${perWeek.toLocaleString("en-IT", {maximumFractionDigits:0})} km/week` : "—";
      paceLabelEl.textContent = `to beat ${bestYear}`;
    }

    legendEl.innerHTML = `
      <div class="season-legend-row"><span class="season-legend-dot" style="background:#34d399"></span>${currentYear}<span class="season-legend-value">${fmtKm(currentKm)} km</span></div>
      <div class="season-legend-row"><span class="season-legend-dot" style="background:#89877199"></span>Best (${bestYear}, same date)<span class="season-legend-value">${fmtKm(bestKmSameDate)} km</span></div>
    `;

    const currentPoints = [];
    for (let day = 1; day <= Math.max(lastDoy, 1); day++) currentPoints.push({x: day, y: currentDaily[day]});
    const bestPoints = [];
    for (let day = 1; day <= 366; day++) bestPoints.push({x: day, y: bestDaily[day]});

    upsertChart("seasonGoalSparkline", "line", {
      datasets: [
        {label: String(bestYear), data: bestPoints, borderColor:"rgba(137,135,129,0.55)", backgroundColor:"transparent", borderWidth:1.5, borderDash:[3,3], pointRadius:0, tension:0.2},
        {label: String(currentYear), data: currentPoints, borderColor:"#34d399", backgroundColor:"transparent", borderWidth:2, pointRadius:0, tension:0.2}
      ]
    }, {
      animation: false,
      interaction: {intersect:false},
      plugins: {legend:{display:false}, tooltip:{enabled:false}},
      scales: {
        x: {type:"linear", min:1, max:366, display:false},
        y: {display:false}
      }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.totali = { render: renderTotali };
})();
