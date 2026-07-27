// Trend tab: 30-day moving average of pace and weekly volume.
(function () {
  const { filteredRuns, upsertChart, fmtPace, fmtKm, gridColor } = window.RD.state;

  const EPOCH = new Date("2014-01-01T00:00:00Z").getTime();
  const DAY = 86400000;
  function toDayIdx(dateStr) { return Math.round((new Date(dateStr+"T00:00:00Z").getTime() - EPOCH) / DAY); }
  function dayIdxToLabel(idx) { const d = new Date(EPOCH + idx*DAY); return d.toLocaleDateString("en-IT",{month:"short",year:"2-digit"}); }

  function renderTrend() {
    const runs = filteredRuns().slice().sort((a,b) => a.d.localeCompare(b.d));
    const pacePts = [], volPts = [];

    for (let i = 0; i < runs.length; i++) {
      const dIdx = toDayIdx(runs[i].d);
      const windowStart = dIdx - 30;
      let kmSum = 0, minSum = 0;
      for (let j = i; j >= 0; j--) {
        const jIdx = toDayIdx(runs[j].d);
        if (jIdx < windowStart) break;
        kmSum += runs[j].km; minSum += runs[j].min;
      }
      if (kmSum > 0) {
        pacePts.push({x: dIdx, y: Math.round(((minSum*60)/kmSum)*10)/10});
        volPts.push({x: dIdx, y: Math.round((kmSum/30*7)*10)/10});
      }
    }

    const xTicks = { type:"linear", grid:{display:false}, ticks:{ callback: v => dayIdxToLabel(v) } };

    upsertChart("chartTrendPace", "line", {
      datasets: [{ label:"Pace", data: pacePts, borderColor:"#4a3aa7", backgroundColor:"#4a3aa7", borderWidth:1.5, pointRadius:0, tension:0.2 }]
    }, {
      plugins: { tooltip: { callbacks: { title: (items) => dayIdxToLabel(items[0].parsed.x), label: (ctx) => fmtPace(ctx.parsed.y) + " /km" } } },
      scales: { x: xTicks, y: { reverse:true, grid:{color:gridColor}, ticks:{callback:v=>fmtPace(v)} } }
    });

    upsertChart("chartTrendVol", "line", {
      datasets: [{ label:"Km/week", data: volPts, borderColor:"#2a78d6", backgroundColor:"rgba(42,120,214,0.1)", fill:true, borderWidth:1.5, pointRadius:0, tension:0.2 }]
    }, {
      plugins: { tooltip: { callbacks: { title: (items) => dayIdxToLabel(items[0].parsed.x), label: (ctx) => fmtKm(ctx.parsed.y) + " km/week" } } },
      scales: { x: xTicks, y: { beginAtZero:true, grid:{color:gridColor}, ticks:{callback:v=>v+" km"} } }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.trend = { render: renderTrend };
})();
