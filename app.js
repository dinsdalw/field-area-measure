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

  function vertexIcon() {
    return L.divIcon({ className: "vertex-dot", html: "", iconSize: [12, 12] });
  }

  // --------------------------------------------------------- draw mode UI
  function redrawShape(group, points, closedPolygon) {
    group.clearLayers();
    points.forEach(p => L.marker([p.lat, p.lng], { icon: vertexIcon() }).addTo(group));
    if (points.length >= 2) {
      if (closedPolygon && points.length >= 3) {
        L.polygon(points.map(p => [p.lat, p.lng]), {
          color: "#ffeb3b", weight: 3, fillColor: "#ffeb3b", fillOpacity: 0.18
        }).addTo(group);
      } else {
        L.polyline(points.map(p => [p.lat, p.lng]), { color: "#ffeb3b", weight: 3 }).addTo(group);
      }
    }
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
    drawPoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    redrawShape(drawLayerGroup, drawPoints, true);
    updateResults();
  });

  document.getElementById("btn-undo").addEventListener("click", () => {
    drawPoints.pop();
    redrawShape(drawLayerGroup, drawPoints, true);
    updateResults();
  });

  document.getElementById("btn-clear").addEventListener("click", () => {
    drawPoints = [];
    redrawShape(drawLayerGroup, drawPoints, true);
    updateResults();
  });

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
    setRecordButtons();
    redrawShape(recordLayerGroup, recordPoints, false);
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
    setRecordButtons();
    redrawShape(recordLayerGroup, recordPoints, true);
    updateResults();
    showToast("Boundary finished.");
  });

  recClear.addEventListener("click", () => {
    recording = false;
    paused = false;
    recordPoints = [];
    setRecordButtons();
    redrawShape(recordLayerGroup, recordPoints, false);
    updateResults();
  });

  function maybeRecordPoint(lat, lng) {
    if (!(mode === "record" && recording && !paused)) return;
    recordPoints.push({ lat, lng });
    redrawShape(recordLayerGroup, recordPoints, false);
    updateResults();
  }

  // -------------------------------------------------------------- mode UI
  const btnDraw = document.getElementById("btn-draw");
  const btnRecord = document.getElementById("btn-record");
  const drawActions = document.getElementById("draw-actions");
  const recordActions = document.getElementById("record-actions");

  function setMode(next) {
    mode = next;
    btnDraw.classList.toggle("active", mode === "draw");
    btnRecord.classList.toggle("active", mode === "record");
    drawActions.classList.toggle("hidden", mode !== "draw");
    recordActions.classList.toggle("hidden", mode !== "record");
    updateResults();
  }

  btnDraw.addEventListener("click", () => setMode("draw"));
  btnRecord.addEventListener("click", () => setMode("record"));

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
  updateResults();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    });
  }
})();
