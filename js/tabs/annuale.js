// Yearly tab: total km per year + km per month.
(function () {
  const { filteredRuns, getSelectedYears, groupByYear, upsertChart, fmtKm, getGridColor } = window.RD.state;

  function renderAnnuale() {
    const runs = filteredRuns();
    const years = [...getSelectedYears()].sort((a,b)=>a-b);
    const byYear = groupByYear(runs);

    const yearlyData = years.map(y => byYear.get(y) ? byYear.get(y).km : 0);
    const yearlyRuns = years.map(y => byYear.get(y) ? byYear.get(y).n : 0);

    upsertChart("chartYearly", "bar", {
      labels: years,
      datasets: [{ label: "Km", data: yearlyData, backgroundColor: "#2a78d6", borderRadius: 4, maxBarThickness: 34 }]
    }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => fmtKm(ctx.parsed.y) + " km · " + yearlyRuns[ctx.dataIndex] + " runs" } } },
      scales: { y: { beginAtZero:true, grid:{color:getGridColor()}, ticks:{callback:v=>v+" km"} }, x:{grid:{display:false}} }
    });

    const monthMap = new Map();
    runs.forEach(r => {
      const ym = r.d.slice(0,7);
      monthMap.set(ym, (monthMap.get(ym)||0) + r.km);
    });
    const months = [...monthMap.keys()].sort();

    upsertChart("chartMonthly", "line", {
      labels: months,
      datasets: [{ label:"Km", data: months.map(m=>monthMap.get(m)), borderColor:"#2a78d6", backgroundColor:"rgba(42,120,214,0.1)", fill:true, borderWidth:2, pointRadius:0, tension:0.25 }]
    }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => fmtKm(ctx.parsed.y) + " km" } } },
      scales: { y:{beginAtZero:true, grid:{color:getGridColor()}, ticks:{callback:v=>v+" km"}}, x:{grid:{display:false}, ticks:{maxTicksLimit:10}} }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.annuale = { render: renderAnnuale };
})();
