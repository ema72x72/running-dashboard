// Runs tab: browse every historical run, its GPS route, splits and insights.
(function () {
  const { filteredRuns, getRuns, runDateToLocalTime, fetchJson, fmtPace, getGridColor, dirty } = window.RD.state;

  let selectedRunId = null;
  let runTrackCache = new Map();
  let runDetailMap = null;
  let runHoverMarker = null;
  let runDetailChart = null;
  let runMetric = "pace";
  let currentTrack = null;
  let currentChartData = [];
  let currentRunsRef = [];
  let currentIndexRef = -1;
  let swipeWired = false;
  let pickerRuns = [];
  let pickerWired = false;

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
  function cityKey(run) { return (run.location_city || "").trim().toLowerCase(); }
  function pickerRowLabel(run) {
    const location = [run.location_city, run.location_country].filter(Boolean).join(", ") || "Location unavailable";
    const distance = Number(run.km || 0).toLocaleString("en-IT",{maximumFractionDigits:2});
    return { date: run.d, distance: `${distance} km`, location, name: run.name || "Run" };
  }
  function pickerSearchText(run) {
    return [run.d, run.location_city, run.location_state, run.location_country, run.name].filter(Boolean).join(" ").toLowerCase();
  }
  async function loadRunTrack(run) {
    const path=trackPath(run);
    if (!path) return null;
    if (runTrackCache.has(path)) return runTrackCache.get(path);
    const track = await fetchJson(path);
    runTrackCache.set(path, track);
    return track;
  }
  // The redesign is location-centric: the city becomes the page's primary
  // identity (more memorable than generic Strava titles). If no location is
  // known, fall back to the activity name so the header is never empty.
  function runHeaderTitle(run) {
    return run.location_city || run.location_country || run.name || "Run";
  }
  function runStartLine(run) {
    const date = new Date(run.start_local || `${run.d}T12:00:00`);
    if (Number.isNaN(date.getTime())) return run.d;
    const weekday = new Intl.DateTimeFormat("en-IT",{weekday:"long"}).format(date);
    const month = new Intl.DateTimeFormat("en-IT",{month:"short"}).format(date);
    const hh = String(date.getHours()).padStart(2,"0"), mm = String(date.getMinutes()).padStart(2,"0");
    return `${weekday}, ${date.getDate()} ${month} ${date.getFullYear()} at ${hh}:${mm}`;
  }
  function runHeaderSubtitleLines(run) {
    const usedNameAsTitle = !run.location_city && !run.location_country;
    const lines = [usedNameAsTitle ? "Location unavailable" : (run.name || "Run")];
    lines.push(runStartLine(run));
    return lines;
  }
  function detailValue(value, suffix="", digits=0) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return `${Number(value).toLocaleString("en-IT",{maximumFractionDigits:digits})}${suffix}`;
  }
  function paceSecondsFromRun(run) { return run.km > 0 ? run.min * 60 / run.km : null; }
  // Compact windowed dot indicator: shows at most 5 dots centred on the
  // current run rather than one dot per historical run (there can be
  // hundreds), consistent with the "compact navigation" spec.
  function navDotsHtml(index, total) {
    if (total <= 1) return "";
    const windowSize = Math.min(5, total);
    const start = Math.max(0, Math.min(index - Math.floor(windowSize/2), total - windowSize));
    let html = "";
    for (let i = start; i < start + windowSize; i++) html += `<span class="run-nav-dot${i===index?" active":""}"></span>`;
    return html;
  }
  function metricToggleHtml() {
    const metrics = [["pace","Pace"],["hr","Heart rate"],["elevation","Elevation"],["cadence","Cadence"]];
    return metrics.map(([key,label])=>`<button data-metric="${key}" class="${runMetric===key?"active":""}">${label}</button>`).join("");
  }
  function buildRunShell(run, index, runs) {
    const pace = paceSecondsFromRun(run);
    const latest = index === 0 ? '<span class="run-badge">Last run</span>' : '';
    return `
      <div class="run-hero">
        <div class="run-titleline"><div><h2 class="run-title">${escapeHtml(runHeaderTitle(run))}</h2><p class="run-subtitle">${runHeaderSubtitleLines(run).map(escapeHtml).join("<br>")}</p></div>${latest}</div>
        <div class="run-topmetrics">
          <div class="run-topmetric"><strong>${detailValue(run.km,"",2)}</strong><span>km</span></div>
          <div class="run-topmetric"><strong>${formatDuration(run.min)}</strong><span>Moving time</span></div>
          <div class="run-topmetric"><strong>${pace ? fmtPace(pace) : "—"}</strong><span>Average pace /km</span></div>
          <div class="run-topmetric"><strong>${detailValue(run.hr)}</strong><span>Average HR bpm</span></div>
        </div>
      </div>
      <div class="run-nav">
        <button class="run-nav-btn" id="previousRunBtn" ${index >= runs.length-1 ? "disabled" : ""}>‹ Prev run</button>
        <div class="run-nav-center"><span class="run-nav-badge">${escapeHtml(run.d)}</span><div class="run-nav-dots">${navDotsHtml(index, runs.length)}</div></div>
        <button class="run-nav-btn" id="nextRunBtn" ${index <= 0 ? "disabled" : ""}>Next run ›</button>
      </div>
      <div class="run-map-card">
        <div id="runDetailMap"></div>
        <div class="run-map-legend" id="runMapLegend"></div>
        <div class="run-map-toolbar"><span class="chartlabel" style="margin:0">Colour route by</span><div class="metric-toggle" id="routeMetricToggle">${metricToggleHtml()}</div></div>
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
      <div class="run-panel run-insights"><p class="run-panel-title">Insights</p><ul id="runInsights"></ul><button class="run-insights-more" id="runInsightsMoreBtn" type="button" style="display:none">View more insights →</button></div>
      <div class="run-panel run-compare"><p class="run-panel-title">Compare</p><div class="compare-options" id="compareOptions"></div><div class="compare-result" id="compareResult"></div></div>`;
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
  // Palettes are ordered low-value -> high-value so the same ascending-index
  // lookup (colorForValue) works for every metric. Pace goes fast(green) ->
  // slow(red); heart rate goes calm(blue) -> max effort(red); elevation and
  // cadence go low -> high, per the design memo.
  function metricPalette(metric) {
    if(metric==="hr") return ["#2563eb","#22c55e","#eab308","#f97316","#ef4444"];
    if(metric==="elevation") return ["#164e63","#0891b2","#22c55e","#eab308","#f97316"];
    if(metric==="cadence") return ["#7c3aed","#2563eb","#22c55e","#eab308","#ef4444"];
    return ["#22c55e","#84cc16","#eab308","#f97316","#ef4444"];
  }
  function quantile(values,q) {
    if(!values.length) return 0; const sorted=values.slice().sort((a,b)=>a-b); return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))];
  }
  // Shared colour context so the map route, the performance chart and the
  // legend all use the exact same buckets for the currently selected metric
  // (section 6/7/10/14 of the memo: route colouring, map<->chart sync,
  // chart colouring and a consistent visual language).
  function buildColorContext(track, metric) {
    const series = metricSeries(track, metric);
    const values = series.map(s=>s.value).filter(Number.isFinite);
    const palette = metricPalette(metric);
    const breaks = [];
    for (let i = 1; i <= palette.length - 1; i++) breaks.push(quantile(values, i/palette.length));
    return { metric, series, palette, breaks };
  }
  function colorForValue(value, ctx) {
    if (!ctx || !Number.isFinite(value)) return "#8a8f98";
    let index = 0;
    while (index < ctx.breaks.length && value > ctx.breaks[index]) index++;
    return ctx.palette[Math.max(0, Math.min(ctx.palette.length-1, index))];
  }
  function legendMetricLabel(metric) {
    return {pace:"Pace (min/km)", hr:"Heart rate (bpm)", elevation:"Elevation (m)", cadence:"Cadence (spm)"}[metric] || metric;
  }
  function legendValueFormat(metric, value) {
    if (!Number.isFinite(value)) return "—";
    return metric === "pace" ? fmtPace(value) : String(Math.round(value));
  }
  function renderMapLegend(ctx) {
    const target = document.getElementById("runMapLegend"); if (!target) return;
    const values = ctx && ctx.series ? ctx.series.map(s=>s.value).filter(Number.isFinite) : [];
    if (!values.length) { target.innerHTML = ""; return; }
    const min = Math.min(...values), max = Math.max(...values);
    const ticks = [min, ...ctx.breaks, max];
    const lastIndex = ticks.length - 1;
    const tickHtml = ticks.map((v,i)=>`<span>${legendValueFormat(ctx.metric,v)}${(i===lastIndex && ctx.metric!=="elevation")?"+":""}</span>`).join("");
    target.innerHTML = `<div class="run-legend-title">${legendMetricLabel(ctx.metric)}</div><div class="run-legend-bar" style="background:linear-gradient(to right, ${ctx.palette.join(",")})"></div><div class="run-legend-ticks">${tickHtml}</div>`;
  }
  function stopSegClickPropagation(e) {
    if (typeof L !== "undefined" && L.DomEvent && L.DomEvent.stopPropagation) L.DomEvent.stopPropagation(e);
  }
  // Bidirectional map<->chart sync (memo section 7): hovering/tapping a
  // route segment finds the nearest original track point and drives both
  // the map hover marker and the chart's native active-element/tooltip
  // state, matching how the chart already drives the map on hover.
  function chartDataIndexForPointIndex(pointIndex) {
    for (let i=0;i<currentChartData.length;i++) if (currentChartData[i].pointIndex === pointIndex) return i;
    let best=-1, bestDiff=Infinity;
    currentChartData.forEach((d,i)=>{ const diff=Math.abs(d.pointIndex-pointIndex); if(diff<bestDiff){bestDiff=diff;best=i;} });
    return best;
  }
  function highlightFromMap(pointIndex) {
    const point = (currentTrack?.points||[])[pointIndex];
    if (runHoverMarker && point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon))) {
      runHoverMarker.setLatLng([Number(point.lat), Number(point.lon)]);
      runHoverMarker.setStyle({opacity:1, fillOpacity:1});
    }
    if (!runDetailChart || !currentChartData.length) return;
    const dataIndex = chartDataIndexForPointIndex(pointIndex);
    if (dataIndex < 0) return;
    try {
      runDetailChart.setActiveElements([{datasetIndex:0, index:dataIndex}]);
      if (runDetailChart.tooltip) runDetailChart.tooltip.setActiveElements([{datasetIndex:0, index:dataIndex}], {x:0,y:0});
      runDetailChart.update();
    } catch (error) { /* not fatal: some environments stub Chart.js */ }
  }
  function clearMapHighlight() {
    if (runHoverMarker) runHoverMarker.setStyle({opacity:0, fillOpacity:0});
    if (!runDetailChart) return;
    try {
      runDetailChart.setActiveElements([]);
      if (runDetailChart.tooltip) runDetailChart.tooltip.setActiveElements([], {x:0,y:0});
      runDetailChart.update();
    } catch (error) { /* not fatal: some environments stub Chart.js */ }
  }
  function attachSegmentInteractivity(polyline, idxs, rawPoints) {
    function nearestIdx(latlng) {
      let bestIdx = idxs[0], bestDist = Infinity;
      idxs.forEach(idx => {
        const p = rawPoints[idx];
        const dLat = Number(p.lat)-latlng.lat, dLon = Number(p.lon)-latlng.lng;
        const dist = dLat*dLat + dLon*dLon;
        if (dist < bestDist) { bestDist = dist; bestIdx = idx; }
      });
      return bestIdx;
    }
    polyline.on("mousemove", e => { stopSegClickPropagation(e); highlightFromMap(nearestIdx(e.latlng)); });
    polyline.on("click", e => { stopSegClickPropagation(e); highlightFromMap(nearestIdx(e.latlng)); });
    polyline.on("mouseout", () => clearMapHighlight());
  }
  function renderDetailedMap(track, colorCtx) {
    const element = document.getElementById("runDetailMap");
    if (!element) return;
    try {
      if (runDetailMap) { runDetailMap.remove(); runDetailMap = null; }
      runHoverMarker = null;
      runDetailMap = L.map(element, {zoomControl:true});
      // Carto Voyager replaces the previous dark basemap: a lighter, more
      // readable map so the coloured route becomes the visual focus.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution:"&copy; OpenStreetMap contributors &copy; CARTO", maxZoom:20
      }).addTo(runDetailMap);

      const rawPoints = Array.isArray(track?.points) ? track.points : [];
      const validIdx = [];
      for (let i=0;i<rawPoints.length;i++){
        const p = rawPoints[i];
        if (Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))) validIdx.push(i);
      }

      if (validIdx.length < 2) {
        runDetailMap.setView([20,0],2);
        L.popup().setLatLng([20,0]).setContent("Detailed route unavailable for this run.").openOn(runDetailMap);
        return;
      }

      const maxPoints = 1200;
      const step = Math.max(1, Math.ceil(validIdx.length / maxPoints));
      const sampledIdx = validIdx.filter((_, i) => i % step === 0 || i === validIdx.length-1);
      const series = colorCtx && colorCtx.series ? colorCtx.series : null;

      // Merge consecutive same-colour points into one polyline each instead
      // of drawing one polyline per pair of points: far fewer layers, same
      // smooth gradient look as the mockup.
      const segments = [];
      let currentColor = null, currentLatLngs = [], currentIdxs = [];
      sampledIdx.forEach(idx => {
        const p = rawPoints[idx];
        const latlng = [Number(p.lat), Number(p.lon)];
        const value = series ? series[idx]?.value : NaN;
        const color = colorForValue(value, colorCtx);
        if (color !== currentColor) {
          if (currentLatLngs.length > 1) segments.push({color: currentColor, latlngs: currentLatLngs, idxs: currentIdxs});
          currentColor = color;
          currentLatLngs = currentLatLngs.length ? [currentLatLngs[currentLatLngs.length-1], latlng] : [latlng];
          currentIdxs = currentIdxs.length ? [currentIdxs[currentIdxs.length-1], idx] : [idx];
        } else {
          currentLatLngs.push(latlng);
          currentIdxs.push(idx);
        }
      });
      if (currentLatLngs.length > 1) segments.push({color: currentColor, latlngs: currentLatLngs, idxs: currentIdxs});

      const boundsLatLngs = [];
      segments.forEach(seg => {
        const polyline = L.polyline(seg.latlngs, {color: seg.color, weight:5, opacity:.95}).addTo(runDetailMap);
        attachSegmentInteractivity(polyline, seg.idxs, rawPoints);
        seg.latlngs.forEach(ll => boundsLatLngs.push(ll));
      });

      const startLatLng = [Number(rawPoints[validIdx[0]].lat), Number(rawPoints[validIdx[0]].lon)];
      const finishLatLng = [Number(rawPoints[validIdx[validIdx.length-1]].lat), Number(rawPoints[validIdx[validIdx.length-1]].lon)];
      L.circleMarker(startLatLng, {radius:7,color:"#fff",weight:2,fillColor:"#22c55e",fillOpacity:1}).bindTooltip("Start").addTo(runDetailMap);
      L.circleMarker(finishLatLng, {radius:7,color:"#fff",weight:2,fillColor:"#111827",fillOpacity:1}).bindTooltip("Finish").addTo(runDetailMap);
      runHoverMarker = L.circleMarker(startLatLng, {radius:6,color:"#fff",weight:2,fillColor:"#fc4c02",fillOpacity:0,opacity:0,interactive:false}).addTo(runDetailMap);

      if (boundsLatLngs.length) runDetailMap.fitBounds(L.latLngBounds(boundsLatLngs), {padding:[20,20]});
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
  function renderRunChart(track, colorCtx) {
    const canvas=document.getElementById("runPerformanceChart"); if(!canvas) return;
    const data=trackSeries(track,runMetric); currentChartData=data;
    if(runDetailChart) runDetailChart.destroy();
    const label={pace:"Pace",hr:"Heart rate",elevation:"Elevation",cadence:"Cadence"}[runMetric]||runMetric;
    const baseColor=(colorCtx && colorCtx.palette && colorCtx.palette[0]) || "#2a78d6";
    runDetailChart=new Chart(canvas,{type:"line",data:{datasets:[{
      data,borderColor:baseColor,borderWidth:2,pointRadius:0,pointHoverRadius:5,tension:.28,spanGaps:true,
      // Colour the line the same way as the route on the map, segment by
      // segment, using the shared colour context (memo section 10/14).
      segment:{borderColor:ctx=>colorForValue(data[ctx.p0DataIndex]?.y, colorCtx)}
    }]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"nearest",intersect:false},onHover:(event,elements)=>{ if(elements.length) showRunPoint(track,data[elements[0].index]); else if(runHoverMarker) runHoverMarker.setStyle({opacity:0,fillOpacity:0}); },plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${label}: ${runMetric==="pace"?fmtPace(c.parsed.y):Math.round(c.parsed.y)}`}}},scales:{x:{type:"linear",title:{display:true,text:"km"},grid:{color:getGridColor()}},y:{reverse:runMetric==="pace",grid:{color:getGridColor()},ticks:{callback:v=>runMetric==="pace"?fmtPace(v):v}}}}});
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
    // Highlight the fastest/slowest split, the highest HR and the greatest
    // elevation change, per the memo (section 9).
    const paceValues=splits.map(s=>s.pace).filter(Number.isFinite);
    const fastestPace=paceValues.length?Math.min(...paceValues):null;
    const slowestPace=paceValues.length?Math.max(...paceValues):null;
    const hrValues=splits.map(s=>s.hr).filter(Number.isFinite);
    const maxHr=hrValues.length?Math.max(...hrValues):null;
    const elevValues=splits.map(s=>s.elev).filter(Number.isFinite);
    const maxAbsElev=elevValues.length?Math.max(...elevValues.map(v=>Math.abs(v))):null;
    target.innerHTML=`<table class="splits-table"><thead><tr><th>KM</th><th>Pace</th><th>HR</th><th>Elev.</th></tr></thead><tbody>${splits.map(s=>{
      const isFastest=Number.isFinite(s.pace)&&s.pace===fastestPace;
      const isSlowest=!isFastest&&Number.isFinite(s.pace)&&s.pace===slowestPace;
      const isMaxHr=Number.isFinite(s.hr)&&s.hr===maxHr;
      const isMaxElev=maxAbsElev>0&&Number.isFinite(s.elev)&&Math.abs(s.elev)===maxAbsElev;
      const paceClass=isFastest?"split-fastest":(isSlowest?"split-slowest":"");
      const trophy=isFastest?'<span class="split-trophy" title="Fastest split">🏆</span>':"";
      return `<tr><td>${trophy}${s.km}</td><td class="${paceClass}">${s.pace?fmtPace(s.pace):"—"}</td><td class="${isMaxHr?"split-hr-max":""}">${s.hr?Math.round(s.hr):"—"}</td><td class="${isMaxElev?"split-elev-max":""}">${s.elev===null?"—":`${s.elev>0?"+":""}${Math.round(s.elev)} m`}</td></tr>`;
    }).join("")}</tbody></table>`;
  }
  // Ranks the current run against every other run within a distance band
  // (±10%, floor 0.3 km) so both the insight engine and the compare panel
  // can answer "how does this stack up against similar-distance runs".
  function distanceBucket(runs, targetKm, tolerancePct=0.1) {
    const tolerance = Math.max(targetKm*tolerancePct, 0.3);
    return runs.filter(r => r.km>0 && Math.abs(r.km-targetKm)<=tolerance);
  }
  function computeInsightCandidates(run, track) {
    const insights=[];
    const allRuns=getRuns();
    const pace=paceSecondsFromRun(run);

    // Fastest run in this city this year (needs at least one other same-city,
    // same-year run to be a meaningful claim).
    if (run.location_city) {
      const cityYearRuns=allRuns.filter(r=>r.y===run.y&&cityKey(r)===cityKey(run)&&r.km>0&&r.min>0);
      if (cityYearRuns.length>=2) {
        const ranked=cityYearRuns.map(r=>({r,p:paceSecondsFromRun(r)})).filter(x=>Number.isFinite(x.p));
        const fastest=ranked.reduce((best,x)=>!best||x.p<best.p?x:best,null);
        if (fastest && fastest.r===run) insights.push(`Fastest run in ${run.location_city} this year.`);
      }
    }

    // Longest run this calendar month (across all locations).
    if (run.d) {
      const monthKey=run.d.slice(0,7);
      const monthRuns=allRuns.filter(r=>r.d && r.d.slice(0,7)===monthKey && r.km>0);
      if (monthRuns.length>=2) {
        const longest=monthRuns.reduce((best,r)=>!best||r.km>best.km?r:best,null);
        if (longest===run) insights.push("Longest run this month.");
      }
    }

    // Rank over similar distance: only worth mentioning if this run is the
    // best or second-best in its distance band, out of at least 3 runs.
    if (run.km>0 && pace) {
      const bucket=distanceBucket(allRuns, run.km);
      if (bucket.length>=3) {
        const ranked=bucket.map(r=>({r,p:paceSecondsFromRun(r)})).filter(x=>Number.isFinite(x.p)).sort((a,b)=>a.p-b.p);
        const rank=ranked.findIndex(x=>x.r===run);
        if (rank===0) insights.push(`Fastest run around ${run.km.toFixed(1)} km on record.`);
        else if (rank===1) insights.push(`Second-fastest run around ${run.km.toFixed(1)} km.`);
      }
    }

    const splits=buildSplits(track);
    if (splits.length>=4) {
      const half=Math.floor(splits.length/2), first=splits.slice(0,half).map(s=>s.pace).filter(Boolean), second=splits.slice(half).map(s=>s.pace).filter(Boolean);
      if (first.length&&second.length&&second.reduce((a,b)=>a+b,0)/second.length < first.reduce((a,b)=>a+b,0)/first.length) insights.push("Negative split: the second half was faster.");
    }

    const yearRuns=allRuns.filter(r=>r.y===run.y&&r.hr&&r.km>0);
    const efficiency=run.hr?run.km*1000/(run.hr*run.min):null;
    const avgEfficiency=yearRuns.length?yearRuns.reduce((sum,r)=>sum+r.km*1000/(r.hr*r.min),0)/yearRuns.length:null;
    if (efficiency&&avgEfficiency&&efficiency>avgEfficiency*1.05) insights.push("Cardiac efficiency was above your yearly average.");

    const yearlyPace=yearRuns.length?yearRuns.reduce((s,r)=>s+r.min,0)*60/yearRuns.reduce((s,r)=>s+r.km,0):null;
    if (pace&&yearlyPace&&pace<yearlyPace) insights.push("Faster than your average pace for this year.");

    if (run.km>=15) insights.push("This run qualifies as a long run.");

    return insights;
  }
  function renderRunInsights(run,track) {
    const target=document.getElementById("runInsights"); if(!target) return;
    const moreBtn=document.getElementById("runInsightsMoreBtn");
    let insights=computeInsightCandidates(run,track);
    if (!insights.length) insights=["Detailed insights will improve as more historical tracks are downloaded."];
    const VISIBLE=4;
    target.innerHTML=insights.map((x,i)=>`<li class="${i>=VISIBLE?"run-insight-extra":""}"${i>=VISIBLE?' style="display:none"':""}>${escapeHtml(x)}</li>`).join("");
    if (moreBtn) {
      const hiddenCount=Math.max(0, insights.length-VISIBLE);
      moreBtn.style.display=hiddenCount?"":"none";
      moreBtn.textContent="View more insights →";
      moreBtn.onclick=()=>{
        const extras=target.querySelectorAll(".run-insight-extra");
        const showing=extras.length>0 && extras[0].style.display!=="none";
        extras.forEach(li=>{ li.style.display=showing?"none":"list-item"; });
        moreBtn.textContent=showing?"View more insights →":"Show fewer insights ↑";
      };
    }
  }
  function bindRunControls(run,index,runs,track) {
    const prev=document.getElementById("previousRunBtn"), next=document.getElementById("nextRunBtn");
    if(prev) prev.onclick=()=>{ const target=runs[index+1]; if(target) selectRun(runKey(target)); };
    if(next) next.onclick=()=>{ const target=runs[index-1]; if(target) selectRun(runKey(target)); };
    document.querySelectorAll("#routeMetricToggle button").forEach(button=>button.onclick=()=>{
      document.querySelectorAll("#routeMetricToggle button").forEach(b=>b.classList.remove("active"));
      button.classList.add("active");
      runMetric=button.dataset.metric;
      const ctx=buildColorContext(track,runMetric);
      renderDetailedMap(track,ctx);
      renderRunChart(track,ctx);
      renderMapLegend(ctx);
    });
  }
  function runKey(run) { return run?.id || `${run?.d}-${run?.km}-${run?.min}`; }
  function selectRun(key) { selectedRunId=String(key); dirty.runs=true; renderRuns(); }
  // Cross-tab entry point (used by the Map tab's "Open run details"
  // action): looks the run up by its Strava activity id among the runs
  // currently visible under the shared year filter, so it stays
  // consistent with whatever the Map tab was showing when clicked.
  function selectRunById(id) {
    const runs = sortedSelectableRuns();
    const match = runs.find(r => String(r.id) === String(id)) || runs.find(r => String(runKey(r)) === String(id));
    if (match) selectRun(runKey(match));
  }
  // Compare panel: instead of one generic "similar run" button, offer up to
  // four targeted comparisons (memo section 12). "Same route" uses a light
  // heuristic (same city + distance within ±10% + elevation gain within
  // ±20% when both are known) rather than actual GPS shape-matching, which
  // would need fetching and comparing every candidate's track.
  function findPreviousCityRun(run, runs) {
    if (!run.location_city) return null;
    const ts=runTimestamp(run);
    const candidates=runs.filter(r=>r!==run && cityKey(r)===cityKey(run) && runTimestamp(r)<ts);
    if (!candidates.length) return null;
    return candidates.reduce((best,r)=>!best||runTimestamp(r)>runTimestamp(best)?r:best,null);
  }
  function findFastestSameDistance(run, runs) {
    const bucket=distanceBucket(runs, run.km).filter(r=>r!==run && r.min>0);
    const ranked=bucket.map(r=>({r,p:paceSecondsFromRun(r)})).filter(x=>Number.isFinite(x.p)).sort((a,b)=>a.p-b.p);
    return ranked.length ? ranked[0].r : null;
  }
  function findSameRouteCandidate(run, runs) {
    if (!run.location_city || !(run.km>0)) return null;
    const ts=runTimestamp(run);
    const kmTolerance=Math.max(run.km*0.1, 0.3);
    const elevTolerance=Number.isFinite(run.elev) ? Math.max(run.elev*0.2, 10) : null;
    const candidates=runs.filter(r=>{
      if (r===run || cityKey(r)!==cityKey(run)) return false;
      if (runTimestamp(r)>=ts) return false; // "previous attempt": strictly earlier
      if (Math.abs(r.km-run.km)>kmTolerance) return false;
      if (elevTolerance!==null && Number.isFinite(r.elev) && Math.abs(r.elev-run.elev)>elevTolerance) return false;
      return true;
    });
    if (!candidates.length) return null;
    return candidates.reduce((best,r)=>!best||runTimestamp(r)>runTimestamp(best)?r:best,null);
  }
  function findSimilarEffortCandidate(run, runs) {
    const pace=paceSecondsFromRun(run); if (!pace || !run.hr) return null;
    const candidates=runs.filter(r=>r!==run && r.hr && r.km>0 && r.min>0);
    let best=null, bestScore=Infinity;
    candidates.forEach(r=>{
      const p=paceSecondsFromRun(r); if (!Number.isFinite(p)) return;
      // Weighted so ~30s/km of pace difference counts about the same as
      // ~10bpm of HR difference; a heuristic, not a physiological model.
      const score=Math.abs(p-pace)/30 + Math.abs(r.hr-run.hr)/10;
      if (score<bestScore) { bestScore=score; best=r; }
    });
    return best;
  }
  function compareOptionDefs(run, runs) {
    const defs=[];
    const cityRun=findPreviousCityRun(run, runs);
    if (cityRun) defs.push({kind:"city", icon:"🏙️", label:`vs previous run in ${run.location_city}`, candidate:cityRun});
    const distanceRun=findFastestSameDistance(run, runs);
    if (distanceRun) defs.push({kind:"distance", icon:"⚡", label:`vs fastest ${run.km.toFixed(1)} km run`, candidate:distanceRun});
    const routeRun=findSameRouteCandidate(run, runs);
    if (routeRun) defs.push({kind:"route", icon:"🔁", label:"vs previous attempt on this route", candidate:routeRun});
    const effortRun=findSimilarEffortCandidate(run, runs);
    if (effortRun) defs.push({kind:"effort", icon:"❤️", label:"vs similar effort (pace & HR)", candidate:effortRun});
    return defs;
  }
  function showCompareResult(run, candidate, label) {
    const target=document.getElementById("compareResult"); if (!target) return;
    const paceA=paceSecondsFromRun(run), paceB=paceSecondsFromRun(candidate);
    const fasterText=(paceA&&paceB) ? (paceA<paceB ? "This run was faster." : (paceA>paceB ? "The comparison run was faster." : "Same pace.")) : "";
    target.style.display="block";
    target.innerHTML=`<strong>${escapeHtml(label)}</strong><br>${escapeHtml(candidate.d)} · ${escapeHtml(runHeaderTitle(candidate))} · ${detailValue(candidate.km," km",2)} · ${paceB?fmtPace(paceB):"—"}/km${candidate.hr?` · ${Math.round(candidate.hr)} bpm`:""}. ${fasterText}`;
  }
  function renderCompareOptions(run, runs) {
    const target=document.getElementById("compareOptions"); if (!target) return;
    const resultTarget=document.getElementById("compareResult"); if (resultTarget) resultTarget.style.display="none";
    const defs=compareOptionDefs(run, runs);
    if (!defs.length) { target.innerHTML='<p class="empty">Not enough historical data yet for a comparison.</p>'; return; }
    target.innerHTML=defs.map(d=>`<button class="compare-option" data-kind="${d.kind}" type="button"><span class="compare-option-icon">${d.icon}</span><span class="compare-option-label">${escapeHtml(d.label)}</span><span class="compare-option-chevron">›</span></button>`).join("");
    target.querySelectorAll(".compare-option").forEach(btn=>{
      btn.onclick=()=>{
        target.querySelectorAll(".compare-option").forEach(b=>b.classList.remove("active"));
        btn.classList.add("active");
        const def=defs.find(d=>d.kind===btn.dataset.kind);
        if (def) showCompareResult(run, def.candidate, def.label);
      };
    });
  }
  // Wired once on the persistent #runDetailContent node (its children are
  // replaced on every render, but the node itself survives), mirroring the
  // Map tab's swipe pattern. Reads the current run/index via the module-level
  // refs kept fresh by renderSelectedRun so it always acts on live state.
  function wireRunSwipeOnce() {
    if (swipeWired) return;
    const el = document.getElementById("runDetailContent");
    if (!el || !el.addEventListener) return;
    swipeWired = true;
    let startX = null, startY = null;
    el.addEventListener("touchstart", e => {
      if (!e.touches || !e.touches.length) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, {passive:true});
    el.addEventListener("touchend", e => {
      if (startX === null) return;
      const touch = e.changedTouches && e.changedTouches[0];
      const sx = startX, sy = startY; startX = null; startY = null;
      if (!touch) return;
      const dx = touch.clientX - sx, dy = touch.clientY - (sy||0);
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const runs = currentRunsRef, index = currentIndexRef;
      const target = dx < 0 ? runs[index+1] : runs[index-1]; // swipe left -> next run, right -> previous
      if (target) selectRun(runKey(target));
    }, {passive:true});
  }
  async function renderSelectedRun(run,runs) {
    const content = document.getElementById("runDetailContent");
    const index = runs.findIndex(r => String(runKey(r)) === String(runKey(run)));
    currentRunsRef = runs; currentIndexRef = index;
    content.innerHTML = buildRunShell(run,index,runs);
    wireRunSwipeOnce();

    // Navigation must work even if the track request or a renderer fails.
    bindRunControls(run,index,runs,null);
    try { renderCompareOptions(run,runs); } catch (error) { console.error("Compare panel failed", error); }

    let track = null;
    try {
      track = await loadRunTrack(run);
    } catch (error) {
      console.error("Track loading failed", trackPath(run), error);
    }
    currentTrack = track;
    const colorCtx = buildColorContext(track, runMetric);

    // Render each component independently so one failure cannot blank the rest.
    try { renderDetailedMap(track,colorCtx); } catch (error) { console.error("Map failed", error); }
    try { renderRunChart(track,colorCtx); } catch (error) {
      console.error("Performance chart failed", error);
      const canvas = document.getElementById("runPerformanceChart");
      if (canvas?.parentElement) canvas.parentElement.innerHTML = '<p class="empty">Performance data could not be rendered.</p>';
    }
    try { renderMapLegend(colorCtx); } catch (error) { console.error("Legend failed", error); }
    try { renderSplits(track); } catch (error) {
      console.error("Splits failed", error);
      const target = document.getElementById("runSplits");
      if (target) target.innerHTML = '<p class="empty">Split data could not be rendered.</p>';
    }
    try { renderRunInsights(run,track); } catch (error) { console.error("Insights failed", error); }

    // Rebind metric controls with the loaded track.
    bindRunControls(run,index,runs,track);
  }
  // Custom activity picker: a searchable panel instead of a native <select>,
  // which still scales to hundreds of runs (memo section 4) but shows
  // richer per-row info (date, distance, location, name). The trigger and
  // panel nodes live directly in index.html (not rebuilt per render), so
  // they're wired up once; only the row list and trigger text refresh on
  // every render.
  function renderPickerRows(filterText) {
    const list=document.getElementById("runPickerList"); if (!list) return;
    const needle=(filterText||"").trim().toLowerCase();
    const rows=needle ? pickerRuns.filter(r=>pickerSearchText(r).includes(needle)) : pickerRuns;
    if (!rows.length) { list.innerHTML='<p class="empty" style="padding:14px">No runs match your search.</p>'; return; }
    list.innerHTML=rows.map(r=>{
      const label=pickerRowLabel(r);
      const active=String(runKey(r))===String(selectedRunId) ? " active" : "";
      return `<button type="button" class="run-picker-row${active}" data-key="${escapeHtml(runKey(r))}">
        <span class="run-picker-row-date">${escapeHtml(label.date)}</span>
        <span class="run-picker-row-main"><span class="run-picker-row-name">${escapeHtml(label.name)}</span><span class="run-picker-row-loc">${escapeHtml(label.location)}</span></span>
        <span class="run-picker-row-km">${escapeHtml(label.distance)}</span>
      </button>`;
    }).join("");
    list.querySelectorAll(".run-picker-row").forEach(btn=>{ btn.onclick=()=>{ closeRunPicker(); selectRun(btn.dataset.key); }; });
  }
  function updateRunPickerTrigger(run) {
    const text=document.getElementById("runPickerTriggerText"); if (!text || !run) return;
    const label=pickerRowLabel(run);
    text.textContent=`${label.date} · ${label.distance} · ${label.name}`;
  }
  function openRunPicker() {
    const panel=document.getElementById("runPickerPanel"), trigger=document.getElementById("runPickerTrigger"), search=document.getElementById("runPickerSearch");
    if (!panel) return;
    panel.hidden=false;
    if (trigger) trigger.setAttribute("aria-expanded","true");
    if (search) { search.value=""; if (search.focus) search.focus(); }
    renderPickerRows("");
  }
  function closeRunPicker() {
    const panel=document.getElementById("runPickerPanel"), trigger=document.getElementById("runPickerTrigger");
    if (!panel) return;
    panel.hidden=true;
    if (trigger) trigger.setAttribute("aria-expanded","false");
  }
  function wireRunPickerOnce() {
    if (pickerWired) return;
    const trigger=document.getElementById("runPickerTrigger"), panel=document.getElementById("runPickerPanel"), search=document.getElementById("runPickerSearch");
    if (!trigger || !panel) return;
    pickerWired=true;
    trigger.onclick=()=>{ panel.hidden ? openRunPicker() : closeRunPicker(); };
    if (search && search.addEventListener) search.addEventListener("input", ()=>renderPickerRows(search.value));
    if (document.addEventListener) {
      document.addEventListener("click", e=>{
        if (panel.hidden) return;
        const target=e && e.target;
        if (target && typeof panel.contains==="function" && panel.contains(target)) return;
        if (target && (target===trigger || (typeof trigger.contains==="function" && trigger.contains(target)))) return;
        closeRunPicker();
      });
      document.addEventListener("keydown", e=>{ if (e && e.key==="Escape" && !panel.hidden) closeRunPicker(); });
    }
  }
  function renderRuns() {
    const runs=sortedSelectableRuns(), content=document.getElementById("runDetailContent");
    if(!runs.length){ pickerRuns=[]; content.innerHTML='<p class="run-empty">No runs match the selected years.</p>'; return; }
    if(!selectedRunId || !runs.some(r=>String(runKey(r))===String(selectedRunId))) selectedRunId=String(runKey(runs[0]));
    pickerRuns=runs;
    wireRunPickerOnce();
    closeRunPicker();
    const run=runs.find(r=>String(runKey(r))===String(selectedRunId))||runs[0];
    updateRunPickerTrigger(run);
    renderSelectedRun(run,runs);
  }

  window.RD.tabs = window.RD.tabs || {};
  window.RD.tabs.runs = { render: renderRuns, getRunDetailMap: () => runDetailMap, selectRunById };
})();
