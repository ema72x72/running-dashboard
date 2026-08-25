// Yearly tab: total km per year (with trend line + summary cards) and
// km per calendar month (with summary cards + footnote).
(function () {
  const { filteredRuns, getSelectedYears, groupByYear, upsertChart, fmtKm, getGridColor } = window.RD.state;

  function median(values) {
    const valid = values
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!valid.length) return null;
    const middle = Math.floor(valid.length / 2);
    return valid.length % 2
      ? valid[middle]
      : (valid[middle - 1] + valid[middle]) / 2;
  }

  function monthLabel(yearMonth) {
    const [year, month] = yearMonth.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("en-IT", {
      month: "long",
      year: "numeric"
    });
  }

  function makeYearlyStatCard(icon, label, value, sub = "") {
    return `
      <div class="yearly-stat-card">
        <div class="yearly-stat-icon" aria-hidden="true">${icon}</div>
        <p class="yearly-stat-label">${label}</p>
        <p class="yearly-stat-value">${value}</p>
        <p class="yearly-stat-sub">${sub}</p>
      </div>
    `;
  }

  function renderAnnuale() {
    const runs = filteredRuns()
      .slice()
      .sort((a, b) => a.d.localeCompare(b.d));
    const years = [...getSelectedYears()].sort((a, b) => a - b);
    const byYear = groupByYear(runs);
    const yearlyData = years.map(
      year => byYear.get(year)?.km || 0
    );
    const yearlyRuns = years.map(
      year => byYear.get(year)?.n || 0
    );
    const yearlyAverageDistance = years.map((year, index) => {
      const count = yearlyRuns[index];
      return count ? yearlyData[index] / count : 0;
    });
    const lastSelectedYear = years.length
      ? Math.max(...years)
      : null;
    const yearlyBarColours = years.map(year =>
      year === lastSelectedYear ? "#fc4c02" : "#2a78d6"
    );

    upsertChart(
      "chartYearly",
      "bar",
      {
        labels: years,
        datasets: [
          {
            type: "bar",
            label: "Kilometres",
            data: yearlyData,
            backgroundColor: yearlyBarColours,
            borderRadius: 6,
            maxBarThickness: 42,
            order: 2
          }
        ]
      },
      {
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: items => {
                if (!items.length) return "";
                return String(years[items[0].dataIndex]);
              },
              label: context => {
                const index = context.dataIndex;
                return [
                  `${fmtKm(yearlyData[index])} km`,
                  `${yearlyRuns[index]} runs`,
                  `${yearlyAverageDistance[index].toLocaleString(
                    "en-IT",
                    { maximumFractionDigits: 1 }
                  )} km average distance`
                ];
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: getGridColor()
            },
            ticks: {
              callback: value =>
                `${Number(value).toLocaleString("en-IT")} km`
            }
          },
          x: {
            grid: {
              display: false
            }
          }
        }
      }
    );

    /* ---------- Annual cards ---------- */
    const yearRecords = years
      .map((year, index) => ({
        year,
        km: yearlyData[index],
        runs: yearlyRuns[index]
      }))
      .filter(record => record.runs > 0);

    const bestYear = yearRecords.length
      ? yearRecords.reduce(
          (best, current) => current.km > best.km ? current : best
        )
      : null;
    const activeYearCount = yearRecords.length;
    const totalKm = yearRecords.reduce(
      (sum, record) => sum + record.km,
      0
    );
    const totalRuns = yearRecords.reduce(
      (sum, record) => sum + record.runs,
      0
    );
    const averageKmPerYear = activeYearCount
      ? totalKm / activeYearCount
      : 0;
    const averageRunsPerYear = activeYearCount
      ? totalRuns / activeYearCount
      : 0;
    const averageDistancePerRun = totalRuns
      ? totalKm / totalRuns
      : 0;
    const rangeText = years.length
      ? `${years[0]}–${years[years.length - 1]}`
      : "No years selected";

    document.getElementById("yearlyRangeLabel").textContent =
      years.length ? rangeText : "";

    document.getElementById("yearlyStats").innerHTML = [
      makeYearlyStatCard(
        "🏆",
        "Best year",
        bestYear ? bestYear.year : "—",
        bestYear ? `${fmtKm(bestYear.km)} km` : ""
      ),
      makeYearlyStatCard(
        "▣",
        "Average per year",
        activeYearCount
          ? `${fmtKm(averageKmPerYear)} km`
          : "—",
        activeYearCount ? rangeText : ""
      ),
      makeYearlyStatCard(
        "🏃",
        "Average runs per year",
        activeYearCount
          ? averageRunsPerYear.toLocaleString("en-IT", {
              maximumFractionDigits: 1
            })
          : "—",
        activeYearCount
          ? `${(averageRunsPerYear / 12).toLocaleString("en-IT", {
              maximumFractionDigits: 1
            })} per month`
          : ""
      ),
      makeYearlyStatCard(
        "👟",
        "Average distance per run",
        totalRuns
          ? `${averageDistancePerRun.toLocaleString("en-IT", {
              maximumFractionDigits: 1
            })} km`
          : "—"
      )
    ].join("");

    /* ---------- Monthly aggregation ---------- */
    const monthMap = new Map();
    runs.forEach(run => {
      const yearMonth = run.d.slice(0, 7);
      if (!monthMap.has(yearMonth)) {
        monthMap.set(yearMonth, {
          km: 0,
          runs: 0
        });
      }
      const month = monthMap.get(yearMonth);
      month.km += Number(run.km) || 0;
      month.runs += 1;
    });
    const months = [...monthMap.keys()].sort();
    const monthlyKm = months.map(
      month => monthMap.get(month).km
    );
    const monthlyRunCounts = months.map(
      month => monthMap.get(month).runs
    );

    document.getElementById("monthlyChartTitle").textContent =
      years.length
        ? `Kilometres by month (${rangeText})`
        : "Kilometres by month";

    upsertChart(
      "chartMonthly",
      "bar",
      {
        labels: months,
        datasets: [
          {
            label: "Kilometres",
            data: monthlyKm,
            backgroundColor: "#2a78d6",
            hoverBackgroundColor: "#fc4c02",
            borderRadius: 3,
            maxBarThickness: 22
          }
        ]
      },
      {
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: items => {
                if (!items.length) return "";
                return monthLabel(months[items[0].dataIndex]);
              },
              label: context => {
                const index = context.dataIndex;
                const km = monthlyKm[index];
                const runCount = monthlyRunCounts[index];
                const averageDistance = runCount
                  ? km / runCount
                  : 0;
                return [
                  `${fmtKm(km)} km`,
                  `${runCount} runs`,
                  `${averageDistance.toLocaleString("en-IT", {
                    maximumFractionDigits: 1
                  })} km average distance`
                ];
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: getGridColor()
            },
            ticks: {
              callback: value =>
                `${Number(value).toLocaleString("en-IT")} km`
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              maxTicksLimit: 10,
              callback: function(value, index) {
                const label = months[index];
                if (!label) return "";
                const [year, month] = label.split("-");
                return month === "01"
                  ? year
                  : `${year}-${month}`;
              }
            }
          }
        }
      }
    );

    /* ---------- Monthly cards ---------- */
    const bestMonthIndex = monthlyKm.length
      ? monthlyKm.indexOf(Math.max(...monthlyKm))
      : -1;
    const averageMonthlyVolume = monthlyKm.length
      ? monthlyKm.reduce((sum, value) => sum + value, 0)
        / monthlyKm.length
      : 0;
    const medianMonthlyVolume = median(monthlyKm);
    const averageRunsPerMonth = monthlyRunCounts.length
      ? monthlyRunCounts.reduce(
          (sum, value) => sum + value,
          0
        ) / monthlyRunCounts.length
      : 0;

    document.getElementById("monthlyStats").innerHTML = [
      makeYearlyStatCard(
        "☆",
        "Best month",
        bestMonthIndex >= 0
          ? `${fmtKm(monthlyKm[bestMonthIndex])} km`
          : "—",
        bestMonthIndex >= 0
          ? monthLabel(months[bestMonthIndex])
          : ""
      ),
      makeYearlyStatCard(
        "▥",
        "Average monthly volume",
        monthlyKm.length
          ? `${fmtKm(averageMonthlyVolume)} km`
          : "—"
      ),
      makeYearlyStatCard(
        "◫",
        "Median monthly volume",
        medianMonthlyVolume !== null
          ? `${fmtKm(medianMonthlyVolume)} km`
          : "—",
        "Less affected by exceptionally high or low months"
      ),
      makeYearlyStatCard(
        "🏃",
        "Average runs per month",
        monthlyRunCounts.length
          ? averageRunsPerMonth.toLocaleString("en-IT", {
              maximumFractionDigits: 1
            })
          : "—"
      )
    ].join("");

    const firstMonth = months[0];
    const lastMonth = months[months.length - 1];
    document.getElementById("monthlyFootnote").innerHTML =
      months.length
        ? `
          <span aria-hidden="true">ⓘ</span>
          <span>
            Monthly data includes ${months.length.toLocaleString("en-IT")}
            calendar months from ${monthLabel(firstMonth)}
            to ${monthLabel(lastMonth)}.
          </span>
        `
        : `
          <span aria-hidden="true">ⓘ</span>
          <span>No monthly data for the selected years.</span>
        `;
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.annuale = { render: renderAnnuale };
})();
