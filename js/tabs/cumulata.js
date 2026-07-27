// Cumulative tab: running km total within each year, one line per year.
(function () {
  const { filteredRuns, getSelectedYears, getAllYears, destroyChart, upsertChart, YEAR_COLORS, fmtKm, gridColor } = window.RD.state;

  function renderCumulata() {
    const runs = filteredRuns();
    const years = [...getSelectedYears()].sort((a,b)=>a-b);
    const legendEl = document.getElementById("cumLegend");

    const wrapEl = document.getElementById("cumulataWrap");
    const emptyEl = document.getElementById("cumulataEmpty");

    if (years.length === 0) {
      legendEl.innerHTML = "";
      destroyChart("chartCumulative");
      wrapEl.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }

    wrapEl.style.display = "";
    emptyEl.style.display = "none";
    legendEl.innerHTML = years.map(y => `<span><span class="sw" style="background:${YEAR_COLORS[y]||"#999"}"></span>${y}</span>`).join("");

    const byYear = new Map();
    years.forEach(y => byYear.set(y, []));
    runs.forEach(r => byYear.get(r.y) && byYear.get(r.y).push(r));

    const datasets = years.map(y => {
      const rs = byYear.get(y).slice().sort((a,b) => a.doy - b.doy);
      let cum = 0;
      const pts = rs.map(r => { cum += r.km; return {x: r.doy, y: Math.round(cum*10)/10}; });
      return {
        label: String(y), data: pts,
        borderColor: YEAR_COLORS[y] || "#999", backgroundColor: YEAR_COLORS[y] || "#999",
        borderWidth: (y === Math.max(...getAllYears())) ? 3 : 1.5,
        pointRadius: 0, tension: 0.15, fill: false
      };
    });

    upsertChart("chartCumulative", "line", { datasets }, {
      plugins: { tooltip: { callbacks: { title: (items) => items[0].dataset.label, label: (ctx) => "day " + ctx.parsed.x + ": " + fmtKm(ctx.parsed.y) + " km" } } },
      scales: {
        x: { type:"linear", min:1, max:366, grid:{display:false}, title:{display:true, text:"day of year"} },
        y: { beginAtZero:true, grid:{color:gridColor}, ticks:{callback:v=>v+" km"} }
      }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.cumulata = { render: renderCumulata };
})();
