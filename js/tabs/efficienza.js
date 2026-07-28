// Efficiency tab: metres travelled per heartbeat, yearly trend + scatter
// plot against heart rate. Redesigned to be analytical rather than
// instructional (Efficiency_Tab_Product_Design_Specification_Detailed.pdf):
// no banner, no side explanatory panel, no per-year legend on the scatter.
// Benchmark logic is automatic — the most recently selected year is the
// evaluation year, every other selected year is the historical benchmark —
// so there is no duplicate "reference year" selector inside the page.
(function () {
  const { filteredRuns, getSelectedYears, getAllYears, upsertChart, fmtPace, fmtDate, runDateToLocalTime, getGridColor } = window.RD.state;

  function validEfficiencyRun(r) {
    if (!Number.isFinite(r.hr) || r.hr <= 0 || !Number.isFinite(r.km) || r.km <= 0 || !Number.isFinite(r.min) || r.min <= 0) return false;
    const pace = (r.min * 60) / r.km;
    return r.hr >= 60 && r.hr <= 220 && pace >= 180 && pace <= 900;
  }
  function efficiencyMetersPerBeat(r) { return (r.km * 1000) / (r.hr * r.min); }
  function paceSecondsOf(r) { return (r.min * 60) / r.km; }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
  function percentileOf(values, p) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length-1)*p, lo = Math.floor(pos), hi = Math.ceil(pos), w = pos-lo;
    return sorted[lo] + (sorted[hi]-sorted[lo])*w;
  }
  // "Contiguous" is judged against the years that actually exist in the
  // dataset, not against raw consecutive integers: this dataset has no
  // 2019 runs at all, so a plain integer-gap check would wrongly treat
  // "all years" as a sparse selection and print every single year out
  // (e.g. "2014/2015/.../2025") instead of a clean "2014–2025" range.
  // A real gap the user deliberately introduced (e.g. picking
  // 2020 and 2024 while skipping 2021-2023, which DO have data) still
  // falls back to the explicit list, since a range there would imply
  // data that isn't actually included.
  function formatYearList(years, allYears) {
    if (!years.length) return "";
    if (years.length === 1) return String(years[0]);
    const min = years[0], max = years[years.length-1];
    const available = (allYears && allYears.length)
      ? allYears.filter(y => y >= min && y <= max).slice().sort((a,b)=>a-b)
      : years;
    const isContiguous = available.length === years.length && available.every((y,i)=>y===years[i]);
    return isContiguous ? `${min}–${max}` : years.join("/");
  }

  // ---- Automatic benchmark logic (memo section 6): the most recent
  // selected year is the evaluation year; every other selected year is
  // historical benchmark. No separate "reference year" selector in the UI. ----
  function splitBenchmark(sortedYears) {
    if (!sortedYears.length) return { evaluationYear: null, benchmarkYears: [] };
    return { evaluationYear: sortedYears[sortedYears.length-1], benchmarkYears: sortedYears.slice(0, -1) };
  }

  // ---- Minimal LOESS (locally weighted regression) with an approximate
  // confidence band: tricube-weighted local linear regression, with the
  // band derived from the local weighted residual spread. This is a
  // hand-rolled approximation, not a statistics-package LOESS, chosen so
  // the page doesn't need a new external charting dependency for one
  // curve. Good enough to visualise "expected pace for a given HR". ----
  function tricube(u) { const a = 1 - Math.pow(Math.min(1, Math.abs(u)), 3); return a > 0 ? Math.pow(a, 3) : 0; }
  function weightedLinearFit(xs, ys, ws) {
    let sw=0, swx=0, swy=0, swxx=0, swxy=0;
    for (let i=0;i<xs.length;i++){ const w=ws[i]; sw+=w; swx+=w*xs[i]; swy+=w*ys[i]; swxx+=w*xs[i]*xs[i]; swxy+=w*xs[i]*ys[i]; }
    if (!(sw>0)) return { slope:0, intercept:0 };
    const denom = sw*swxx - swx*swx;
    if (Math.abs(denom) < 1e-9) return { slope:0, intercept: swy/sw };
    const slope = (sw*swxy - swx*swy) / denom;
    return { slope, intercept: (swy - slope*swx) / sw };
  }
  function computeLoess(points, span, gridSize) {
    span = span || 0.4; gridSize = gridSize || 36;
    const pts = points.filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)).slice().sort((a,b)=>a.x-b.x);
    const n = pts.length;
    if (n < 6) return null;
    const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
    const minX=xs[0], maxX=xs[n-1];
    if (!(maxX>minX)) return null;
    const windowCount = Math.max(4, Math.round(span*n));
    const curve=[], upper=[], lower=[];
    for (let g=0; g<gridSize; g++) {
      const evalX = minX + (maxX-minX)*g/(gridSize-1);
      const dists = xs.map(x=>Math.abs(x-evalX));
      const bandwidth = dists.slice().sort((a,b)=>a-b)[Math.min(windowCount, n-1)] || 1;
      const ws = dists.map(d=>tricube(d/bandwidth));
      const { slope, intercept } = weightedLinearFit(xs, ys, ws);
      const fitted = slope*evalX + intercept;
      let sw=0, swr2=0;
      for (let i=0;i<n;i++){ if(ws[i]<=0) continue; const resid=ys[i]-(slope*xs[i]+intercept); sw+=ws[i]; swr2+=ws[i]*resid*resid; }
      const variance = sw>0 ? swr2/sw : 0;
      const se = Math.sqrt(variance) * 1.96 / Math.sqrt(Math.max(1, sw));
      curve.push({x:evalX, y:fitted});
      upper.push({x:evalX, y:fitted+se});
      lower.push({x:evalX, y:fitted-se});
    }
    return { curve, upper, lower };
  }

  // ---- Info icons + modal (replace the old banner / side panel / notes:
  // memo section 9 + acceptance criteria "explanatory text is replaced by
  // contextual information icons"). ----
  const INFO_CONTENT = {
    avgEfficiency: { title:"Average efficiency", body:"Efficiency is distance travelled per heartbeat: total kilometres × 1000, divided by total heartbeats (average HR × moving time), across every eligible run in the current selection. Higher values mean you cover more distance for the same cardiac effort. Only runs with valid heart-rate data are included." },
    avgPace: { title:"Average pace", body:"Average pace weighted by moving time across every eligible run in the current selection." },
    weightedHr: { title:"Weighted average HR", body:"Average heart rate weighted by moving time across every eligible run in the current selection." },
    bestEfficiency: { title:"Best efficiency", body:"The single run with the highest metres-per-heartbeat value in the current selection, shown with its date, pace and average HR." },
    yearlyChart: { title:"Yearly efficiency trend", body:"Weighted average efficiency per calendar year. The shaded band shows the 25th–75th percentile spread of individual runs within that year: a wider band means more run-to-run variability that year." },
    scatterChart: { title:"Pace vs average heart rate", body:"Each point is one run: pace against average heart rate. Grey points are the benchmark years; blue points are the most recently selected year. The green curve is a local regression (LOESS, approximate) fitted on the benchmark years only, with an approximate 95% band — it shows the pace/HR relationship expected from history, so points above or below it ran slower or faster than expected for that heart rate. Click a point to open its Run Details." },
  };
  function openInfoModal(key) {
    const info = INFO_CONTENT[key]; if (!info) return;
    const overlay = document.getElementById("efficiencyInfoModal"); if (!overlay) return;
    const titleEl = document.getElementById("efficiencyInfoModalTitle");
    const bodyEl = document.getElementById("efficiencyInfoModalBody");
    if (titleEl) titleEl.textContent = info.title;
    if (bodyEl) bodyEl.textContent = info.body;
    overlay.classList.add("open");
  }
  function closeInfoModal() {
    const overlay = document.getElementById("efficiencyInfoModal");
    if (overlay) overlay.classList.remove("open");
  }
  let modalWired = false;
  function wireInfoModalOnce() {
    if (modalWired) return;
    const overlay = document.getElementById("efficiencyInfoModal"); if (!overlay) return;
    modalWired = true;
    overlay.addEventListener("click", e => { if (e.target === overlay) closeInfoModal(); });
    const closeBtn = document.getElementById("efficiencyInfoModalClose");
    if (closeBtn && closeBtn.addEventListener) closeBtn.addEventListener("click", closeInfoModal);
    if (document.addEventListener) document.addEventListener("keydown", e => { if (e && e.key === "Escape") closeInfoModal(); });
  }
  function wireInfoIcons() {
    document.querySelectorAll(".info-icon-btn").forEach(btn => { btn.onclick = () => openInfoModal(btn.dataset.info); });
  }

  // ---- Canvas plugin: draws the year-over-year % change above each point
  // on the yearly trend line, plus a short neutral, data-derived callout on
  // the single largest gain/drop (never a speculative real-world cause like
  // "COVID" or "marathon prep" — we only know the numbers, not the story
  // behind them). Registered once, globally; it is a no-op for every other
  // chart because it only acts on datasets carrying a "pctLabels" array. ----
  let pluginRegistered = false;
  function registerYearlyLabelsPlugin() {
    if (pluginRegistered || typeof Chart === "undefined" || !Chart.register) return;
    pluginRegistered = true;
    Chart.register({
      id: "efficiencyYearlyLabels",
      afterDatasetsDraw(chart) {
        const ds = chart.data && chart.data.datasets && chart.data.datasets[0];
        if (!ds || !ds.pctLabels) return;
        const meta = chart.getDatasetMeta(0);
        if (!meta || !meta.data) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.textAlign = "center";
        meta.data.forEach((point, i) => {
          const label = ds.pctLabels[i]; if (!label) return;
          ctx.font = "600 11px sans-serif";
          ctx.fillStyle = label.color;
          ctx.fillText(label.text, point.x, point.y - 14);
          if (label.callout) {
            ctx.font = "500 9px sans-serif";
            ctx.fillStyle = "#898781";
            ctx.fillText(label.callout, point.x, point.y - 26);
          }
        });
        ctx.restore();
      },
    });
  }

  function renderEfficienza() {
    wireInfoModalOnce();
    registerYearlyLabelsPlugin();

    const runs = filteredRuns().filter(validEfficiencyRun);
    const grid = document.getElementById("efficiencyKpiGrid");
    const legendEl = document.getElementById("efficiencyLegend");

    if (!runs.length) {
      grid.innerHTML = `
        <div class="kpicard"><p class="label">Average efficiency</p><p class="value">—</p></div>
        <div class="kpicard"><p class="label">Average pace</p><p class="value">—</p></div>
        <div class="kpicard"><p class="label">Weighted average HR</p><p class="value">—</p></div>
        <div class="kpicard"><p class="label">Best efficiency</p><p class="value">—</p></div>`;
      upsertChart("chartEfficiencyYear", "line", {labels:[], datasets:[]}, {});
      upsertChart("chartEfficiencyScatter", "scatter", {datasets:[]}, {});
      if (legendEl) legendEl.innerHTML = "";
      wireInfoIcons();
      return;
    }

    const totalKm = runs.reduce((s,r)=>s+r.km,0);
    const totalMin = runs.reduce((s,r)=>s+r.min,0);
    const totalBeats = runs.reduce((s,r)=>s+(r.hr*r.min),0);
    const efficiency = (totalKm*1000)/totalBeats;
    const weightedHr = totalBeats/totalMin;
    const pace = (totalMin*60)/totalKm;
    const best = runs.reduce((b,r)=>{ const e=efficiencyMetersPerBeat(r); return (!b||e>b.e) ? {r,e} : b; }, null);

    const sortedYears = [...getSelectedYears()].sort((a,b)=>a-b);
    const { evaluationYear, benchmarkYears } = splitBenchmark(sortedYears);
    const hasBenchmark = benchmarkYears.length > 0;

    function yearStats(yearsSubset) {
      const subset = runs.filter(r => yearsSubset.includes(r.y));
      if (!subset.length) return null;
      const km = subset.reduce((s,r)=>s+r.km,0);
      const min = subset.reduce((s,r)=>s+r.min,0);
      const beats = subset.reduce((s,r)=>s+r.hr*r.min,0);
      return { efficiency:(km*1000)/beats, pace:(min*60)/km, hr:beats/min };
    }
    const evalStats = evaluationYear!==null ? yearStats([evaluationYear]) : null;
    const benchStats = hasBenchmark ? yearStats(benchmarkYears) : null;

    let effCompare = "", paceCompare = "", hrCompare = "";
    if (evalStats && benchStats) {
      const benchLabel = formatYearList(benchmarkYears, getAllYears());
      const effPct = ((evalStats.efficiency - benchStats.efficiency) / benchStats.efficiency) * 100;
      const paceDiff = Math.round(evalStats.pace - benchStats.pace);
      const hrDiff = Math.round(evalStats.hr - benchStats.hr);
      effCompare = `${effPct>=0?"+":""}${effPct.toFixed(1)}% vs ${benchLabel} avg`;
      paceCompare = `${paceDiff>=0?"+":""}${paceDiff} sec vs ${benchLabel} avg`;
      hrCompare = `${hrDiff>=0?"+":""}${hrDiff} bpm vs ${benchLabel} avg`;
    }

    grid.innerHTML = `
      <div class="kpicard">
        <p class="label kpi-label-row"><span>Average efficiency</span><button class="info-icon-btn" data-info="avgEfficiency" type="button" aria-label="About average efficiency">i</button></p>
        <p class="value kpi-value-green">${efficiency.toFixed(2)} m/heartbeat</p>
        ${effCompare ? `<p class="kpi-compare kpi-value-green">${escapeHtml(effCompare)}</p>` : ""}
      </div>
      <div class="kpicard">
        <p class="label kpi-label-row"><span>Average pace</span><button class="info-icon-btn" data-info="avgPace" type="button" aria-label="About average pace">i</button></p>
        <p class="value kpi-value-blue">${fmtPace(pace)} /km</p>
        ${paceCompare ? `<p class="kpi-compare kpi-value-blue">${escapeHtml(paceCompare)}</p>` : ""}
      </div>
      <div class="kpicard">
        <p class="label kpi-label-row"><span>Weighted average HR</span><button class="info-icon-btn" data-info="weightedHr" type="button" aria-label="About weighted average HR">i</button></p>
        <p class="value kpi-value-red">${weightedHr.toFixed(0)} bpm</p>
        ${hrCompare ? `<p class="kpi-compare kpi-value-red">${escapeHtml(hrCompare)}</p>` : ""}
      </div>
      <div class="kpicard">
        <p class="label kpi-label-row"><span>Best efficiency</span><button class="info-icon-btn" data-info="bestEfficiency" type="button" aria-label="About best efficiency">i</button></p>
        <p class="value">${best ? best.e.toFixed(2)+" m/heartbeat" : "—"}</p>
        ${best ? `<p class="kpi-compare">${escapeHtml(fmtDate(new Date(runDateToLocalTime(best.r.d))))} · ${fmtPace(paceSecondsOf(best.r))} /km · ${Math.round(best.r.hr)} bpm</p>` : ""}
      </div>`;
    wireInfoIcons();

    /* ---------- Yearly efficiency trend + variability band + %-change labels ---------- */
    const yearly = sortedYears.map(y => {
      const yr = runs.filter(r=>r.y===y);
      if (!yr.length) return null;
      const metres = yr.reduce((s,r)=>s+r.km*1000,0);
      const beats = yr.reduce((s,r)=>s+r.hr*r.min,0);
      const perRunEfficiency = yr.map(efficiencyMetersPerBeat);
      return {
        year: y, value: metres/beats, count: yr.length,
        p25: percentileOf(perRunEfficiency, 0.25),
        p75: percentileOf(perRunEfficiency, 0.75),
      };
    }).filter(Boolean);

    const pctLabels = yearly.map((d,i) => {
      if (i===0) return { text:"+0.0%", color:"#898781" };
      const pct = ((d.value - yearly[i-1].value) / yearly[i-1].value) * 100;
      return { text:`${pct>=0?"+":""}${pct.toFixed(1)}%`, color: pct>=0 ? "#22c55e" : "#ef4444", pct };
    });
    // Flag the single largest gain and single largest drop (magnitude >5%)
    // with a neutral, data-derived callout — never a guessed real-world
    // cause we can't verify from the numbers alone.
    const withPct = pctLabels.map((l,i)=>({...l, i})).filter(l => l.i>0 && Number.isFinite(l.pct));
    if (withPct.length) {
      const biggestGain = withPct.reduce((b,l)=> !b||l.pct>b.pct ? l : b, null);
      const biggestDrop = withPct.reduce((b,l)=> !b||l.pct<b.pct ? l : b, null);
      if (biggestGain && biggestGain.pct > 5) pctLabels[biggestGain.i].callout = "Biggest year-over-year gain";
      if (biggestDrop && biggestDrop.pct < -5 && biggestDrop.i !== biggestGain?.i) pctLabels[biggestDrop.i].callout = "Biggest year-over-year drop";
    }

    const yearlyDataset = {
      label: "Metres per heartbeat",
      data: yearly.map(d=>d.value),
      borderColor: "#0f6e56", backgroundColor: "#0f6e56",
      borderWidth: 2, pointRadius: 4, tension: 0.2, order: 0,
      pctLabels,
    };
    const bandLower = { label:"__bandLower", data: yearly.map(d=>d.p25), borderColor:"rgba(137,135,129,0)", backgroundColor:"rgba(137,135,129,0)", borderWidth:0, pointRadius:0, tension:0.2, fill:false, order:20 };
    const bandUpper = { label:"__bandUpper", data: yearly.map(d=>d.p75), borderColor:"rgba(137,135,129,0)", backgroundColor:"rgba(137,135,129,.16)", borderWidth:0, pointRadius:0, tension:0.2, fill:"-1", order:19 };

    upsertChart("chartEfficiencyYear", "line", {
      labels: yearly.map(d=>d.year),
      datasets: [bandLower, bandUpper, yearlyDataset],
    }, {
      plugins: {
        tooltip: {
          filter: ctx => ctx.dataset.label === "Metres per heartbeat",
          callbacks: { label: ctx => `${ctx.parsed.y.toFixed(2)} m/heartbeat · ${yearly[ctx.dataIndex].count} runs` },
        },
      },
      scales: {
        x: { grid:{display:false} },
        y: { grid:{color:getGridColor()}, ticks:{callback:v=>Number(v).toFixed(2)+" m"} },
      },
    });

    /* ---------- Scatter plot: benchmark (grey) vs evaluation year (blue),
       LOESS (green) + confidence band on benchmark years only ---------- */
    function toPoint(r) {
      return {
        x: r.hr, y: paceSecondsOf(r),
        date: r.d, km: r.km, id: r.id,
        location: [r.location_city, r.location_country].filter(Boolean).join(", ") || "—",
        efficiency: efficiencyMetersPerBeat(r),
      };
    }
    const benchmarkRuns = hasBenchmark ? runs.filter(r=>benchmarkYears.includes(r.y)) : [];
    const evaluationRuns = evaluationYear!==null ? runs.filter(r=>r.y===evaluationYear) : [];

    const scatterDatasets = [];
    let loessOrderSlot = null;
    if (hasBenchmark) {
      const loess = computeLoess(benchmarkRuns.map(r=>({x:r.hr, y:paceSecondsOf(r)})));
      if (loess) {
        scatterDatasets.push({ label:"__bandLower", data:loess.lower, type:"line", showLine:true, borderColor:"rgba(137,135,129,0)", backgroundColor:"rgba(137,135,129,0)", borderWidth:0, pointRadius:0, fill:false, order:20, tension:0.15 });
        scatterDatasets.push({ label:"__bandUpper", data:loess.upper, type:"line", showLine:true, borderColor:"rgba(137,135,129,0)", backgroundColor:"rgba(137,135,129,.18)", borderWidth:0, pointRadius:0, fill:"-1", order:19, tension:0.15 });
        scatterDatasets.push({ label:"Trend (LOESS)", data:loess.curve, type:"line", showLine:true, borderColor:"#22c55e", backgroundColor:"#22c55e", borderWidth:2, pointRadius:0, fill:false, order:15, tension:0.15 });
      }
    }
    if (hasBenchmark) {
      scatterDatasets.push({ label:`Other years (${formatYearList(benchmarkYears, getAllYears())})`, data: benchmarkRuns.map(toPoint), backgroundColor:"rgba(137,135,129,.55)", borderColor:"rgba(137,135,129,.55)", pointRadius:4, pointHoverRadius:7, order:10 });
    }
    if (evaluationRuns.length) {
      scatterDatasets.push({ label:`${evaluationYear} (selected year)`, data: evaluationRuns.map(toPoint), backgroundColor:"#2a78d6", borderColor:"#2a78d6", pointRadius:4, pointHoverRadius:7, order:5 });
    }

    upsertChart("chartEfficiencyScatter", "scatter", { datasets: scatterDatasets }, {
      parsing: false,
      plugins: {
        legend: { display:false },
        tooltip: {
          filter: ctx => !String(ctx.dataset.label||"").startsWith("__") && ctx.dataset.label !== "Trend (LOESS)",
          callbacks: {
            title: items => items.length ? `${items[0].raw.date} · ${items[0].raw.location}` : "",
            label: ctx => [
              `${ctx.raw.km.toFixed(1)} km · ${fmtPace(ctx.raw.y)} /km`,
              `${ctx.raw.x.toFixed(0)} bpm · ${ctx.raw.efficiency.toFixed(2)} m/heartbeat`,
              "Click to open Run Details",
            ],
          },
        },
      },
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const el = elements[0];
        const ds = scatterDatasets[el.datasetIndex];
        const point = ds && ds.data && ds.data[el.index];
        if (!point || point.id === undefined || point.id === null) return;
        if (window.RD.activateTab) window.RD.activateTab("runs");
        if (window.RD.tabs && window.RD.tabs.runs && window.RD.tabs.runs.selectRunById) window.RD.tabs.runs.selectRunById(point.id);
      },
      scales: {
        x: { type:"linear", title:{display:true,text:"Average heart rate (bpm)"}, grid:{color:getGridColor()}, ticks:{callback:v=>v+" bpm"} },
        y: { reverse:true, title:{display:true,text:"Average pace (min/km)"}, grid:{color:getGridColor()}, ticks:{callback:v=>fmtPace(v)} },
      },
    });

    if (legendEl) {
      const items = [];
      if (hasBenchmark) items.push({ color:"rgba(137,135,129,.7)", label:`Other years (${formatYearList(benchmarkYears, getAllYears())})` });
      if (evaluationRuns.length) items.push({ color:"#2a78d6", label:`${evaluationYear} (selected year)` });
      if (hasBenchmark) {
        items.push({ color:"#22c55e", label:"Trend (LOESS)" });
        items.push({ color:"rgba(137,135,129,.4)", label:"95% confidence band" });
      }
      legendEl.innerHTML = items.map(it => `<span><span class="sw" style="background:${it.color}"></span>${escapeHtml(it.label)}</span>`).join("");
    }
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.efficienza = { render: renderEfficienza };
})();
