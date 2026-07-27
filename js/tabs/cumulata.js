// Cumulative tab: cumulative km within each selected year, compared
// against the historical range (25th-75th percentile) and best year,
// plus a pace projection for the most recent selected year.
(function () {
  const { filteredRuns, getSelectedYears, destroyChart, upsertChart, YEAR_COLORS, fmtKm, getGridColor } = window.RD.state;

  function cumulativePercentile(values, percentile) {
    const sorted = values
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const position = (sorted.length - 1) * percentile;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const weight = position - lowerIndex;
    return sorted[lowerIndex]
      + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
  }
  function cumulativeMean(values) {
    const valid = values.map(Number).filter(Number.isFinite);
    return valid.length
      ? valid.reduce((sum, value) => sum + value, 0) / valid.length
      : null;
  }
  function cumulativeMedian(values) {
    return cumulativePercentile(values, 0.5);
  }
  function cumulativeSignedKm(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${fmtKm(Math.abs(value))} km`;
  }
  function cumulativeSignedPercentage(value) {
    if (!Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return `${sign}${Math.abs(value).toLocaleString("en-IT", { maximumFractionDigits: 0 })}%`;
  }
  function cumulativeDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    return Math.floor((date - start) / 86400000);
  }
  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }
  function buildDailyCumulative(yearRuns) {
    const daily = new Array(367).fill(0);
    const sortedRuns = yearRuns.slice().sort((a, b) => Number(a.doy) - Number(b.doy));
    let total = 0;
    let runIndex = 0;
    for (let day = 1; day <= 366; day++) {
      while (runIndex < sortedRuns.length && Number(sortedRuns[runIndex].doy) <= day) {
        total += Number(sortedRuns[runIndex].km) || 0;
        runIndex += 1;
      }
      daily[day] = total;
    }
    return daily;
  }
  function makeCumulativeCard({ icon, label, value, sub, status = "" }) {
    const statusClass = status === "positive" ? "positive"
      : status === "negative" ? "negative"
      : status === "projection" ? "projection"
      : "";
    return `
      <div class="cumulative-card">
        <div class="cumulative-card-top">
          <div class="cumulative-card-icon ${statusClass}">${icon}</div>
          <p class="cumulative-card-label">${label}</p>
        </div>
        <p class="cumulative-card-value ${statusClass}">${value}</p>
        <p class="cumulative-card-sub">${sub || ""}</p>
      </div>
    `;
  }

  function renderCumulata() {
    const runs = filteredRuns();
    const years = [...getSelectedYears()].sort((a, b) => a - b);
    const legendEl = document.getElementById("cumLegend");
    const wrapEl = document.getElementById("cumulataWrap");
    const emptyEl = document.getElementById("cumulataEmpty");
    const statsEl = document.getElementById("cumulativeStats");
    const targetEl = document.getElementById("cumulativeTarget");
    const subtitleEl = document.getElementById("cumulativeSubtitle");
    const bandNoteEl = document.getElementById("cumulativeBandNote");

    if (!years.length) {
      legendEl.innerHTML = "";
      statsEl.innerHTML = "";
      targetEl.innerHTML = "";
      destroyChart("chartCumulative");
      wrapEl.style.display = "none";
      emptyEl.style.display = "block";
      bandNoteEl.style.display = "none";
      return;
    }

    wrapEl.style.display = "";
    emptyEl.style.display = "none";

    const referenceYear = Math.max(...years);
    const comparisonYears = years.filter(year => year !== referenceYear);

    const byYear = new Map();
    years.forEach(year => byYear.set(year, []));
    runs.forEach(run => { if (byYear.has(run.y)) byYear.get(run.y).push(run); });

    const dailyByYear = new Map();
    years.forEach(year => dailyByYear.set(year, buildDailyCumulative(byYear.get(year))));

    const referenceRuns = byYear.get(referenceYear);
    const currentCalendarYear = new Date().getFullYear();
    let comparisonDay;
    if (referenceYear === currentCalendarYear) {
      const lastRecordedDay = referenceRuns.length
        ? Math.max(...referenceRuns.map(run => Number(run.doy) || 0))
        : cumulativeDayOfYear(new Date());
      comparisonDay = Math.min(cumulativeDayOfYear(new Date()), lastRecordedDay || 366);
    } else {
      comparisonDay = 366;
    }
    comparisonDay = Math.max(1, Math.min(366, comparisonDay));

    subtitleEl.textContent = `Comparing ${referenceYear} with the other selected years at day ${comparisonDay}`;

    legendEl.innerHTML = years.map(year => `
      <span><span class="sw" style="background:${YEAR_COLORS[year] || "#999"}"></span>${year}</span>
    `).join("");

    /* ---------- Percentile band + historical average ---------- */
    const percentileLow = [];
    const percentileHigh = [];
    const historicalAverage = [];
    for (let day = 1; day <= 366; day++) {
      const values = comparisonYears.map(year => dailyByYear.get(year)[day]);
      percentileLow.push({ x: day, y: cumulativePercentile(values, 0.25) });
      percentileHigh.push({ x: day, y: cumulativePercentile(values, 0.75) });
      historicalAverage.push({ x: day, y: cumulativeMean(values) });
    }

    const datasets = [];
    if (comparisonYears.length >= 2) {
      datasets.push(
        {
          label: "Historical 25th percentile",
          data: percentileLow,
          borderColor: "rgba(137,135,129,0)",
          backgroundColor: "rgba(137,135,129,0)",
          borderWidth: 0, pointRadius: 0, tension: 0.12, fill: false, order: 10
        },
        {
          label: "Historical range",
          data: percentileHigh,
          borderColor: "rgba(137,135,129,0)",
          backgroundColor: "rgba(137,135,129,0.16)",
          borderWidth: 0, pointRadius: 0, tension: 0.12, fill: "-1", order: 9
        }
      );
    }
    if (comparisonYears.length >= 1) {
      datasets.push({
        label: "Historical average",
        data: historicalAverage,
        borderColor: "rgba(137,135,129,0.65)",
        backgroundColor: "rgba(137,135,129,0.65)",
        borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0,
        tension: 0.12, fill: false, order: 8
      });
    }

    /* ---------- Year lines ---------- */
    years.forEach(year => {
      const daily = dailyByYear.get(year);
      const yearRuns = byYear.get(year);
      const finalDay = year === referenceYear
        ? comparisonDay
        : yearRuns.length ? Math.max(...yearRuns.map(run => Number(run.doy) || 0)) : 366;
      const points = [];
      for (let day = 1; day <= finalDay; day++) {
        points.push({ x: day, y: Math.round(daily[day] * 10) / 10 });
      }
      const isReference = year === referenceYear;
      datasets.push({
        label: String(year), data: points,
        borderColor: YEAR_COLORS[year] || "#999", backgroundColor: YEAR_COLORS[year] || "#999",
        borderWidth: isReference ? 4 : 1.5,
        pointRadius: 0, pointHoverRadius: isReference ? 5 : 3, pointHitRadius: 10,
        tension: 0.15, fill: false, order: isReference ? 0 : 3
      });
    });

    /* ---------- Current-day marker ---------- */
    const referenceKm = dailyByYear.get(referenceYear)[comparisonDay];
    datasets.push({
      label: `${referenceYear} current position`,
      data: [{ x: comparisonDay, y: referenceKm }],
      showLine: false, pointRadius: 6, pointHoverRadius: 7,
      pointBackgroundColor: YEAR_COLORS[referenceYear] || "#e34948",
      pointBorderColor: "#ffffff", pointBorderWidth: 2, order: -1
    });

    upsertChart("chartCumulative", "line", { datasets }, {
      // "index" (not "nearest") so hovering near a given day shows every
      // visible year's value at that day together, matching a single
      // vertical comparison point rather than just the closest dot.
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: context => !context.dataset.label.includes("percentile") && context.dataset.label !== "Historical range",
          callbacks: {
            title: items => {
              if (!items.length) return "";
              return `Day ${Math.round(items[0].parsed.x)}`;
            },
            label: context => {
              const label = context.dataset.label;
              if (label === `${referenceYear} current position`) return `${referenceYear}: ${fmtKm(context.parsed.y)} km`;
              if (label === "Historical average") return `Average others: ${fmtKm(context.parsed.y)} km`;
              return `${label}: ${fmtKm(context.parsed.y)} km`;
            }
          }
        }
      },
      scales: {
        x: {
          type: "linear", min: 1, max: 366, grid: { display: false },
          title: { display: true, text: "day of year" },
          ticks: { callback: value => [1, 50, 100, 150, 200, 250, 300, 366].includes(Number(value)) ? value : "" }
        },
        y: {
          beginAtZero: true, grid: { color: getGridColor() },
          ticks: { callback: value => `${Number(value).toLocaleString("en-IT")} km` }
        }
      }
    });

    bandNoteEl.style.display = comparisonYears.length >= 2 ? "flex" : "none";

    /* ---------- Comparative statistics ---------- */
    const comparisonAtDay = comparisonYears.map(year => ({
      year, km: dailyByYear.get(year)[comparisonDay], finalKm: dailyByYear.get(year)[366]
    }));
    const ranking = [
      { year: referenceYear, km: referenceKm },
      ...comparisonAtDay.map(item => ({ year: item.year, km: item.km }))
    ].sort((a, b) => b.km - a.km);
    const referenceRank = ranking.findIndex(item => item.year === referenceYear) + 1;

    const historicalAverageKm = cumulativeMean(comparisonAtDay.map(item => item.km));
    const differenceVsAverage = historicalAverageKm !== null ? referenceKm - historicalAverageKm : null;
    const percentageVsAverage = historicalAverageKm > 0 ? (differenceVsAverage / historicalAverageKm) * 100 : null;

    const bestHistoricalAtDay = comparisonAtDay.length
      ? comparisonAtDay.reduce((best, current) => current.km > best.km ? current : best)
      : null;
    const differenceVsBest = bestHistoricalAtDay ? referenceKm - bestHistoricalAtDay.km : null;

    /* ---------- Projection ---------- */
    const historicalCompletionShares = comparisonAtDay
      .filter(item => item.finalKm > 0 && item.km > 0)
      .map(item => item.km / item.finalKm)
      .filter(share => Number.isFinite(share) && share > 0 && share <= 1);
    const medianShare = cumulativeMedian(historicalCompletionShares);
    const lowerShare = cumulativePercentile(historicalCompletionShares, 0.75);
    const upperShare = cumulativePercentile(historicalCompletionShares, 0.25);
    const projectedTotal = medianShare ? referenceKm / medianShare : null;
    const projectedLow = lowerShare ? referenceKm / lowerShare : null;
    const projectedHigh = upperShare ? referenceKm / upperShare : null;
    const bestFinalYear = comparisonAtDay.length
      ? comparisonAtDay.reduce((best, current) => current.finalKm > best.finalKm ? current : best)
      : null;
    const projectionIsRecord = projectedTotal !== null && bestFinalYear && projectedTotal > bestFinalYear.finalKm;

    statsEl.innerHTML = [
      makeCumulativeCard({
        icon: "🏆", label: "Current position",
        value: `${referenceRank}${referenceRank === 1 ? "st" : referenceRank === 2 ? "nd" : referenceRank === 3 ? "rd" : "th"} of ${ranking.length} years`,
        sub: `${fmtKm(referenceKm)} km by day ${comparisonDay}`,
        status: referenceRank === 1 ? "positive" : ""
      }),
      makeCumulativeCard({
        icon: "↗", label: "Vs historical average",
        value: cumulativeSignedPercentage(percentageVsAverage),
        sub: historicalAverageKm !== null
          ? `${cumulativeSignedKm(differenceVsAverage)} · average others: ${fmtKm(historicalAverageKm)} km`
          : "Select at least one previous year",
        // Number.isFinite guard: differenceVsAverage is null when there's no
        // comparison data, and JS coerces null to 0 in ">=" comparisons, so
        // an unguarded check would wrongly colour this "positive".
        status: Number.isFinite(differenceVsAverage) ? (differenceVsAverage >= 0 ? "positive" : "negative") : ""
      }),
      makeCumulativeCard({
        icon: "♛", label: bestHistoricalAtDay ? `Vs best year (${bestHistoricalAtDay.year})` : "Vs best year",
        value: differenceVsBest !== null ? cumulativeSignedKm(differenceVsBest) : "—",
        sub: bestHistoricalAtDay
          ? (differenceVsBest >= 0 ? `Ahead of ${bestHistoricalAtDay.year}` : `Behind ${bestHistoricalAtDay.year}`)
          : "Select at least one previous year",
        status: Number.isFinite(differenceVsBest) ? (differenceVsBest >= 0 ? "positive" : "negative") : ""
      }),
      makeCumulativeCard({
        icon: "⌁", label: "Projected total",
        value: projectedTotal !== null ? `${fmtKm(projectedTotal)} km` : "—",
        sub: projectedTotal !== null
          ? `${projectionIsRecord ? "Record pace" : "Based on selected-year seasonality"}`
            + (projectedLow !== null && projectedHigh !== null ? ` · range ${fmtKm(projectedLow)}–${fmtKm(projectedHigh)} km` : "")
          : "Insufficient historical comparison data",
        status: "projection"
      })
    ].join("");

    /* ---------- Target card ---------- */
    if (!bestFinalYear) {
      targetEl.innerHTML = "";
      return;
    }
    const daysInReferenceYear = isLeapYear(referenceYear) ? 366 : 365;
    const remainingDays = Math.max(0, daysInReferenceYear - comparisonDay);
    const remainingWeeks = remainingDays / 7;
    const distanceToRecord = bestFinalYear.finalKm - referenceKm;

    if (distanceToRecord <= 0) {
      const recordLead = Math.abs(distanceToRecord);
      targetEl.innerHTML = `
        <div class="cumulative-target-card">
          <div class="cumulative-target-main">
            <div class="cumulative-target-icon">🏆</div>
            <div>
              <p class="cumulative-target-title">New yearly distance record</p>
              <p class="cumulative-target-sub">You have already exceeded ${bestFinalYear.year}.</p>
            </div>
          </div>
          <div class="cumulative-target-message">
            <strong>You are ${fmtKm(recordLead)} km above the previous record.</strong>
            <span>Every additional kilometre extends the new benchmark.</span>
          </div>
          <div class="cumulative-target-number">
            <strong>+${fmtKm(recordLead)}</strong>
            <span>km above record</span>
          </div>
        </div>
      `;
      return;
    }

    const requiredWeeklyKm = remainingWeeks > 0 ? distanceToRecord / remainingWeeks : null;
    const aheadOfBestPace = differenceVsBest !== null && differenceVsBest >= 0;

    targetEl.innerHTML = `
      <div class="cumulative-target-card">
        <div class="cumulative-target-main">
          <div class="cumulative-target-icon">◎</div>
          <div>
            <p class="cumulative-target-title">To beat ${bestFinalYear.year}</p>
            <p class="cumulative-target-sub">Target: ${fmtKm(bestFinalYear.finalKm)} km</p>
          </div>
        </div>
        <div class="cumulative-target-message">
          <strong>${aheadOfBestPace ? `Keep it up — you are ahead of ${bestFinalYear.year}'s pace.` : `You can still finish above your best selected year.`}</strong>
          <span>${requiredWeeklyKm !== null ? `Average ${requiredWeeklyKm.toLocaleString("en-IT", { maximumFractionDigits: 1 })} km per week through year-end.` : ""}</span>
        </div>
        <div class="cumulative-target-number">
          <strong>${requiredWeeklyKm !== null ? requiredWeeklyKm.toLocaleString("en-IT", { maximumFractionDigits: 1 }) : "—"}</strong>
          <span>km/week required</span>
        </div>
      </div>
    `;
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.cumulata = { render: renderCumulata };
})();
