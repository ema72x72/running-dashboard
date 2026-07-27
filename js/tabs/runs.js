// Runs tab: browse every historical run, its GPS route, splits and insights.
(function () {
  const { filteredRuns, getRuns, runDateToLocalTime, fetchJson, fmtPace, gridColor, dirty } = window.RD.state;

  let selectedRunId = null;
  let runTrackCache = new Map();
  let runDetailMap = null;
  let runRouteLayer = null;
  let runMarkersLayer = null;
  let runHoverMarker = null;
  let runDetailChart = null;
  let runMetric = "pace";

  function runTimestamp(run) {
    const value = run.start_local || `${run.d}T12:00:00`;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? runDateToLocalTime(run.d) : parsed.getTime();
  }
  function sortedSelectableRuns() {
    return filteredRuns().slice().sort((a,b)=>runTimestamp(b)-runTimestamp(a));
  }
  function trackPath(run) {
    if (!run) return null;
    if (run.track_file) return run.track_file;
    if (run.id !== null && run.id !== undefined && String(run.id).trim()) return `data/tracks/${String(run.id).trim()}.json`;
    return null;
  }
  function runLabel(run) {
    const distance = Number(run.km || 0).toLocaleString("en-IT",{maximumFractionDigits:2});
    return `${run.d} · ${distance} km · ${run.name || "Run"}`;
  }
  async function loadRunTrack(run) {
    const path=trackPath(run);
    if (!path) return null;
    if (runTrackCache.has(path)) return runTrackCache.get(path);
    const track = await fetchJson(path);
    runTrackCache.set(path, track);
    return track;
  }
  function runLocation(run) {
    return [run.location_city, run.location_state, run.location_country].filter(Boolean).join(", ") || "Location unavailable";
  }
  function runStartText(run) {
    const date = new Date(run.start_local || `${run.d}T12:00:00`);
    if (Number.isNaN(date.getTime())) return run.d;
    return new Intl.DateTimeFormat("en-IT",{weekday:"long",day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(date);
  }
  function detailValue(value, suffix="", digits=0) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return `${Number(value).toLocaleString("en-IT",{maximumFractionDigits:digits})}${suffix}`;
  }
  function paceSecondsFromRun(run) { return run.km > 0 ? run.min * 60 / run.km : null; }
  function buildRunShell(run, index, runs) {
    const pace = paceSecondsFromRun(run);
    const latest = index === 0 ? '<span class="run-badge">Last run</span>' : '';
    return `
      <div class="run-hero">
        <div class="run-titleline"><div><h2 class="run-title">${escapeHtml(run.name || "Run")}</h2><p class="run-subtitle">${escapeHtml(runStartText(run))}<br>${escapeHtml(runLocation(run))}</p></div>${latest}</div>
        <div class="run-topmetrics">
          <div class="run-topmetric"><strong>${detailValue(run.km,"",2)}</strong><span>km</span></div>
          <div class="run-topmetric"><strong>${formatDuration(run.min)}</strong><span>Moving time</span></div>
          <div class="run-topmetric"><strong>${pace ? fmtPace(pace) : "—"}</strong><span>Average pace /km</span></div>
          <div class="run-topmetric"><strong>${detailValue(run.hr)}</strong><span>Average HR bpm</span></div>
        </div>
      </div>
      <div class="run-nav">
        <button id="previousRunBtn" ${index >= runs.length-1 ? "disabled" : ""}>‹ Previous</button>
        <span class="run-nav-date">${escapeHtml(run.d)}</span>
        <button id="nextRunBtn" ${index <= 0 ? "disabled" : ""}>Next ›</button>
      </div>
      <div class="run-map-card">
        <div id="runDetailMap"></div>
        <div class="run-map-toolbar"><span class="chartlabel" style="margin:0">Colour route by</span><div class="metric-toggle" id="routeMetricToggle">
          <button data-metric="pace" class="active">Pace</button><button data-metric="hr">Heart rate</button><button data-metric="elevation">Elevation</button><button data-metric="cadence">Cadence</button>
        </div></div>
      </div>
      <div class="run-panel"><div class="run-detail-grid">
        ${runDetailCell("Distance",detailValue(run.km," km",2))}
        ${runDetailCell("Moving time",formatDuration(run.min))}
        ${runDetailCell("Average pace",pace ? `${fmtPace(pace)} /km` : "—")}
        ${runDetailCell("Average HR",detailValue(run.hr," bpm"))}
        ${runDetailCell("Maximum HR",detailValue(run.mhr," bpm"))}
        ${runDetailCell("Cadence",detailValue(run.cad," spm"))}
        ${runDetailCell("Elevation gain",detailValue(run.elev," m",1))}
        ${runDetailCell("Calories",detailValue(run.calories," Cal"))}
      </div></div>
      <div class="run-analysis-grid">
        <div class="run-panel"><div class="run-panel-inner"><p class="run-panel-title">Performance over time</p><div class="chartwrap" style="height:270px;margin:0"><canvas id="runPerformanceChart"></canvas></div></div></div>
        <div class="run-panel"><div class="run-panel-inner"><p class="run-panel-title">Splits</p><div id="runSplits"></div></div></div>
      </div>
      <div class="run-panel run-insights"><p class="run-panel-title">Insights</p><ul id="runInsights"></ul><button class="compare-btn" id="compareSimilarBtn">⇄ Compare with a similar run</button><div class="compare-result" id="compareResult"></div></div>`;
  }
  function runDetailCell(label,value) { return `<div class="run-detail-item"><span>${label}</span><strong>${value}</strong></div>`; }
  function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }
  function formatDuration(minutes) {
    if (!Number.isFinite(Number(minutes))) return "—";
    const seconds=Math.round(Number(minutes)*60), h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60), s=seconds%60;
    return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
  }
  function metricValue(point, previous, metric) {
    if (metric === "hr") return Number(point.hr);
    if (metric === "elevation") return Number(point.alt);
    if (metric === "cadence") return Number(point.cad);
    // Prefer Strava's smoothed velocity stream. One-second distance deltas can be
    // nearly zero during GPS jitter and create impossible pace spikes.
    const velocity=Number(point.v);
    if(Number.isFinite(velocity) && velocity>0){
      const pace=1000/velocity;
      return pace>=150 && pace<=900 ? pace : NaN; // 2:30–15:00 /km
    }
    if (!previous || !Number.isFinite(point.m) || !Number.isFinite(previous.m) || !Number.isFinite(point.t) || !Number.isFinite(previous.t)) return NaN;
    const dm=point.m-previous.m, dt=point.t-previous.t;
    if(dm<2 || dt<=0) return NaN;
    const pace=dt/(dm/1000);
    return pace>=150 && pace<=900 ? pace : NaN;
  }
  function movingAverage(values, radius=7) {
    const out=[];
    for(let i=0;i<values.length;i++){
      let sum=0,count=0;
      for(let j=Math.max(0,i-radius);j<=Math.min(values.length-1,i+radius);j++){
        const value=values[j]; if(Number.isFinite(value)){ sum+=value; count++; }
      }
      out.push(count?sum/count:NaN);
    }
    return out;
  }
  function metricSeries(track, metric) {
    const points=(track?.points||[]), raw=[];
    for(let i=0;i<points.length;i++) raw.push(metricValue(points[i],points[i-1],metric));
    const values=(metric==="pace"||metric==="hr"||metric==="cadence")?movingAverage(raw,7):raw;
    return points.map((point,index)=>({point,value:values[index]}));
  }
  function metricPalette(metric) {
    if(metric==="hr") return ["#2563eb","#22c55e","#eab308","#f97316","#ef4444"];
    if(metric==="elevation") return ["#164e63","#0891b2","#22c55e","#eab308","#f97316"];
    if(metric==="cadence") return ["#7c3aed","#2563eb","#22c55e","#eab308","#ef4444"];
    return ["#ef4444","#f97316","#eab308","#22c55e","#2563eb"];
  }
  function quantile(values,q) {
    if(!values.length) return 0; const sorted=values.slice().sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))];
  }
  function segmentColour(value, breaks, palette, metric) {
    let index=0; while(index<breaks.length && value>breaks[index]) index++;
    if(metric==="pace") index=palette.length-1-index;
    return palette[Math.max(0,Math.min(palette.length-1,index))];
  }
  function renderDetailedMap(track) {
    const element = document.getElementById("runDetailMap");
    if (!element) return;
    try {
      if (runDetailMap) { runDetailMap.remove(); runDetailMap = null; }
      runHoverMarker = null;
      runDetailMap = L.map(element, {zoomControl:true});
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution:"&copy; OpenStreetMap &copy; CARTO", maxZoom:20
      }).addTo(runDetailMap);

      const points = Array.isArray(track?.points)
        ? track.points.filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
        : [];

      if (points.length < 2) {
        runDetailMap.setView([20,0],2);
        L.popup().setLatLng([20,0]).setContent("Detailed route unavailable for this run.").openOn(runDetailMap);
        return;
      }

      // Draw one reliable base route first. This prevents a colouring error from
      // making the entire route disappear.
      const maxPoints = 1200;
      const step = Math.max(1, Math.ceil(points.length / maxPoints));
      const sampled = points.filter((_, i) => i % step === 0 || i === points.length - 1);
      const latlngs = sampled.map(p => [Number(p.lat), Number(p.lon)]);
      const route = L.polyline(latlngs, {color:"#2a78d6", weight:5, opacity:.95}).addTo(runDetailMap);

      L.circleMarker(latlngs[0], {radius:7,color:"#fff",weight:2,fillColor:"#22c55e",fillOpacity:1}).bindTooltip("Start").addTo(runDetailMap);
      L.circleMarker(latlngs[latlngs.length-1], {radius:7,color:"#fff",weight:2,fillColor:"#111827",fillOpacity:1}).bindTooltip("Finish").addTo(runDetailMap);
      runHoverMarker = L.circleMarker(latlngs[0], {radius:6,color:"#fff",weight:2,fillColor:"#fc4c02",fillOpacity:0,opacity:0,interactive:false}).addTo(runDetailMap);
      runDetailMap.fitBounds(route.getBounds(), {padding:[20,20]});
      setTimeout(() => runDetailMap && runDetailMap.invalidateSize(), 50);
    } catch (error) {
      console.error("Run map rendering failed", error);
      element.innerHTML = '<p class="run-empty">Map rendering failed. Open the browser console for details.</p>';
    }
  }
  function trackSeries(track, metric) {
    const data=[];
    metricSeries(track,metric).forEach(({point,value},index)=>{
      const x=Number(point.m)/1000;
      if(Number.isFinite(x)&&Number.isFinite(value)) data.push({x,y:value,pointIndex:index});
    });
    return data;
  }
  function showRunPoint(track, dataPoint) {
    if(!runDetailMap||!runHoverMarker||!dataPoint) return;
    const point=track?.points?.[dataPoint.pointIndex];
    if(!point||!Number.isFinite(point.lat)||!Number.isFinite(point.lon)) return;
    runHoverMarker.setLatLng([point.lat,point.lon]);
    runHoverMarker.setStyle({opacity:1,fillOpacity:1});
  }
  function renderRunChart(track) {
    const canvas=document.getElementById("runPerformanceChart"); if(!canvas) return;
    const data=trackSeries(track,runMetric); if(runDetailChart) runDetailChart.destroy();
    const label={pace:"Pace",hr:"Heart rate",elevation:"Elevation",cadence:"Cadence"}[runMetric]||runMetric;
    runDetailChart=new Chart(canvas,{type:"line",data:{datasets:[{data,borderColor:runMetric==="hr"?"#ef4444":"#2a78d6",borderWidth:2,pointRadius:0,tension:.28,spanGaps:true}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"nearest",intersect:false},onHover:(event,elements)=>{ if(elements.length) showRunPoint(track,data[elements[0].index]); else if(runHoverMarker) runHoverMarker.setStyle({opacity:0,fillOpacity:0}); },plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${label}: ${runMetric==="pace"?fmtPace(c.parsed.y):Math.round(c.parsed.y)}`}}},scales:{x:{type:"linear",title:{display:true,text:"km"},grid:{color:gridColor}},y:{reverse:runMetric==="pace",grid:{color:gridColor},ticks:{callback:v=>runMetric==="pace"?fmtPace(v):v}}}}});
  }
  function buildSplits(track) {
    const points=track?.points||[]; if(points.length<2) return [];
    const totalKm=(points[points.length-1].m||0)/1000, splits=[];
    for(let km=1;km<=Math.ceil(totalKm);km++){
      const end=points.find(p=>(p.m||0)>=Math.min(km,totalKm)*1000); const start=km===1?points[0]:points.find(p=>(p.m||0)>=(km-1)*1000);
      if(!end||!start) continue; const distance=(end.m-start.m)/1000, seconds=end.t-start.t;
      const slice=points.filter(p=>p.m>=start.m&&p.m<=end.m); const hrs=slice.map(p=>Number(p.hr)).filter(Number.isFinite); const alts=slice.map(p=>Number(p.alt)).filter(Number.isFinite);
      splits.push({km:km>totalKm?totalKm.toFixed(1):km,pace:distance>0?seconds/distance:null,hr:hrs.length?hrs.reduce((a,b)=>a+b,0)/hrs.length:null,elev:alts.length?alts[alts.length-1]-alts[0]:null});
    } return splits;
  }
  function renderSplits(track) {
    const target=document.getElementById("runSplits"), splits=buildSplits(track); if(!target) return;
    if(!splits.length){ target.innerHTML='<p class="empty">Split data unavailable</p>'; return; }
    target.innerHTML=`<table class="splits-table"><thead><tr><th>KM</th><th>Pace</th><th>HR</th><th>Elev.</th></tr></thead><tbody>${splits.map(s=>`<tr><td>${s.km}</td><td>${s.pace?fmtPace(s.pace):"—"}</td><td>${s.hr?Math.round(s.hr):"—"}</td><td>${s.elev===null?"—":`${s.elev>0?"+":""}${Math.round(s.elev)} m`}</td></tr>`).join("")}</tbody></table>`;
  }
  function renderRunInsights(run,track) {
    const target=document.getElementById("runInsights"); if(!target) return; const insights=[];
    const splits=buildSplits(track); if(splits.length>=4){ const half=Math.floor(splits.length/2), first=splits.slice(0,half).map(s=>s.pace).filter(Boolean), second=splits.slice(half).map(s=>s.pace).filter(Boolean); if(first.length&&second.length&&second.reduce((a,b)=>a+b,0)/second.length < first.reduce((a,b)=>a+b,0)/first.length) insights.push("Negative split: the second half was faster."); }
    const yearRuns=getRuns().filter(r=>r.y===run.y&&r.hr&&r.km>0); const efficiency=run.hr?run.km*1000/(run.hr*run.min):null; const avgEfficiency=yearRuns.length?yearRuns.reduce((sum,r)=>sum+r.km*1000/(r.hr*r.min),0)/yearRuns.length:null;
    if(efficiency&&avgEfficiency&&efficiency>avgEfficiency*1.05) insights.push("Cardiac efficiency was above your yearly average.");
    const yearlyPace=yearRuns.length?yearRuns.reduce((s,r)=>s+r.min,0)*60/yearRuns.reduce((s,r)=>s+r.km,0):null; const pace=paceSecondsFromRun(run); if(pace&&yearlyPace&&pace<yearlyPace) insights.push("Faster than your average pace for this year.");
    if(run.km>=15) insights.push("This run qualifies as a long run.");
    if(!insights.length) insights.push("Detailed insights will improve as more historical tracks are downloaded.");
    target.innerHTML=insights.map(x=>`<li>${escapeHtml(x)}</li>`).join("");
  }
  function bindRunControls(run,index,runs,track) {
    const prev=document.getElementById("previousRunBtn"), next=document.getElementById("nextRunBtn");
    if(prev) prev.onclick=()=>{ const target=runs[index+1]; if(target) selectRun(runKey(target)); };
    if(next) next.onclick=()=>{ const target=runs[index-1]; if(target) selectRun(runKey(target)); };
    document.querySelectorAll("#routeMetricToggle button").forEach(button=>button.onclick=()=>{ document.querySelectorAll("#routeMetricToggle button").forEach(b=>b.classList.remove("active")); button.classList.add("active"); runMetric=button.dataset.metric; renderDetailedMap(track); renderRunChart(track); });
    const compare=document.getElementById("compareSimilarBtn"); if(compare) compare.onclick=()=>compareSimilarRun(run,runs);
  }
  function runKey(run) { return run?.id || `${run?.d}-${run?.km}-${run?.min}`; }
  function selectRun(key) { selectedRunId=String(key); dirty.runs=true; renderRuns(); }
  function compareSimilarRun(run,runs) {
    const candidates=runs.filter(r=>runKey(r)!==runKey(run)); const target=document.getElementById("compareResult"); if(!target||!candidates.length)return;
    const similar=candidates.slice().sort((a,b)=>Math.abs(a.km-run.km)-Math.abs(b.km-run.km))[0]; const paceA=paceSecondsFromRun(run), paceB=paceSecondsFromRun(similar);
    target.style.display="block"; target.innerHTML=`Closest-distance run: <strong>${escapeHtml(similar.d)}</strong> · ${detailValue(similar.km," km",2)} · ${paceB?fmtPace(paceB):"—"}/km. ${paceA&&paceB?(paceA<paceB?"The selected run was faster.":"The comparison run was faster."):""}`;
  }
  async function renderSelectedRun(run,runs) {
    const content = document.getElementById("runDetailContent");
    const index = runs.findIndex(r => String(runKey(r)) === String(runKey(run)));
    content.innerHTML = buildRunShell(run,index,runs);

    // Navigation must work even if the track request or a renderer fails.
    bindRunControls(run,index,runs,null);

    let track = null;
    try {
      track = await loadRunTrack(run);
    } catch (error) {
      console.error("Track loading failed", trackPath(run), error);
    }

    // Render each component independently so one failure cannot blank the rest.
    try { renderDetailedMap(track); } catch (error) { console.error("Map failed", error); }
    try { renderRunChart(track); } catch (error) {
      console.error("Performance chart failed", error);
      const canvas = document.getElementById("runPerformanceChart");
      if (canvas?.parentElement) canvas.parentElement.innerHTML = '<p class="empty">Performance data could not be rendered.</p>';
    }
    try { renderSplits(track); } catch (error) {
      console.error("Splits failed", error);
      const target = document.getElementById("runSplits");
      if (target) target.innerHTML = '<p class="empty">Split data could not be rendered.</p>';
    }
    try { renderRunInsights(run,track); } catch (error) { console.error("Insights failed", error); }

    // Rebind metric controls with the loaded track.
    bindRunControls(run,index,runs,track);
  }
  function renderRuns() {
    const runs=sortedSelectableRuns(), selector=document.getElementById("runSelector"), content=document.getElementById("runDetailContent");
    if(!runs.length){ selector.innerHTML=""; content.innerHTML='<p class="run-empty">No runs match the selected years.</p>'; return; }
    if(!selectedRunId || !runs.some(r=>String(runKey(r))===String(selectedRunId))) selectedRunId=String(runKey(runs[0]));
    selector.innerHTML=runs.map(r=>`<option value="${escapeHtml(runKey(r))}" ${String(runKey(r))===String(selectedRunId)?"selected":""}>${escapeHtml(runLabel(r))}</option>`).join("");
    selector.onchange=()=>selectRun(selector.value);
    const run=runs.find(r=>String(runKey(r))===String(selectedRunId))||runs[0]; renderSelectedRun(run,runs);
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.runs = { render: renderRuns, getRunDetailMap: () => runDetailMap };
})();
