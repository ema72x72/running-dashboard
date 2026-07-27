// Weekdays tab: behavioural analysis of training patterns across the week
// (not just a historical km total, which is already covered by Yearly/
// Cumulative/Trend). A metric selector drives one reusable weekday bar
// chart; a "weekly pattern" panel turns the raw numbers into qualitative
// habits (long run day, recovery day, tempo day, most consistent day);
// adaptive KPI cards and a compact insight table give the numeric detail;
// a secondary "weekday volume" chart keeps the original total-km-by-day
// view available as supporting context.
(function () {
  const {
    filteredRuns, upsertChart, destroyChart, WD_LABELS,
    fmtKm, fmtPace, getGridColor, dirty,
  } = window.RD.state;

  // Below this, a nonzero km/min total is floating-point noise rather than
  // a real distance (same rationale as trend.js's ZERO_EPSILON: every run
  // is at least 0.3km per MIN_RUN_KM in state.js, so nothing under this
  // threshold can be a genuine value worth dividing by).
  const ZERO_EPSILON = 1e-6;

  let selectedMetric = "distance";

  /* ---------- Formatting helpers ---------- */
  function formatMinutes(min) {
    if (!Number.isFinite(min)) return "—";
    const totalMin = Math.round(min);
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  function formatSignedPercent(pct) {
    const rounded = Math.round(pct);
    if (rounded === 0) return "avg";
    return (rounded > 0 ? "+" : "−") + Math.abs(rounded) + "%";
  }

  /* ---------- Aggregation: one bucket per weekday (0=Mon..6=Sun) ---------- */
  function buildWeekdayAggregates(runs) {
    const agg = [];
    for (let i = 0; i < 7; i++) agg.push({ km: 0, min: 0, n: 0, hrSum: 0, hrN: 0, kmList: [] });
    const yearsSeen = new Set();
    runs.forEach(r => {
      const wd = r.wd;
      if (!Number.isFinite(wd) || wd < 0 || wd > 6) return;
      const a = agg[wd];
      a.km += r.km;
      a.min += r.min;
      a.n += 1;
      a.kmList.push(r.km);
      if (Number.isFinite(r.hr) && r.hr > 0) { a.hrSum += r.hr; a.hrN += 1; }
      if (Number.isFinite(r.y)) yearsSeen.add(r.y);
    });
    agg.forEach(a => {
      a.avgKm = a.n > 0 ? a.km / a.n : 0;
      a.avgPace = a.km > ZERO_EPSILON ? (a.min * 60) / a.km : null;
      a.avgHr = a.hrN > 0 ? a.hrSum / a.hrN : null;
      a.avgDuration = a.n > 0 ? a.min / a.n : 0;
      a.runsPerYear = yearsSeen.size > 0 ? a.n / yearsSeen.size : 0;
    });
    return { agg, yearsSpan: yearsSeen.size };
  }

  function computeOverall(agg) {
    const totalKm = agg.reduce((s, a) => s + a.km, 0);
    const totalMin = agg.reduce((s, a) => s + a.min, 0);
    const totalN = agg.reduce((s, a) => s + a.n, 0);
    const totalHrSum = agg.reduce((s, a) => s + a.hrSum, 0);
    const totalHrN = agg.reduce((s, a) => s + a.hrN, 0);
    return {
      avgKm: totalN > 0 ? totalKm / totalN : 0,
      avgPace: totalKm > ZERO_EPSILON ? (totalMin * 60) / totalKm : null,
      avgHr: totalHrN > 0 ? totalHrSum / totalHrN : null,
      avgRunsPerWeekday: totalN / 7,
      avgDuration: totalN > 0 ? totalMin / totalN : 0,
      totalN,
    };
  }

  /* ---------- Metric definitions driving the main chart ---------- */
  // Section 3-4 of the memo: one segmented control, one reusable chart.
  // "Runs" uses a plain total count per weekday (not a per-year average):
  // every weekday occurs almost exactly 1/7th of the time regardless of
  // calendar-year boundaries, so raw counts are already directly
  // comparable across weekdays without needing to normalise by year span.
  const METRICS = {
    distance: {
      label: "Distance", chartTitle: "Average distance per run (km)",
      getValue: a => a.avgKm, getOverall: o => o.avgKm,
      axisFormat: v => `${fmtKm(v)} km`,
      tooltip: a => [`${fmtKm(a.avgKm)} km avg per run`, `${a.n} runs · ${fmtKm(a.km)} km total`],
    },
    pace: {
      label: "Pace", chartTitle: "Distance-weighted average pace (min/km)",
      getValue: a => a.avgPace, getOverall: o => o.avgPace,
      axisFormat: v => fmtPace(v),
      tooltip: a => Number.isFinite(a.avgPace)
        ? [`${fmtPace(a.avgPace)} /km avg`, `${a.n} runs · ${fmtKm(a.km)} km`]
        : ["No valid pace data"],
    },
    hr: {
      label: "Heart Rate", chartTitle: "Average heart rate (bpm)",
      getValue: a => a.avgHr, getOverall: o => o.avgHr,
      axisFormat: v => `${Math.round(v)} bpm`,
      tooltip: a => Number.isFinite(a.avgHr)
        ? [`${Math.round(a.avgHr)} bpm avg`, `${a.hrN} of ${a.n} runs with HR data`]
        : ["No HR data"],
    },
    runs: {
      label: "Runs", chartTitle: "Total number of runs",
      getValue: a => a.n, getOverall: o => o.avgRunsPerWeekday,
      axisFormat: v => `${Math.round(v)}`,
      tooltip: a => [`${a.n} runs total`, `${fmtKm(a.runsPerYear)} runs/year avg`],
    },
    duration: {
      label: "Duration", chartTitle: "Average moving time per run",
      getValue: a => a.avgDuration, getOverall: o => o.avgDuration,
      axisFormat: v => formatMinutes(v),
      tooltip: a => [`${formatMinutes(a.avgDuration)} avg per run`, `${a.n} runs`],
    },
  };

  /* ---------- Custom plugin: %-vs-average label above each bar ---------- */
  // Chart.js core has no datalabels support without an extra plugin, and
  // this app deliberately loads no CDN scripts beyond Chart.js/Leaflet.
  // A tiny self-registered plugin achieves the same result: it reads an
  // array stashed on the canvas element right before each render and
  // draws it above the matching bar. It self-filters by canvas id so it
  // has no effect on any other chart in the app.
  const weekdayPctLabelsPlugin = {
    id: "weekdayPctLabels",
    afterDatasetsDraw(chart) {
      if (chart.canvas.id !== "chartWeekday") return;
      const labels = chart.canvas.__weekdayPctLabels;
      if (!labels) return;
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data) return;
      const ctx = chart.ctx;
      const color = getComputedStyle(document.documentElement).getPropertyValue("--text-secondary").trim() || "#52514e";
      ctx.save();
      ctx.font = "600 10px " + (getComputedStyle(document.body).fontFamily || "sans-serif");
      ctx.textAlign = "center";
      ctx.fillStyle = color;
      meta.data.forEach((bar, i) => {
        const label = labels[i];
        if (!label) return;
        ctx.fillText(label, bar.x, Math.max(bar.y - 6, 10));
      });
      ctx.restore();
    },
  };
  if (typeof Chart !== "undefined" && Chart.register) Chart.register(weekdayPctLabelsPlugin);

  function renderMainChart(agg, overall, metricKey) {
    const metric = METRICS[metricKey];
    const values = agg.map(a => metric.getValue(a));
    const overallValue = metric.getOverall(overall);
    const chartValues = values.map(v => Number.isFinite(v) ? v : 0);

    const pctLabels = values.map(v => {
      if (!Number.isFinite(v) || !Number.isFinite(overallValue) || Math.abs(overallValue) < ZERO_EPSILON) return "";
      return formatSignedPercent(((v - overallValue) / overallValue) * 100);
    });
    const canvas = document.getElementById("chartWeekday");
    if (canvas) canvas.__weekdayPctLabels = pctLabels;

    const datasets = [{
      type: "bar", label: metric.label, data: chartValues,
      backgroundColor: "#2a78d6", borderRadius: 4, maxBarThickness: 46, order: 2,
    }];
    if (Number.isFinite(overallValue)) {
      datasets.push({
        type: "line", label: "Average", data: new Array(7).fill(overallValue),
        borderColor: "rgba(137,135,129,0.65)", backgroundColor: "rgba(137,135,129,0.65)",
        borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false, order: 1,
      });
    }

    upsertChart("chartWeekday", "bar", { labels: WD_LABELS, datasets }, {
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: ctx => ctx.dataset.label !== "Average",
          callbacks: { label: ctx => metric.tooltip(agg[ctx.dataIndex]) },
        },
      },
      scales: {
        y: {
          beginAtZero: metricKey !== "hr" && metricKey !== "pace",
          grid: { color: getGridColor() },
          ticks: { callback: v => metric.axisFormat(v) },
        },
        x: { grid: { display: false } },
      },
    });
  }

  /* ---------- "Your weekly pattern" panel (section 5) ---------- */
  // Long run / Recovery / Tempo / Most consistent are qualitative labels,
  // not raw bests, so a weekday with only one or two runs shouldn't be
  // able to claim one just by chance (same spirit as the "reliable
  // points" guard on Trend's Best/Worst pace cards). Weekdays under this
  // threshold are excluded unless excluding them would leave nothing.
  function computeWeeklyPattern(agg, overall) {
    const withIdx = agg.map((a, i) => Object.assign({}, a, { wd: i }));
    const minRuns = Math.max(3, Math.round(overall.totalN * 0.03));
    const eligible = withIdx.filter(a => a.n >= minRuns);
    const pool = eligible.length ? eligible : withIdx.filter(a => a.n > 0);

    function pickMax(arr, key) { return arr.reduce((best, cur) => (!best || cur[key] > best[key]) ? cur : best, null); }
    function pickMin(arr, key) { return arr.reduce((best, cur) => (!best || cur[key] < best[key]) ? cur : best, null); }

    const longRunDay = pickMax(pool, "avgKm");
    const paceEligible = pool.filter(a => Number.isFinite(a.avgPace));
    const recoveryDay = pickMax(paceEligible, "avgPace"); // slowest pace = highest sec/km
    const tempoDay = pickMin(paceEligible, "avgPace"); // fastest pace = lowest sec/km

    const withCv = pool
      .filter(a => a.kmList.length >= 2)
      .map(a => {
        const mean = a.kmList.reduce((s, v) => s + v, 0) / a.kmList.length;
        const variance = a.kmList.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (a.kmList.length - 1);
        const cv = mean > ZERO_EPSILON ? Math.sqrt(variance) / mean : null;
        return Object.assign({}, a, { cv });
      })
      .filter(a => Number.isFinite(a.cv));
    const mostConsistent = pickMin(withCv, "cv");

    return { longRunDay, recoveryDay, tempoDay, mostConsistent, minRuns };
  }

  function renderPatternPanel(pattern) {
    const el = document.getElementById("weekdayPatternList");
    if (!el) return;
    const cards = [
      { icon: "🏃", label: "Long run day", item: pattern.longRunDay, sub: a => `${fmtKm(a.avgKm)} km avg` },
      { icon: "♥", label: "Recovery day", item: pattern.recoveryDay, sub: a => `${fmtPace(a.avgPace)} /km avg` },
      { icon: "⌁", label: "Tempo day", item: pattern.tempoDay, sub: a => `${fmtPace(a.avgPace)} /km avg` },
      { icon: "☆", label: "Most consistent", item: pattern.mostConsistent, sub: a => `±${Math.round(a.cv * 100)}% variability` },
    ];
    el.innerHTML = cards.map(c => `
      <div class="weekday-pattern-card">
        <div class="weekday-pattern-icon">${c.icon}</div>
        <p class="weekday-pattern-label">${c.label}</p>
        <p class="weekday-pattern-value">${c.item ? WD_LABELS[c.item.wd] : "—"}</p>
        <p class="weekday-pattern-sub">${c.item ? c.sub(c.item) : "Not enough data yet"}</p>
      </div>
    `).join("");
  }

  /* ---------- Adaptive KPI cards (section 6) ---------- */
  function computeKpiCards(agg, metricKey) {
    const withIdx = agg.map((a, i) => Object.assign({}, a, { wd: i }));
    const reliable = withIdx.filter(a => a.n >= 2);
    const frequencyEligible = withIdx.filter(a => a.n > 0);

    function pickMax(arr, key) { return arr.reduce((best, cur) => (!best || cur[key] > best[key]) ? cur : best, null); }
    function pickMin(arr, key) { return arr.reduce((best, cur) => (!best || cur[key] < best[key]) ? cur : best, null); }

    const distancePair = [
      { icon: "↗", label: "Longest average run", item: pickMax(reliable, "avgKm"), fmt: a => `${fmtKm(a.avgKm)} km` },
      { icon: "↘", label: "Shortest average run", item: pickMin(reliable, "avgKm"), fmt: a => `${fmtKm(a.avgKm)} km` },
    ];
    const frequencyPair = [
      { icon: "▣", label: "Most frequent weekday", item: pickMax(frequencyEligible, "n"), fmt: a => `${a.n} runs` },
      { icon: "◫", label: "Least frequent weekday", item: pickMin(frequencyEligible, "n"), fmt: a => `${a.n} runs` },
    ];

    let primary;
    if (metricKey === "pace") {
      const paceReliable = reliable.filter(a => Number.isFinite(a.avgPace));
      primary = [
        { icon: "☆", label: "Fastest weekday", item: pickMin(paceReliable, "avgPace"), fmt: a => `${fmtPace(a.avgPace)} /km` },
        { icon: "⚠", label: "Slowest weekday", item: pickMax(paceReliable, "avgPace"), fmt: a => `${fmtPace(a.avgPace)} /km` },
      ];
    } else if (metricKey === "hr") {
      const hrReliable = reliable.filter(a => Number.isFinite(a.avgHr));
      primary = [
        { icon: "☆", label: "Lowest avg HR", item: pickMin(hrReliable, "avgHr"), fmt: a => `${Math.round(a.avgHr)} bpm` },
        { icon: "⚠", label: "Highest avg HR", item: pickMax(hrReliable, "avgHr"), fmt: a => `${Math.round(a.avgHr)} bpm` },
      ];
    } else if (metricKey === "runs") {
      primary = frequencyPair;
    } else if (metricKey === "duration") {
      primary = [
        { icon: "↗", label: "Longest average duration", item: pickMax(reliable, "avgDuration"), fmt: a => formatMinutes(a.avgDuration) },
        { icon: "↘", label: "Shortest average duration", item: pickMin(reliable, "avgDuration"), fmt: a => formatMinutes(a.avgDuration) },
      ];
    } else {
      primary = distancePair;
    }

    // Second pair gives frequency context alongside whichever metric is
    // primary - except when Runs itself is selected, where frequency is
    // already the primary pair, so distance takes its place instead to
    // avoid two identical card pairs.
    const secondary = metricKey === "runs" ? distancePair : frequencyPair;
    return [...primary, ...secondary];
  }

  function renderKpiCards(cards) {
    const el = document.getElementById("weekdayStats");
    if (!el) return;
    el.innerHTML = cards.map(c => `
      <div class="weekday-stat-card">
        <div class="weekday-stat-icon">${c.icon}</div>
        <p class="weekday-stat-label">${c.label}</p>
        <p class="weekday-stat-value">${c.item ? WD_LABELS[c.item.wd] : "—"}</p>
        <p class="weekday-stat-sub">${c.item ? c.fmt(c.item) : ""}</p>
      </div>
    `).join("");
  }

  /* ---------- Insight table (section 7) ---------- */
  // Direction of "best": faster pace and lower HR are treated as better
  // (more efficient effort); more runs/year and more time on feet are
  // treated as better (more consistent training), matching how the rest
  // of the app already colours "more volume" positively. This is a
  // deliberate editorial choice, not something the memo specifies.
  function renderInsightTable(agg) {
    const el = document.getElementById("weekdayTable");
    if (!el) return;
    const withIdx = agg.map((a, i) => Object.assign({}, a, { wd: i }));

    function bestWorst(values, higherIsBetter) {
      const finite = values.filter(v => Number.isFinite(v.value));
      if (finite.length < 2) return { best: null, worst: null };
      const sorted = finite.slice().sort((a, b) => higherIsBetter ? b.value - a.value : a.value - b.value);
      return { best: sorted[0].wd, worst: sorted[sorted.length - 1].wd };
    }
    function cellClass(bw, wd) {
      if (bw.best === wd && bw.best !== bw.worst) return "best";
      if (bw.worst === wd) return "worst";
      return "";
    }

    const paceBW = bestWorst(withIdx.map(a => ({ wd: a.wd, value: a.avgPace })), false);
    const hrBW = bestWorst(withIdx.map(a => ({ wd: a.wd, value: a.avgHr })), false);
    const runsBW = bestWorst(withIdx.map(a => ({ wd: a.wd, value: a.n > 0 ? a.runsPerYear : null })), true);
    const durBW = bestWorst(withIdx.map(a => ({ wd: a.wd, value: a.n > 0 ? a.avgDuration : null })), true);

    const rows = withIdx.map(a => `
      <tr>
        <td>${WD_LABELS[a.wd]}</td>
        <td class="${cellClass(paceBW, a.wd)}">${Number.isFinite(a.avgPace) ? fmtPace(a.avgPace) + " /km" : "—"}</td>
        <td class="${cellClass(hrBW, a.wd)}">${Number.isFinite(a.avgHr) ? Math.round(a.avgHr) + " bpm" : "—"}</td>
        <td class="${cellClass(runsBW, a.wd)}">${a.n > 0 ? fmtKm(a.runsPerYear) : "—"}</td>
        <td class="${cellClass(durBW, a.wd)}">${a.n > 0 ? formatMinutes(a.avgDuration) : "—"}</td>
      </tr>
    `).join("");

    el.innerHTML = `
      <thead><tr><th>Day</th><th>Avg pace</th><th>Avg HR</th><th>Runs/yr</th><th>Avg duration</th></tr></thead>
      <tbody>${rows}</tbody>
    `;
  }

  /* ---------- Secondary "weekday volume" panel (from the mockup) ---------- */
  // Not one of the memo's five numbered sections, but present in the
  // supplied visual mockup as a supporting, non-interactive view; kept as
  // a secondary chart rather than mixed into the metric selector so the
  // "one interactive chart" principle (section 8) still applies to the
  // main chart above.
  function renderVolumeChart(agg) {
    const totals = agg.map(a => Math.round(a.km * 10) / 10);
    upsertChart("chartWeekdayVolume", "bar", {
      labels: WD_LABELS,
      datasets: [{ label: "Total km", data: totals, backgroundColor: "#2a78d6", borderRadius: 4, maxBarThickness: 22 }],
    }, {
      indexAxis: "y",
      plugins: { tooltip: { callbacks: { label: ctx => `${fmtKm(ctx.parsed.x)} km · ${agg[ctx.dataIndex].n} runs` } } },
      scales: {
        x: { beginAtZero: true, grid: { color: getGridColor() }, ticks: { callback: v => `${v} km` } },
        y: { grid: { display: false } },
      },
    });
  }

  /* ---------- Wiring ---------- */
  function setMetricChipsActive() {
    document.querySelectorAll("#weekdayMetricRow .chip").forEach(el => {
      el.classList.toggle("active", el.dataset.metric === selectedMetric);
    });
  }

  function renderSettimana() {
    setMetricChipsActive();
    const runs = filteredRuns();
    const emptyEl = document.getElementById("weekdayEmpty");
    const contentEls = document.querySelectorAll(".weekday-content");

    if (!runs.length) {
      if (emptyEl) emptyEl.style.display = "block";
      contentEls.forEach(el => { el.style.display = "none"; });
      destroyChart("chartWeekday");
      destroyChart("chartWeekdayVolume");
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    contentEls.forEach(el => { el.style.display = ""; });

    const { agg } = buildWeekdayAggregates(runs);
    const overall = computeOverall(agg);
    const metric = METRICS[selectedMetric];

    const titleEl = document.getElementById("weekdayChartTitle");
    if (titleEl) titleEl.textContent = metric.chartTitle;

    renderMainChart(agg, overall, selectedMetric);
    renderPatternPanel(computeWeeklyPattern(agg, overall));
    renderKpiCards(computeKpiCards(agg, selectedMetric));
    renderInsightTable(agg);
    renderVolumeChart(agg);
  }

  document.querySelectorAll("#weekdayMetricRow .chip").forEach(el => {
    el.addEventListener("click", () => {
      selectedMetric = el.dataset.metric;
      dirty.settimana = true;
      renderSettimana();
    });
  });

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.settimana = { render: renderSettimana };
})();
