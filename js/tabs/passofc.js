// "Pace, HR & cadence" tab: yearly pace, HR, HR-zone distribution, cadence.
(function () {
  const { filteredRuns, getSelectedYears, groupByYear, upsertChart, fmtPace, getGridColor, HRZ_LABELS, HRZ_COLORS } = window.RD.state;

  function renderPassoFc() {
    const runs = filteredRuns();
    const years = [...getSelectedYears()].sort((a,b)=>a-b);
    const byYear = groupByYear(runs);

    const paceYears = years.filter(y => byYear.get(y) && byYear.get(y).km > 0);
    upsertChart("chartPace", "line", {
      labels: paceYears,
      datasets: [{ label:"Pace", data: paceYears.map(y => (byYear.get(y).min*60)/byYear.get(y).km), borderColor:"#4a3aa7", backgroundColor:"#4a3aa7", borderWidth:2, pointRadius:3, tension:0.2 }]
    }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => fmtPace(ctx.parsed.y) + " /km" } } },
      scales: { y:{reverse:true, grid:{color:getGridColor()}, ticks:{callback:v=>fmtPace(v)}}, x:{grid:{display:false}} }
    });

    const hrYears = years.filter(y => byYear.get(y) && byYear.get(y).hr.length);
    upsertChart("chartHr", "line", {
      labels: hrYears,
      datasets: [
        { label:"Average", data: hrYears.map(y => { const h=byYear.get(y).hr; return h.reduce((a,b)=>a+b,0)/h.length; }), borderColor:"#e34948", backgroundColor:"#e34948", borderWidth:2, pointRadius:3, tension:0.2 },
        { label:"Maximum", data: hrYears.map(y => byYear.get(y).mhr || null), borderColor:"#4a3aa7", backgroundColor:"#4a3aa7", borderWidth:2, pointRadius:3, tension:0.2, borderDash:[4,3] }
      ]
    }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ": " + ctx.parsed.y.toFixed(0) + " bpm" } } },
      scales: { y:{grid:{color:getGridColor()}, ticks:{callback:v=>v+" bpm"}}, x:{grid:{display:false}} }
    });

    const hrzLegend = document.getElementById("hrzLegend");
    hrzLegend.innerHTML = HRZ_LABELS.map((l,i) => `<span><span class="sw" style="background:${HRZ_COLORS[i]}"></span>${l}</span>`).join("");

    const hrzYears = years.filter(y => byYear.get(y) && byYear.get(y).hrz.reduce((a,b)=>a+b,0) > 0);
    const hrzDatasets = HRZ_LABELS.map((label,i) => ({
      label, backgroundColor: HRZ_COLORS[i],
      data: hrzYears.map(y => {
        const z = byYear.get(y).hrz;
        const tot = z.reduce((a,b)=>a+b,0);
        return tot > 0 ? Math.round((z[i]/tot)*1000)/10 : 0;
      })
    }));
    upsertChart("chartHrZones", "bar", { labels: hrzYears, datasets: hrzDatasets }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ": " + ctx.parsed.y.toFixed(0) + "%" } } },
      scales: { x:{stacked:true, grid:{display:false}}, y:{stacked:true, max:100, grid:{color:getGridColor()}, ticks:{callback:v=>v+"%"}} }
    });

    const cadYears = years.filter(y => byYear.get(y) && byYear.get(y).cad.length);
    upsertChart("chartCadence", "line", {
      labels: cadYears,
      datasets: [{ label:"Cadence", data: cadYears.map(y => { const c=byYear.get(y).cad; return c.reduce((a,b)=>a+b,0)/c.length; }), borderColor:"#1baf7a", backgroundColor:"#1baf7a", borderWidth:2, pointRadius:3, tension:0.2 }]
    }, {
      plugins: { tooltip: { callbacks: { label: (ctx) => ctx.parsed.y.toFixed(0) + " spm" } } },
      scales: { y:{grid:{color:getGridColor()}, ticks:{callback:v=>v+" spm"}}, x:{grid:{display:false}} }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.passofc = { render: renderPassoFc };
})();
