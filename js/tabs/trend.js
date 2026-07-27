// Trend tab: smoothed weekly volume and distance-weighted pace, with a
// selectable smoothing window (30 days / 3 months / 1 year) and
// contextual comparison cards for each chart.
(function () {
  const { filteredRuns, upsertChart, fmtPace, fmtKm, fmtDate, getGridColor, dirty } = window.RD.state;

  const EPOCH = new Date("2014-01-01T00:00:00Z").getTime();
  const DAY = 86400000;
  function toDayIdx(dateStr) { return Math.round((new Date(dateStr + "T00:00:00Z").getTime() - EPOCH) / DAY); }
  function dayIdxToDate(idx) { return new Date(EPOCH + idx * DAY); }
  function dayIdxToAxisLabel(idx) { return dayIdxToDate(idx).toLocaleDateString("en-IT", { month: "short", year: "2-digit" }); }
  function dayIdxToFullDate(idx) { return fmtDate(dayIdxToDate(idx)); }

  const TREND_WINDOWS = {
    "30d": { days: 30, label: "30 days", shortLabel: "30D" },
    "3m": { days: 90, label: "3 months", shortLabel: "3M" },
    "1y": { days: 365, label: "1 year", shortLabel: "1Y" }
  };
  let trendWindowKey = "3m";

  /* ---------- Formatting helpers ---------- */
  function formatPaceDifference(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "";
    const abs = Math.round(Math.abs(seconds));
    const m = Math.floor(abs / 60), s = abs % 60;
    return `${sign}${m}:${String(s).padStart(2, "0")}`;
  }
  function formatSignedKm(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${fmtKm(Math.abs(value))} km/week`;
  }
  function formatSignedPercentage(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${Math.abs(value).toLocaleString("en-IT", { maximumFractionDigits: 0 })}%`;
  }
  function makeTrendCard({ icon, label, value, sub, status = "" }) {
    const statusClass = status === "positive" ? "positive" : status === "negative" ? "negative" : "";
    return `
      <div class="trend-stat-card">
        <div class="trend-stat-icon ${statusClass}" aria-hidden="true">${icon}</div>
        <p class="trend-stat-label">${label}</p>
        <p class="trend-stat-value ${statusClass}">${value}</p>
        <p class="trend-stat-sub">${sub || ""}</p>
      </div>
    `;
  }

  /* ---------- Per-run validity (section 17 of the spec) ---------- */
  function paceSeconds(km, min) {
    return km > 0 && min > 0 ? (min * 60) / km : null;
  }
  function isPaceValid(km, min) {
    const seconds = paceSeconds(km, min);
    return seconds !== null && seconds >= 150 && seconds <= 900;
  }

  /* ---------- Daily aggregation ---------- */
  // One entry per calendar day that has at least one run. Volume uses all
  // non-negative-km runs; pace/HR use only runs passing isPaceValid (an
  // implausible pace usually means bad GPS/manual-entry data, not a real
  // effort, and would otherwise distort the whole window it falls into).
  function buildDailySeries(runs) {
    const byDay = new Map();
    runs.forEach(run => {
      const km = Number(run.km);
      const min = Number(run.min);
      if (!Number.isFinite(km) || km < 0) return;
      const dayIdx = toDayIdx(run.d);
      if (!byDay.has(dayIdx)) {
        byDay.set(dayIdx, { dayIdx, km: 0, runs: 0, paceKm: 0, paceMin: 0, paceRuns: 0, hrWeighted: 0, hrMin: 0 });
      }
      const entry = byDay.get(dayIdx);
      entry.km += km;
      entry.runs += 1;
      if (Number.isFinite(min) && isPaceValid(km, min)) {
        entry.paceKm += km;
        entry.paceMin += min;
        entry.paceRuns += 1;
        if (Number.isFinite(run.hr) && run.hr > 0) {
          entry.hrWeighted += run.hr * min;
          entry.hrMin += min;
        }
      }
    });
    return [...byDay.values()].sort((a, b) => a.dayIdx - b.dayIdx);
  }

  function sumInRange(dailyData, startDay, endDay, field) {
    let sum = 0;
    for (const entry of dailyData) {
      if (entry.dayIdx >= startDay && entry.dayIdx <= endDay) sum += entry[field];
    }
    return sum;
  }

  /* ---------- Rolling series (dense, one point per calendar day) ---------- */
  // Below this, a nonzero windowKm/windowMin is floating-point noise, not a
  // real distance: after thousands of sequential += / -= operations across
  // the whole series, a window that should sum to exactly 0 can be left
  // with a residual like -1e-13. That's harmless for volume (it just rounds
  // away), but fatal for pace, which divides by windowKm — dividing by a
  // near-zero residual instead of a true zero produces huge, effectively
  // random values (this is exactly what caused the flat-topped spikes
  // during rest periods). Every run is at least 0.3km (see MIN_RUN_KM in
  // state.js), so anything under this epsilon can only be rounding noise.
  const ZERO_EPSILON = 1e-6;

  function computeRollingWeeklyVolume(dailyData, windowDays) {
    if (!dailyData.length) return [];
    const firstDay = dailyData[0].dayIdx;
    const lastDay = dailyData[dailyData.length - 1].dayIdx;
    const series = [];
    let windowKm = 0, windowRuns = 0, enterPtr = 0, exitPtr = 0;
    for (let day = firstDay; day <= lastDay; day++) {
      while (enterPtr < dailyData.length && dailyData[enterPtr].dayIdx <= day) {
        windowKm += dailyData[enterPtr].km;
        windowRuns += dailyData[enterPtr].runs;
        enterPtr++;
      }
      while (exitPtr < dailyData.length && dailyData[exitPtr].dayIdx <= day - windowDays) {
        windowKm -= dailyData[exitPtr].km;
        windowRuns -= dailyData[exitPtr].runs;
        exitPtr++;
      }
      const cleanKm = Math.abs(windowKm) < ZERO_EPSILON ? 0 : windowKm;
      series.push({
        x: day,
        y: Math.round(((cleanKm / windowDays) * 7) * 10) / 10,
        kmInWindow: Math.round(cleanKm * 10) / 10,
        runsInWindow: windowRuns
      });
    }
    return series;
  }

  function computeRollingWeightedPace(dailyData, windowDays) {
    if (!dailyData.length) return [];
    const firstDay = dailyData[0].dayIdx;
    const lastDay = dailyData[dailyData.length - 1].dayIdx;
    const series = [];
    let windowKm = 0, windowMin = 0, windowRuns = 0, windowHrWeighted = 0, windowHrMin = 0;
    let enterPtr = 0, exitPtr = 0;
    for (let day = firstDay; day <= lastDay; day++) {
      while (enterPtr < dailyData.length && dailyData[enterPtr].dayIdx <= day) {
        const e = dailyData[enterPtr];
        windowKm += e.paceKm; windowMin += e.paceMin; windowRuns += e.paceRuns;
        windowHrWeighted += e.hrWeighted; windowHrMin += e.hrMin;
        enterPtr++;
      }
      while (exitPtr < dailyData.length && dailyData[exitPtr].dayIdx <= day - windowDays) {
        const e = dailyData[exitPtr];
        windowKm -= e.paceKm; windowMin -= e.paceMin; windowRuns -= e.paceRuns;
        windowHrWeighted -= e.hrWeighted; windowHrMin -= e.hrMin;
        exitPtr++;
      }
      const cleanKm = Math.abs(windowKm) < ZERO_EPSILON ? 0 : windowKm;
      const cleanHrMin = Math.abs(windowHrMin) < ZERO_EPSILON ? 0 : windowHrMin;
      const seconds = cleanKm > 0 ? (windowMin * 60) / cleanKm : null;
      series.push({
        x: day,
        y: seconds !== null ? Math.round(seconds * 10) / 10 : null,
        kmInWindow: Math.round(cleanKm * 10) / 10,
        runsInWindow: windowRuns,
        avgHr: cleanHrMin > 0 ? windowHrWeighted / cleanHrMin : null
      });
    }
    return series;
  }

  function computeVolumeComparison(dailyData, currentDay, windowDays) {
    const currentKm = sumInRange(dailyData, currentDay - windowDays + 1, currentDay, "km");
    const previousKm = sumInRange(dailyData, currentDay - 2 * windowDays + 1, currentDay - windowDays, "km");
    return {
      current: (currentKm / windowDays) * 7,
      previous: (previousKm / windowDays) * 7
    };
  }
  function computePaceComparison(dailyData, currentDay, windowDays) {
    const currentKm = sumInRange(dailyData, currentDay - windowDays + 1, currentDay, "paceKm");
    const currentMin = sumInRange(dailyData, currentDay - windowDays + 1, currentDay, "paceMin");
    const previousKm = sumInRange(dailyData, currentDay - 2 * windowDays + 1, currentDay - windowDays, "paceKm");
    const previousMin = sumInRange(dailyData, currentDay - 2 * windowDays + 1, currentDay - windowDays, "paceMin");
    return {
      current: currentKm > ZERO_EPSILON ? (currentMin * 60) / currentKm : null,
      previous: previousKm > ZERO_EPSILON ? (previousMin * 60) / previousKm : null
    };
  }

  function findSeriesPeak(series) {
    return series.filter(p => Number.isFinite(p.y)).reduce((best, p) => (!best || p.y > best.y ? p : best), null);
  }
  function findSeriesLow(series) {
    return series.filter(p => Number.isFinite(p.y)).reduce((best, p) => (!best || p.y < best.y ? p : best), null);
  }

  /* ---------- Rendering ---------- */
  function setWindowButtonsActive() {
    document.querySelectorAll("#trendWindowRow .chip").forEach(el => {
      el.classList.toggle("active", el.dataset.window === trendWindowKey);
    });
  }

  function renderVolumePanel(dailyData, windowDays, windowInfo) {
    const wrapEl = document.getElementById("trendVolumeWrap");
    const emptyEl = document.getElementById("trendVolumeEmpty");
    const statsEl = document.getElementById("trendVolumeStats");
    document.getElementById("trendVolumeSubtitle").textContent = `Based on ${windowInfo.label} moving average`;

    const series = computeRollingWeeklyVolume(dailyData, windowDays);
    if (!series.length) {
      wrapEl.style.display = "none";
      emptyEl.style.display = "block";
      statsEl.innerHTML = "";
      return;
    }
    wrapEl.style.display = "";
    emptyEl.style.display = "none";

    const lastPoint = series[series.length - 1];
    const currentDay = lastPoint.x;

    upsertChart("chartTrendVol", "line", {
      datasets: [
        {
          label: "Weekly volume", data: series.map(p => ({ x: p.x, y: p.y })),
          borderColor: "#2a78d6", backgroundColor: "rgba(42,120,214,0.18)",
          borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2, spanGaps: true, order: 2
        },
        {
          label: "Current marker line", data: [{ x: currentDay, y: 0 }, { x: currentDay, y: lastPoint.y }],
          borderColor: "rgba(137,135,129,0.55)", borderWidth: 1.5, borderDash: [4, 3],
          pointRadius: 0, fill: false, order: 1
        },
        {
          label: "Current", data: [{ x: currentDay, y: lastPoint.y }],
          showLine: false, pointRadius: 6, pointHoverRadius: 7,
          pointBackgroundColor: "#2a78d6", pointBorderColor: "#ffffff", pointBorderWidth: 2, order: 0
        }
      ]
    }, {
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: context => context.dataset.label !== "Current marker line",
          callbacks: {
            title: items => items.length ? dayIdxToFullDate(items[0].parsed.x) : "",
            label: context => {
              const point = series.find(p => p.x === context.parsed.x) || lastPoint;
              return [
                `${fmtKm(point.y)} km/week`,
                `${fmtKm(point.kmInWindow)} km in last ${windowDays} days`,
                `${point.runsInWindow} runs`
              ];
            }
          }
        }
      },
      scales: {
        x: { type: "linear", grid: { display: false }, ticks: { callback: v => dayIdxToAxisLabel(v) } },
        y: { beginAtZero: true, grid: { color: getGridColor() }, ticks: { callback: v => `${v} km` } }
      }
    });

    const comparison = computeVolumeComparison(dailyData, currentDay, windowDays);
    const delta = comparison.current - comparison.previous;
    let changeValue, changeStatus;
    if (Math.abs(comparison.previous) < ZERO_EPSILON) {
      changeValue = comparison.current > ZERO_EPSILON ? "new" : "—";
      changeStatus = comparison.current > ZERO_EPSILON ? "positive" : "";
    } else {
      changeValue = formatSignedPercentage((delta / comparison.previous) * 100);
      changeStatus = delta >= 0 ? "positive" : "negative";
    }

    const peak = findSeriesPeak(series);
    // Low excludes true rest stretches (0 km/week): over a 12-year history
    // there's always at least one period of total inactivity (injury,
    // break...), so an "includes zero" Low is always 0 and never tells you
    // anything - the chart itself already shows those dips. Reporting the
    // quietest ACTIVE period instead is the informative version of this card.
    const activePoints = series.filter(p => p.y > ZERO_EPSILON);
    const low = findSeriesLow(activePoints.length ? activePoints : series);

    statsEl.innerHTML = [
      makeTrendCard({
        icon: "▥", label: "Current volume",
        value: `${fmtKm(lastPoint.y)} km/week`, sub: dayIdxToFullDate(currentDay)
      }),
      makeTrendCard({
        icon: "↗", label: `Change vs previous ${windowInfo.label}`,
        value: changeValue,
        sub: `${fmtKm(comparison.previous)} → ${fmtKm(comparison.current)} km/week`,
        status: changeStatus
      }),
      makeTrendCard({
        icon: "🔥", label: `Peak (${windowInfo.shortLabel})`,
        value: peak ? `${fmtKm(peak.y)} km/week` : "—", sub: peak ? dayIdxToFullDate(peak.x) : ""
      }),
      makeTrendCard({
        icon: "↘", label: `Low, active weeks (${windowInfo.shortLabel})`,
        value: low ? `${fmtKm(low.y)} km/week` : "—", sub: low ? dayIdxToFullDate(low.x) : ""
      })
    ].join("");
  }

  function renderPacePanel(dailyData, windowDays, windowInfo) {
    const wrapEl = document.getElementById("trendPaceWrap");
    const emptyEl = document.getElementById("trendPaceEmpty");
    const statsEl = document.getElementById("trendPaceStats");
    document.getElementById("trendPaceSubtitle").textContent = `Smoothed with ${windowInfo.label} moving average`;

    const series = computeRollingWeightedPace(dailyData, windowDays);
    const hasAnyPace = series.some(p => Number.isFinite(p.y));
    if (!series.length || !hasAnyPace) {
      wrapEl.style.display = "none";
      emptyEl.style.display = "block";
      statsEl.innerHTML = "";
      return;
    }
    wrapEl.style.display = "";
    emptyEl.style.display = "none";

    // Walk back from the end to find the most recent day with a defined pace.
    let lastPoint = null;
    for (let i = series.length - 1; i >= 0; i--) {
      if (Number.isFinite(series[i].y)) { lastPoint = series[i]; break; }
    }
    const currentDay = lastPoint.x;

    const validPoints = series.filter(p => Number.isFinite(p.y));
    const yMin = Math.min(...validPoints.map(p => p.y));

    upsertChart("chartTrendPace", "line", {
      datasets: [
        {
          label: "Pace", data: series.map(p => ({ x: p.x, y: p.y })),
          borderColor: "#7c3aed", backgroundColor: "#7c3aed",
          borderWidth: 2, pointRadius: 0, fill: false, tension: 0.2, spanGaps: true, order: 2
        },
        {
          label: "Current marker line", data: [{ x: currentDay, y: yMin }, { x: currentDay, y: lastPoint.y }],
          borderColor: "rgba(137,135,129,0.55)", borderWidth: 1.5, borderDash: [4, 3],
          pointRadius: 0, fill: false, order: 1
        },
        {
          label: "Current", data: [{ x: currentDay, y: lastPoint.y }],
          showLine: false, pointRadius: 6, pointHoverRadius: 7,
          pointBackgroundColor: "#7c3aed", pointBorderColor: "#ffffff", pointBorderWidth: 2, order: 0
        }
      ]
    }, {
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: context => context.dataset.label !== "Current marker line",
          callbacks: {
            title: items => items.length ? dayIdxToFullDate(items[0].parsed.x) : "",
            label: context => {
              const point = series.find(p => p.x === context.parsed.x) || lastPoint;
              if (!Number.isFinite(point.y)) return "No valid-pace data in this window";
              const lines = [
                `${fmtPace(point.y)} /km`,
                `${fmtKm(point.kmInWindow)} km`,
                `${point.runsInWindow} runs`
              ];
              if (Number.isFinite(point.avgHr)) lines.push(`Average HR: ${Math.round(point.avgHr)} bpm`);
              return lines;
            }
          }
        }
      },
      scales: {
        x: { type: "linear", grid: { display: false }, ticks: { callback: v => dayIdxToAxisLabel(v) } },
        y: { reverse: true, grid: { color: getGridColor() }, ticks: { callback: v => fmtPace(v) } }
      }
    });

    const comparison = computePaceComparison(dailyData, currentDay, windowDays);
    let changeValue, changeSub, changeStatus;
    if (comparison.current === null || comparison.previous === null) {
      changeValue = "—";
      changeSub = "Not enough valid-pace data in one of the two periods";
      changeStatus = "";
    } else {
      const delta = comparison.current - comparison.previous;
      changeValue = formatPaceDifference(delta) + " /km";
      changeSub = `${fmtPace(comparison.previous)} → ${fmtPace(comparison.current)}`;
      // Lower pace = faster = improvement, so a negative delta is "positive".
      changeStatus = delta < 0 ? "positive" : delta > 0 ? "negative" : "";
    }

    // Best/worst ignore windows built from under 5km of valid-pace running,
    // so a single very short run can't produce an artificial pace spike.
    const reliablePoints = series.filter(p => Number.isFinite(p.y) && p.kmInWindow >= 5);
    const best = findSeriesLow(reliablePoints);
    const worst = findSeriesPeak(reliablePoints);

    statsEl.innerHTML = [
      makeTrendCard({
        icon: "◴", label: "Current pace",
        value: `${fmtPace(lastPoint.y)} /km`, sub: dayIdxToFullDate(currentDay)
      }),
      makeTrendCard({
        icon: "↗", label: `Change vs previous ${windowInfo.label}`,
        value: changeValue, sub: changeSub, status: changeStatus
      }),
      makeTrendCard({
        icon: "☆", label: `Best (${windowInfo.shortLabel})`,
        value: best ? `${fmtPace(best.y)} /km` : "—", sub: best ? dayIdxToFullDate(best.x) : ""
      }),
      makeTrendCard({
        icon: "⚠", label: `Worst (${windowInfo.shortLabel})`,
        value: worst ? `${fmtPace(worst.y)} /km` : "—", sub: worst ? dayIdxToFullDate(worst.x) : ""
      })
    ].join("");
  }

  function renderTrend() {
    setWindowButtonsActive();
    const windowInfo = TREND_WINDOWS[trendWindowKey];
    const dailyData = buildDailySeries(filteredRuns());
    renderVolumePanel(dailyData, windowInfo.days, windowInfo);
    renderPacePanel(dailyData, windowInfo.days, windowInfo);
  }

  document.querySelectorAll("#trendWindowRow .chip").forEach(el => {
    el.addEventListener("click", () => {
      trendWindowKey = el.dataset.window;
      dirty.trend = true;
      renderTrend();
    });
  });

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.trend = { render: renderTrend };
})();
