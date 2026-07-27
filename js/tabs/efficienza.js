// Efficiency tab: metres travelled per heartbeat, yearly trend + scatter plot.
(function () {
  const { filteredRuns, getSelectedYears, upsertChart, fmtPace, getGridColor, YEAR_COLORS } = window.RD.state;

  function validEfficiencyRun(r) {
    if (!Number.isFinite(r.hr) || r.hr <= 0 || !Number.isFinite(r.km) || r.km <= 0 || !Number.isFinite(r.min) || r.min <= 0) return false;
    const pace = (r.min * 60) / r.km;
    return r.hr >= 60 && r.hr <= 220 && pace >= 180 && pace <= 900;
  }

  function efficiencyMetersPerBeat(r) {
    return (r.km * 1000) / (r.hr * r.min);
  }

  function renderEfficienza() {
    const runs = filteredRuns().filter(validEfficiencyRun);
    const grid = document.getElementById("efficiencyKpiGrid");

    if (!runs.length) {
      grid.innerHTML = `
        <div class="kpicard"><p class="label">Eligible runs</p><p class="value">0</p></div>
        <div class="kpicard"><p class="label">Average efficiency</p><p class="value">—</p></div>`;
      upsertChart("chartEfficiencyYear", "line", {labels:[], datasets:[]}, {});
      upsertChart("chartEfficiencyScatter", "scatter", {datasets:[]}, {});
      document.getElementById("efficiencyLegend").innerHTML = "";
      return;
    }

    const totalKm = runs.reduce((s,r)=>s+r.km,0);
    const totalMin = runs.reduce((s,r)=>s+r.min,0);
    const totalBeats = runs.reduce((s,r)=>s+(r.hr*r.min),0);
    const efficiency = (totalKm*1000)/totalBeats;
    const weightedHr = runs.reduce((s,r)=>s+(r.hr*r.min),0)/totalMin;
    const pace = (totalMin*60)/totalKm;

    grid.innerHTML = `
      <div class="kpicard"><p class="label">Average efficiency</p><p class="value">${efficiency.toFixed(2)} m/heartbeat</p></div>
      <div class="kpicard"><p class="label">Runs analysed</p><p class="value">${runs.length}</p></div>
      <div class="kpicard"><p class="label">Average pace</p><p class="value">${fmtPace(pace)} /km</p></div>
      <div class="kpicard"><p class="label">Weighted average HR</p><p class="value">${weightedHr.toFixed(0)} bpm</p></div>`;

    const years = [...getSelectedYears()].sort((a,b)=>a-b);
    const yearly = years.map(y => {
      const yr = runs.filter(r=>r.y===y);
      if (!yr.length) return null;
      const metres = yr.reduce((s,r)=>s+r.km*1000,0);
      const beats = yr.reduce((s,r)=>s+r.hr*r.min,0);
      return {year:y, value:metres/beats, count:yr.length};
    }).filter(Boolean);

    upsertChart("chartEfficiencyYear", "line", {
      labels: yearly.map(d=>d.year),
      datasets: [{
        label:"Metres per heartbeat",
        data: yearly.map(d=>d.value),
        borderColor:"#0f6e56",
        backgroundColor:"#0f6e56",
        borderWidth:2,
        pointRadius:4,
        tension:0.2
      }]
    }, {
      plugins:{
        tooltip:{callbacks:{label:(ctx)=>`${ctx.parsed.y.toFixed(2)} m/heartbeat · ${yearly[ctx.dataIndex].count} runs`}}
      },
      scales:{
        x:{grid:{display:false}},
        y:{grid:{color:getGridColor()}, ticks:{callback:v=>Number(v).toFixed(2)+" m"}}
      }
    });

    const availableYears = years.filter(y=>runs.some(r=>r.y===y));
    document.getElementById("efficiencyLegend").innerHTML = availableYears.map(y =>
      `<span><span class="sw" style="background:${YEAR_COLORS[y] || '#2a78d6'}"></span>${y}</span>`
    ).join("");

    const scatterDatasets = availableYears.map(y => ({
      label:String(y),
      data:runs.filter(r=>r.y===y).map(r=>({
        x:r.hr,
        y:(r.min*60)/r.km,
        date:r.d,
        km:r.km,
        efficiency:efficiencyMetersPerBeat(r)
      })),
      backgroundColor:YEAR_COLORS[y] || "#2a78d6",
      borderColor:YEAR_COLORS[y] || "#2a78d6",
      pointRadius:4,
      pointHoverRadius:7
    }));

    upsertChart("chartEfficiencyScatter", "scatter", {datasets:scatterDatasets}, {
      parsing:false,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{
          title:(items)=>items.length ? `${items[0].raw.date} · ${items[0].dataset.label}` : "",
          label:(ctx)=>[
            `${ctx.raw.km.toFixed(1)} km · ${fmtPace(ctx.raw.y)} /km`,
            `${ctx.raw.x.toFixed(0)} bpm · ${ctx.raw.efficiency.toFixed(2)} m/heartbeat`
          ]
        }}
      },
      scales:{
        x:{
          type:"linear",
          title:{display:true,text:"Average heart rate (bpm)"},
          grid:{color:getGridColor()},
          ticks:{callback:v=>v+" bpm"}
        },
        y:{
          reverse:true,
          title:{display:true,text:"Average pace (min/km)"},
          grid:{color:getGridColor()},
          ticks:{callback:v=>fmtPace(v)}
        }
      }
    });
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.efficienza = { render: renderEfficienza };
})();
