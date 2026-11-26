(function () {
  "use strict";

  const EARTH_RADIUS_M = 6378137;

  const AREA_UNITS = {
    acres:   { label: "ac",      factor: 0.000247105381 },
    sqft:    { label: "ft²",     factor: 10.7639104167 },
    hectares:{ label: "ha",      factor: 0.0001 },
    sqm:     { label: "m²",      factor: 1 },
    sqkm:    { label: "km²",     factor: 0.000001 },
    sqyd:    { label: "yd²",     factor: 1.19599004630 },
    sqmi:    { label: "mi²",     factor: 3.86102159e-7 },
    rood:    { label: "rood",    factor: 1 / 1011.7141056 },
    perch:   { label: "perch",   factor: 1 / 25.2928526 }
  };

  const LENGTH_UNITS = {
    feet:   { label: "ft", factor: 3.2808398950 },
    miles:  { label: "mi", factor: 0.0006213712 },
    meters: { label: "m",  factor: 1 },
    km:     { label: "km", factor: 0.001 },
    yards:  { label: "yd", factor: 1.0936132983 }
  };

  const DEFAULT_SETTINGS = {
    areaUnit: "acres",
    lengthUnit: "feet",
    basemap: "satellite",
    rotateCompass: true
  };

  const ACCURACY_GOOD_M = 5;
  const ACCURACY_FAIR_M = 15;

  // ---------------------------------------------------------------- state
  const settings = loadSettings();
  let mode = "draw";          // "draw" | "record"
  let drawPoints = [];        // [{lat,lng}]
  let recordPoints = [];
  let recording = false;
  let paused = false;
  let watchId = null;
  let lastAccuracyM = null;
  let deviceHeadingDeg = null;
  let userMarker = null;
  let browsePath = [];        // [] | [farm] | [farm,field] | [farm,field,block]
  let editMode = false;
  let selectedIndex = null;
  let recordClosed = false;   // true once a recorded boundary has been Finished

  // -------------------------------------------------------------- library
  // "Directories" are emulated as a Farm -> Field -> Block tree in
  // localStorage, since a static site has no real filesystem to browse.
  function loadLibrary() {
    try {
      const raw = JSON.parse(localStorage.getItem("fam-library"));
      if (raw && raw.farms) return raw;
    } catch (e) { /* ignore corrupt storage */ }
    return { farms: {} };
  }

  const library = loadLibrary();

  function saveLibrary() {
    localStorage.setItem("fam-library", JSON.stringify(library));
  }

  function ensureBlockNode(farm, field, block) {
    if (!library.farms[farm]) library.farms[farm] = { fields: {} };
    const f = library.farms[farm];
    if (!f.fields[field]) f.fields[field] = { blocks: {} };
    const fl = f.fields[field];
    if (!fl.blocks[block]) fl.blocks[block] = { measurements: [] };
    return fl.blocks[block];
  }

  function farmNames() {
    return Object.keys(library.farms).sort();
  }

  function fieldNames(farm) {
    const f = library.farms[farm];
    return f ? Object.keys(f.fields).sort() : [];
  }

  function blockNames(farm, field) {
    const f = library.farms[farm];
    const fl = f && f.fields[field];
    return fl ? Object.keys(fl.blocks).sort() : [];
  }

  // ------------------------------------------------------------- settings
  function loadSettings() {
    try {
      const raw = localStorage.getItem("fam-settings");
      if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) { /* ignore corrupt storage */ }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveSettings() {
    localStorage.setItem("fam-settings", JSON.stringify(settings));
  }

  // ------------------------------------------------------------- geometry
  // Equirectangular projection around the shape's first vertex. Valid for
  // field-sized areas (well under city scale), avoids pulling in a full
  // geodesy library just to shoelace a polygon.
  function toLocalXY(points) {
    const lat0 = points[0].lat * Math.PI / 180;
    const lon0 = points[0].lng * Math.PI / 180;
    return points.map(p => {
      const lat = p.lat * Math.PI / 180;
      const lon = p.lng * Math.PI / 180;
      return {
        x: EARTH_RADIUS_M * (lon - lon0) * Math.cos(lat0),
        y: EARTH_RADIUS_M * (lat - lat0)
      };
    });
  }

  function polygonAreaM2(points) {
    if (points.length < 3) return 0;
    const xy = toLocalXY(points);
    let sum = 0;
    for (let i = 0; i < xy.length; i++) {
      const a = xy[i], b = xy[(i + 1) % xy.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function haversineM(p1, p2) {
    const R = 6371000;
    const phi1 = p1.lat * Math.PI / 180, phi2 = p2.lat * Math.PI / 180;
    const dPhi = (p2.lat - p1.lat) * Math.PI / 180;
    const dLambda = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dPhi / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function perimeterM(points, closed) {
    if (points.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      total += haversineM(points[i], points[i + 1]);
    }
    if (closed && points.length > 2) {
      total += haversineM(points[points.length - 1], points[0]);
    }
    return total;
  }

  function formatArea(m2) {
    const u = AREA_UNITS[settings.areaUnit];
    const v = m2 * u.factor;
    const decimals = v < 10 ? 2 : v < 1000 ? 1 : 0;
    return `${v.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${u.label}`;
  }

  function formatLength(m) {
    const u = LENGTH_UNITS[settings.lengthUnit];
    const v = m * u.factor;
    const decimals = v < 10 ? 1 : 0;
    return `${v.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${u.label}`;
  }

  // ------------------------------------------------------------------ map
  const map = L.map("map", {
    center: [39.8283, -98.5795],
    zoom: 5,
    zoomControl: true,
    attributionControl: true
  });

  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 20, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics" }
  );

  const streetLayer = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }
  );

  function applyBasemap() {
    [satelliteLayer, streetLayer].forEach(l => map.removeLayer(l));
    (settings.basemap === "street" ? streetLayer : satelliteLayer).addTo(map);
  }
  applyBasemap();

  const drawLayerGroup = L.layerGroup().addTo(map);
  const recordLayerGroup = L.layerGroup().addTo(map);
  const viewLayerGroup = L.layerGroup().addTo(map);

  function vertexIcon(editable, selected) {
    const size = editable ? 22 : 12;
    const cls = "vertex-dot" + (editable ? " vertex-dot-editable" : "") + (selected ? " vertex-dot-selected" : "");
    return L.divIcon({ className: cls, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  function midpointIcon() {
    return L.divIcon({ className: "midpoint-dot", iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  // --------------------------------------------------------- draw mode UI
  // `editable` turns vertices into draggable/selectable nodes and adds
  // tappable midpoint markers that split an edge into two segments.
  function redrawShape(group, points, closedPolygon, editable) {
    group.clearLayers();
    let shapeLayer = null;

    points.forEach((p, i) => {
      const marker = L.marker([p.lat, p.lng], {
        icon: vertexIcon(editable, editable && i === selectedIndex),
        draggable: !!editable
      });
      if (editable) {
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          selectedIndex = selectedIndex === i ? null : i;
          refreshEditButtons();
          redrawShape(group, points, closedPolygon, true);
        });
        marker.on("drag", () => {
          const ll = marker.getLatLng();
          points[i].lat = ll.lat;
          points[i].lng = ll.lng;
          if (shapeLayer) shapeLayer.setLatLngs(points.map(pp => [pp.lat, pp.lng]));
        });
        marker.on("dragend", () => {
          updateResults();
          redrawShape(group, points, closedPolygon, true);
        });
      }
      marker.addTo(group);
    });

    if (points.length >= 2) {
      if (closedPolygon && points.length >= 3) {
        shapeLayer = L.polygon(points.map(p => [p.lat, p.lng]), {
          color: "#ffeb3b", weight: 3, fillColor: "#ffeb3b", fillOpacity: 0.18
        }).addTo(group);
      } else {
        shapeLayer = L.polyline(points.map(p => [p.lat, p.lng]), { color: "#ffeb3b", weight: 3 }).addTo(group);
      }
    }

    if (editable && points.length >= 2) {
      const edgeCount = (closedPolygon && points.length >= 3) ? points.length : points.length - 1;
      for (let i = 0; i < edgeCount; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        const midLat = (a.lat + b.lat) / 2;
        const midLng = (a.lng + b.lng) / 2;
        const midMarker = L.marker([midLat, midLng], { icon: midpointIcon() });
        midMarker.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          points.splice(i + 1, 0, { lat: midLat, lng: midLng });
          selectedIndex = null;
          refreshEditButtons();
          redrawShape(group, points, closedPolygon, true);
          updateResults();
        });
        midMarker.addTo(group);
      }
    }
  }

  // Re-renders whichever point set is active, honoring editMode only for
  // that mode's layer group so a stale shape can't be dragged in the background.
  function renderAllShapes() {
    redrawShape(drawLayerGroup, drawPoints, true, mode === "draw" && editMode);
    redrawShape(recordLayerGroup, recordPoints, recordClosed, mode === "record" && editMode);
  }

  function refreshEditButtons() {
    const points = activePoints();
    const hasSelection = editMode && selectedIndex !== null;
    [document.getElementById("btn-edit-draw"), document.getElementById("btn-edit-record")].forEach(btn => {
      btn.classList.toggle("active", editMode);
    });
    [document.getElementById("btn-delete-node-draw"), document.getElementById("btn-delete-node-record")].forEach(btn => {
      btn.disabled = !(hasSelection && points.length > 3);
    });
  }

  function setEditMode(on) {
    if (on) {
      const points = activePoints();
      if (points.length < 3) {
        showToast("Add at least 3 points before editing nodes.");
        return;
      }
      if (mode === "record" && recording && !paused) {
        showToast("Pause or finish recording before editing nodes.");
        return;
      }
    }
    editMode = on;
    selectedIndex = null;
    refreshEditButtons();
    renderAllShapes();
  }

  function deleteSelectedNode() {
    if (selectedIndex === null) return;
    const points = activePoints();
    if (points.length <= 3) {
      showToast("A polygon needs at least 3 points.");
      return;
    }
    points.splice(selectedIndex, 1);
    selectedIndex = null;
    refreshEditButtons();
    renderAllShapes();
    updateResults();
  }

  function updateResults() {
    const points = mode === "draw" ? drawPoints : recordPoints;
    const area = polygonAreaM2(points);
    const perim = perimeterM(points, points.length >= 3);
    document.getElementById("result-area").textContent = formatArea(area);
    document.getElementById("result-perimeter").textContent = formatLength(perim);
    document.getElementById("result-points").textContent =
      `${points.length} point${points.length === 1 ? "" : "s"}`;
  }

  map.on("click", (e) => {
    if (mode !== "draw") return;
    if (editMode) {
      if (selectedIndex !== null) {
        selectedIndex = null;
        refreshEditButtons();
        renderAllShapes();
      }
      return;
    }
    drawPoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    renderAllShapes();
    updateResults();
  });

  document.getElementById("btn-undo").addEventListener("click", () => {
    drawPoints.pop();
    if (selectedIndex !== null && selectedIndex >= drawPoints.length) selectedIndex = null;
    refreshEditButtons();
    renderAllShapes();
    updateResults();
  });

  document.getElementById("btn-clear").addEventListener("click", () => {
    drawPoints = [];
    setEditMode(false);
    renderAllShapes();
    updateResults();
  });

  document.getElementById("btn-edit-draw").addEventListener("click", () => setEditMode(!editMode));
  document.getElementById("btn-edit-record").addEventListener("click", () => setEditMode(!editMode));
  document.getElementById("btn-delete-node-draw").addEventListener("click", deleteSelectedNode);
  document.getElementById("btn-delete-node-record").addEventListener("click", deleteSelectedNode);

  // ------------------------------------------------------- record mode UI
  const recStart = document.getElementById("btn-rec-start");
  const recPause = document.getElementById("btn-rec-pause");
  const recResume = document.getElementById("btn-rec-resume");
  const recFinish = document.getElementById("btn-rec-finish");
  const recClear = document.getElementById("btn-rec-clear");

  function setRecordButtons() {
    recStart.classList.toggle("hidden", recording);
    recPause.classList.toggle("hidden", !(recording && !paused));
    recResume.classList.toggle("hidden", !(recording && paused));
    recFinish.classList.toggle("hidden", !recording);
  }

  recStart.addEventListener("click", () => {
    recordPoints = [];
    recording = true;
    paused = false;
    recordClosed = false;
    setEditMode(false);
    setRecordButtons();
    updateResults();
    showToast("Recording started — walk the boundary.");
  });

  recPause.addEventListener("click", () => {
    paused = true;
    setRecordButtons();
    showToast("Paused. Resume to continue — the gap will be a straight line.");
  });

  recResume.addEventListener("click", () => {
    paused = false;
    setRecordButtons();
  });

  recFinish.addEventListener("click", () => {
    recording = false;
    paused = false;
    recordClosed = true;
    setRecordButtons();
    renderAllShapes();
    updateResults();
    showToast("Boundary finished.");
  });

  recClear.addEventListener("click", () => {
    recording = false;
    paused = false;
    recordPoints = [];
    recordClosed = false;
    setEditMode(false);
    setRecordButtons();
    updateResults();
  });

  function maybeRecordPoint(lat, lng) {
    if (!(mode === "record" && recording && !paused)) return;
    recordPoints.push({ lat, lng });
    renderAllShapes();
    updateResults();
  }

  // -------------------------------------------------------------- mode UI
  const btnDraw = document.getElementById("btn-draw");
  const btnRecord = document.getElementById("btn-record");
  const drawActions = document.getElementById("draw-actions");
  const recordActions = document.getElementById("record-actions");

  function setMode(next) {
    if (mode !== next) setEditMode(false);
    mode = next;
    btnDraw.classList.toggle("active", mode === "draw");
    btnRecord.classList.toggle("active", mode === "record");
    drawActions.classList.toggle("hidden", mode !== "draw");
    recordActions.classList.toggle("hidden", mode !== "record");
    updateResults();
  }

  btnDraw.addEventListener("click", () => setMode("draw"));
  btnRecord.addEventListener("click", () => setMode("record"));

  // ------------------------------------------------------- combo (type-or-pick)
  function createCombo(container, placeholder, getOptions, onInput) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.spellcheck = false;
    const list = document.createElement("ul");
    list.className = "combo-list hidden";
    container.appendChild(input);
    container.appendChild(list);

    function render() {
      const q = input.value.trim().toLowerCase();
      const options = getOptions();
      const filtered = q ? options.filter(o => o.toLowerCase().includes(q)) : options;
      list.innerHTML = "";
      if (!filtered.length) { list.classList.add("hidden"); return; }
      filtered.slice(0, 8).forEach(opt => {
        const li = document.createElement("li");
        li.textContent = opt;
        // mousedown (not click) fires before the input's blur hides the list
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          input.value = opt;
          list.classList.add("hidden");
          if (onInput) onInput(input.value);
        });
        list.appendChild(li);
      });
      list.classList.remove("hidden");
    }

    input.addEventListener("focus", render);
    input.addEventListener("input", () => { render(); if (onInput) onInput(input.value); });
    input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));

    return {
      get value() { return input.value.trim(); },
      set value(v) { input.value = v; },
      refresh: render
    };
  }

  // ------------------------------------------------------------- save modal
  const saveModal = document.getElementById("save-modal");
  const saveLabelInput = document.getElementById("save-label");
  const saveSummaryEl = document.getElementById("save-summary");

  let farmCombo, fieldCombo, blockCombo;
  farmCombo = createCombo(document.getElementById("combo-farm"), "Select or type a farm name",
    () => farmNames(),
    () => { fieldCombo.refresh(); blockCombo.refresh(); });
  fieldCombo = createCombo(document.getElementById("combo-field"), "Select or type a field name",
    () => fieldNames(farmCombo.value),
    () => { blockCombo.refresh(); });
  blockCombo = createCombo(document.getElementById("combo-block"), "Select or type a block name",
    () => blockNames(farmCombo.value, fieldCombo.value),
    () => {});

  function activePoints() {
    return mode === "draw" ? drawPoints : recordPoints;
  }

  function openSaveModal() {
    const points = activePoints();
    if (points.length < 3) {
      showToast("Add at least 3 points before saving.");
      return;
    }
    farmCombo.value = settings.lastFarm || "";
    fieldCombo.value = settings.lastField || "";
    blockCombo.value = settings.lastBlock || "";
    saveLabelInput.value = "";
    saveSummaryEl.textContent =
      `${formatArea(polygonAreaM2(points))} · ${formatLength(perimeterM(points, true))} · ${points.length} points`;
    saveModal.classList.remove("hidden");
  }

  document.getElementById("btn-save-draw").addEventListener("click", openSaveModal);
  document.getElementById("btn-save-record").addEventListener("click", openSaveModal);
  document.getElementById("btn-save-cancel").addEventListener("click", () => saveModal.classList.add("hidden"));

  document.getElementById("btn-save-confirm").addEventListener("click", () => {
    const farm = farmCombo.value, field = fieldCombo.value, block = blockCombo.value;
    if (!farm || !field || !block) {
      showToast("Farm, field and block are all required.");
      return;
    }
    const points = activePoints();
    if (points.length < 3) {
      showToast("Add at least 3 points before saving.");
      return;
    }
    const node = ensureBlockNode(farm, field, block);
    node.measurements.push({
      id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      savedAt: new Date().toISOString(),
      mode,
      label: saveLabelInput.value.trim(),
      points: points.map(p => ({ lat: p.lat, lng: p.lng })),
      areaM2: polygonAreaM2(points),
      perimeterM: perimeterM(points, true)
    });
    saveLibrary();
    settings.lastFarm = farm;
    settings.lastField = field;
    settings.lastBlock = block;
    saveSettings();
    saveModal.classList.add("hidden");
    showToast(`Saved to ${farm} / ${field} / ${block}`);
  });

  // ----------------------------------------------------------- browse modal
  const browseModal = document.getElementById("browse-modal");
  const browseListEl = document.getElementById("browse-list");
  const browseBreadcrumbEl = document.getElementById("browse-breadcrumb");
  const browseBackBtn = document.getElementById("btn-browse-back");
  const viewInfoEl = document.getElementById("view-info");

  function addBrowseRow(title, subtitle, onOpen, onDelete) {
    const row = document.createElement("div");
    row.className = "browse-row";

    const main = document.createElement("div");
    main.className = "browse-row-main";
    const titleEl = document.createElement("div");
    titleEl.className = "browse-row-title";
    titleEl.textContent = title;
    const subEl = document.createElement("div");
    subEl.className = "browse-row-sub";
    subEl.textContent = subtitle;
    main.appendChild(titleEl);
    main.appendChild(subEl);
    main.addEventListener("click", onOpen);

    const del = document.createElement("button");
    del.className = "browse-row-delete";
    del.textContent = "🗑";
    del.addEventListener("click", (e) => { e.stopPropagation(); onDelete(); });

    row.appendChild(main);
    row.appendChild(del);
    browseListEl.appendChild(row);
  }

  function renderBrowse() {
    browseListEl.innerHTML = "";
    browseBackBtn.style.visibility = browsePath.length ? "visible" : "hidden";

    if (browsePath.length === 0) {
      browseBreadcrumbEl.textContent = "Farms";
      const names = farmNames();
      if (!names.length) browseListEl.innerHTML = '<div class="browse-empty">No saved farms yet.</div>';
      names.forEach(name => {
        const count = fieldNames(name).length;
        addBrowseRow(name, `${count} field${count === 1 ? "" : "s"}`,
          () => { browsePath = [name]; renderBrowse(); },
          () => {
            if (!confirm(`Delete farm "${name}" and everything under it?`)) return;
            delete library.farms[name];
            saveLibrary();
            renderBrowse();
          });
      });
    } else if (browsePath.length === 1) {
      const [farm] = browsePath;
      browseBreadcrumbEl.textContent = `Farms / ${farm}`;
      const names = fieldNames(farm);
      if (!names.length) browseListEl.innerHTML = '<div class="browse-empty">No fields yet.</div>';
      names.forEach(name => {
        const count = blockNames(farm, name).length;
        addBrowseRow(name, `${count} block${count === 1 ? "" : "s"}`,
          () => { browsePath = [farm, name]; renderBrowse(); },
          () => {
            if (!confirm(`Delete field "${name}" and everything under it?`)) return;
            delete library.farms[farm].fields[name];
            saveLibrary();
            renderBrowse();
          });
      });
    } else if (browsePath.length === 2) {
      const [farm, field] = browsePath;
      browseBreadcrumbEl.textContent = `Farms / ${farm} / ${field}`;
      const names = blockNames(farm, field);
      if (!names.length) browseListEl.innerHTML = '<div class="browse-empty">No blocks yet.</div>';
      names.forEach(name => {
        const count = library.farms[farm].fields[field].blocks[name].measurements.length;
        addBrowseRow(name, `${count} measurement${count === 1 ? "" : "s"}`,
          () => { browsePath = [farm, field, name]; renderBrowse(); },
          () => {
            if (!confirm(`Delete block "${name}" and its measurements?`)) return;
            delete library.farms[farm].fields[field].blocks[name];
            saveLibrary();
            renderBrowse();
          });
      });
    } else {
      const [farm, field, block] = browsePath;
      browseBreadcrumbEl.textContent = `Farms / ${farm} / ${field} / ${block}`;
      const measurements = library.farms[farm].fields[field].blocks[block].measurements
        .slice()
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      if (!measurements.length) browseListEl.innerHTML = '<div class="browse-empty">No measurements yet.</div>';
      measurements.forEach(m => {
        const date = new Date(m.savedAt).toLocaleString();
        addBrowseRow(m.label || date, `${formatArea(m.areaM2)} · ${formatLength(m.perimeterM)} · ${date}`,
          () => viewMeasurement(m, [farm, field, block]),
          () => {
            if (!confirm("Delete this measurement?")) return;
            const arr = library.farms[farm].fields[field].blocks[block].measurements;
            const idx = arr.findIndex(x => x.id === m.id);
            if (idx >= 0) arr.splice(idx, 1);
            saveLibrary();
            renderBrowse();
          });
      });
    }
  }

  function viewMeasurement(m, pathArr) {
    browseModal.classList.add("hidden");
    viewLayerGroup.clearLayers();
    const poly = L.polygon(m.points.map(p => [p.lat, p.lng]), {
      color: "#29b6f6", weight: 3, fillColor: "#29b6f6", fillOpacity: 0.2
    }).addTo(viewLayerGroup);
    map.fitBounds(poly.getBounds(), { padding: [40, 40] });

    const date = new Date(m.savedAt).toLocaleString();
    viewInfoEl.innerHTML = "";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "view-info-title";
    title.textContent = pathArr.join(" / ") + (m.label ? " — " + m.label : "");
    const sub = document.createElement("div");
    sub.className = "view-info-sub";
    sub.textContent = `${formatArea(m.areaM2)} · ${formatLength(m.perimeterM)} · ${date}`;
    left.appendChild(title);
    left.appendChild(sub);

    const closeBtn = document.createElement("button");
    closeBtn.className = "view-info-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      viewLayerGroup.clearLayers();
      viewInfoEl.classList.add("hidden");
    });

    viewInfoEl.appendChild(left);
    viewInfoEl.appendChild(closeBtn);
    viewInfoEl.classList.remove("hidden");
  }

  document.getElementById("btn-browse").addEventListener("click", () => {
    browsePath = [];
    renderBrowse();
    browseModal.classList.remove("hidden");
  });
  document.getElementById("btn-browse-close").addEventListener("click", () => browseModal.classList.add("hidden"));
  browseBackBtn.addEventListener("click", () => { browsePath.pop(); renderBrowse(); });

  // ------------------------------------------------------------- geolocation
  function qualityFromAccuracy(acc) {
    if (acc == null || !isFinite(acc)) return "red";
    if (acc <= ACCURACY_GOOD_M) return "green";
    if (acc <= ACCURACY_FAIR_M) return "yellow";
    return "red";
  }

  const compassEl = document.getElementById("compass");
  const compassAccuracyEl = document.getElementById("compass-accuracy");
  const compassRoseEl = document.getElementById("compass-rose");

  function setCompassQuality(acc) {
    lastAccuracyM = acc;
    const q = qualityFromAccuracy(acc);
    compassEl.dataset.quality = q;
    compassAccuracyEl.textContent = (acc == null || !isFinite(acc))
      ? "no fix"
      : `±${formatLength(acc)}`;
  }

  function applyCompassRotation() {
    if (settings.rotateCompass && deviceHeadingDeg != null) {
      compassRoseEl.style.transform = `rotate(${-deviceHeadingDeg}deg)`;
    } else {
      compassRoseEl.style.transform = "rotate(0deg)";
    }
  }

  function onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    setCompassQuality(accuracy);
    if (!userMarker) {
      userMarker = L.circleMarker([latitude, longitude], {
        radius: 7, color: "#2196f3", fillColor: "#2196f3", fillOpacity: 0.9
      }).addTo(map);
    } else {
      userMarker.setLatLng([latitude, longitude]);
    }
    maybeRecordPoint(latitude, longitude);
  }

  function onPositionError() {
    setCompassQuality(null);
  }

  function startWatch() {
    if (!("geolocation" in navigator)) {
      setCompassQuality(null);
      showToast("Geolocation isn't available on this device/browser.");
      return;
    }
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000
    });
  }
  startWatch();

  document.getElementById("btn-locate").addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      showToast("Geolocation isn't available.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 18),
      () => showToast("Couldn't get your location."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // iOS 13+ gates DeviceOrientationEvent behind a user-gesture permission
  // prompt; everyone else just fires the event.
  function requestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then(state => {
        if (state === "granted") attachOrientationListener();
      }).catch(() => {});
    } else {
      attachOrientationListener();
    }
  }

  function attachOrientationListener() {
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
  }

  function onOrientation(e) {
    let heading = null;
    if (typeof e.webkitCompassHeading === "number") {
      heading = e.webkitCompassHeading;
    } else if (e.absolute && typeof e.alpha === "number") {
      heading = 360 - e.alpha;
    } else if (typeof e.alpha === "number") {
      heading = 360 - e.alpha;
    }
    if (heading != null) {
      deviceHeadingDeg = heading;
      applyCompassRotation();
    }
  }

  compassEl.addEventListener("click", requestOrientationPermission);
  requestOrientationPermission();

  // ------------------------------------------------------------- settings UI
  const modal = document.getElementById("settings-modal");
  const unitAreaSel = document.getElementById("unit-area");
  const unitLengthSel = document.getElementById("unit-length");
  const basemapSel = document.getElementById("unit-basemap");
  const rotateToggle = document.getElementById("toggle-compass-heading");

  function syncSettingsUI() {
    unitAreaSel.value = settings.areaUnit;
    unitLengthSel.value = settings.lengthUnit;
    basemapSel.value = settings.basemap;
    rotateToggle.checked = settings.rotateCompass;
  }

  document.getElementById("btn-settings").addEventListener("click", () => {
    syncSettingsUI();
    modal.classList.remove("hidden");
  });

  document.getElementById("btn-settings-close").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  unitAreaSel.addEventListener("change", () => {
    settings.areaUnit = unitAreaSel.value;
    saveSettings();
    updateResults();
  });

  unitLengthSel.addEventListener("change", () => {
    settings.lengthUnit = unitLengthSel.value;
    saveSettings();
    updateResults();
    setCompassQuality(lastAccuracyM);
  });

  basemapSel.addEventListener("change", () => {
    settings.basemap = basemapSel.value;
    saveSettings();
    applyBasemap();
  });

  rotateToggle.addEventListener("change", () => {
    settings.rotateCompass = rotateToggle.checked;
    saveSettings();
    applyCompassRotation();
  });

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
  }

  // ------------------------------------------------------------------ init
  setCompassQuality(null);
  setRecordButtons();
  refreshEditButtons();
  updateResults();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
