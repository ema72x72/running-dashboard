// Weekdays tab: total km per weekday.
(function () {
  const { filteredRuns, upsertChart, WD_LABELS, fmtKm, getGridColor } = window.RD.state;

  function renderSettimana() {
    const runs = filteredRuns();
    const wd = new Array(7).fill(0);
    const wdN = new Array(7).fill(0);
    runs.forEach(r => { wd[r.wd] += r.km; wdN[r.wd] += 1; });

    upsertChart("chartWeekday", "bar", {
      labels: WD_LABELS,
      datasets: [{ label:"Km", data: wd, backgroundColor:"#2a78d6", borderRadius:4, maxBarThickness:50 }]
    }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => fmtKm(ctx.parsed.y) + " km · " + wdN[ctx.dataIndex] + " runs" } } },
      scales: { y:{beginAtZero:true, grid:{color:getGridColor()}, ticks:{callback:v=>v+" km"}}, x:{grid:{display:false}} }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.settimana = { render: renderSettimana };
})();
