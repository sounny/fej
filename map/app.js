const map = L.map('map').setView([28.5, -82], 6);

// Define different base layers
const baseLayers = {
  "Dark Theme": L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors © CARTO'
  }),
  "Aerial Photos": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '© Esri © USGS © NOAA'
  }),
  "Street Map": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
  }),
  "Light Theme": L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors © CARTO'
  })
};

// Add the default layer (Dark Theme)
baseLayers["Dark Theme"].addTo(map);

// Add layer control
const layerControl = L.control.layers(baseLayers, null, {
  position: 'bottomleft',
  collapsed: false
}).addTo(map);

const clusterGroup = L.markerClusterGroup({
  iconCreateFunction: (cluster) => {
    const count = cluster.getChildCount();
    let size = 'small';
    if (count >= 50 && count < 100) size = 'medium';
    else if (count >= 100 && count < 200) size = 'large';
    else if (count >= 200) size = 'xlarge';
    return L.divIcon({
      html: `<div><span>${count}</span></div>`,
      className: 'marker-cluster marker-cluster-' + size,
      iconSize: [40, 40]
    });
  }
});
map.addLayer(clusterGroup);

const bufferLayer = L.layerGroup().addTo(map);
const selectedMarkersLayer = L.layerGroup().addTo(map);
let sites = [];
let selectedMarkers = new Set();
let allMarkers = [];
let currentData = [];
let proximalMiles = 0;
let distalMiles = 0;
const CENSUS_API_KEY = 'e2677b4b093f3854677b6ba1d053c918520641ae';
let ACS_YEAR = 2023; // now mutable based on UI
let GEO_LEVEL = 'tract'; // default to tract per request
let demographicChart;
let lastAnalysis = null; // store last computed values for export
const highlightLayer = L.layerGroup().addTo(map);

// Sync GEO_LEVEL from UI if available at startup
(function initGeoFromUI(){
  const sel = document.getElementById('geographySelect');
  if (sel && sel.value) GEO_LEVEL = sel.value;
})();

// Cross-window highlight messaging: report -> main map
window.addEventListener('message', (e) => {
  if (!e || !e.data) return;
  if (e.data.type === 'highlight-point') {
    const { lat, lng, proximalMiles: pMi, distalMiles: dMi } = e.data;
    highlightLayer.clearLayers();
    const latLng = [lat, lng];
    L.circleMarker(latLng, { radius: 8, color: '#FFD60A', fillColor: '#FFD60A', fillOpacity: 0.9, weight: 2 }).addTo(highlightLayer);
    if (pMi && pMi > 0) L.circle(latLng, { radius: pMi * 1609.34, color: '#FFD60A', weight: 2, dashArray: '4 4', fill: false }).addTo(highlightLayer);
    if (dMi && dMi > 0) L.circle(latLng, { radius: dMi * 1609.34, color: '#FFA500', weight: 2, dashArray: '4 4', fill: false }).addTo(highlightLayer);
  } else if (e.data.type === 'clear-highlight') {
    highlightLayer.clearLayers();
  }
});

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(row => {
    const values = row.split(',');
    const obj = {};
    headers.forEach((h,i)=>{ obj[h]=values[i]; });
    return obj;
  });
}

async function loadDataset(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    return parseCSV(text);
  } catch (e) {
    console.error('Failed to load dataset', e);
    return [];
  }
}

function createMarker(lat, lng, data) {
  const marker = L.marker([lat, lng]);
  
  // Store the original data with the marker
  marker.originalData = data;
  marker.isSelected = false;
  
  // Create popup content
  const popupContent = Object.entries(data)
    .map(([key, value]) => `<strong>${key}:</strong> ${value}`)
    .join('<br>');
  marker.bindPopup(popupContent);
  
  // Add click handler for selection
  marker.on('click', function(e) {
    L.DomEvent.stopPropagation(e);
    toggleMarkerSelection(marker);
  });
  
  return marker;
}

function toggleMarkerSelection(marker) {
  if (marker.isSelected) {
    // Deselect marker
    marker.isSelected = false;
    selectedMarkers.delete(marker);
    
    // Remove from selected layer
    selectedMarkersLayer.eachLayer(layer => {
      if (layer.getLatLng().equals(marker.getLatLng())) {
        selectedMarkersLayer.removeLayer(layer);
      }
    });
  } else {
    // Select marker
    marker.isSelected = true;
    selectedMarkers.add(marker);
    
    // Create a red marker for the selected layer
    const selectedMarker = L.marker(marker.getLatLng(), {
      icon: L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
      })
    });
    selectedMarker.originalData = marker.originalData;
    selectedMarker.bindPopup(marker.getPopup().getContent());
    selectedMarkersLayer.addLayer(selectedMarker);
  }
  
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const count = selectedMarkers.size;
  const info = document.getElementById('selectionCount');
  if (info) {
    info.textContent = `Selected Points: ${count}`;
  }
}

function clearSelection() {
  selectedMarkers.forEach(marker => {
    marker.isSelected = false;
  });
  selectedMarkers.clear();
  selectedMarkersLayer.clearLayers();
  bufferLayer.clearLayers();
  updateSelectionInfo();
}

function updateMarkers(data) {
  clusterGroup.clearLayers();
  bufferLayer.clearLayers();
  selectedMarkersLayer.clearLayers();
  selectedMarkers.clear();
  sites = [];
  allMarkers = [];
  currentData = data;
  
  data.forEach(row => {
    const lat = parseFloat(row.Latitude || row.lat || row.LAT);
    const lng = parseFloat(row.Longitude || row.lng || row.LNG || row.lon || row.LON);
    if (!isNaN(lat) && !isNaN(lng)) {
      const marker = createMarker(lat, lng, row);
      clusterGroup.addLayer(marker);
      allMarkers.push(marker);
      sites.push([lat, lng]);
    }
  });
  
  updateSelectionInfo();
}

function updateBuffers() {
  bufferLayer.clearLayers();
  if (selectedMarkers.size === 0) {
    return;
  }
  
  selectedMarkers.forEach(marker => {
    const lat = marker.getLatLng().lat;
    const lng = marker.getLatLng().lng;
    
    if (distalMiles > 0) {
      L.circle([lat, lng], {
        radius: distalMiles * 1609.34,
        color: '#F57C00',
        weight: 1,
        fill: false
      }).addTo(bufferLayer);
    }
    if (proximalMiles > 0) {
      L.circle([lat, lng], {
        radius: proximalMiles * 1609.34,
        color: '#1976D2',
        weight: 1,
        fill: false
      }).addTo(bufferLayer);
    }
  });
}

// dataset list click
Array.from(document.querySelectorAll('#dataStep li')).forEach(li => {
  li.addEventListener('click', async () => {
    const url = li.dataset.url;
    const data = await loadDataset(url);
    updateMarkers(data);
  });
});

// file upload
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const data = parseCSV(text);
  updateMarkers(data);
});

// proximal and distal sliders
const proximalSlider = document.getElementById('proximalSlider');
const distalSlider = document.getElementById('distalSlider');
const proximalValue = document.getElementById('proximalValue');
const distalValue = document.getElementById('distalValue');

function updateDistalMin() {
  distalSlider.min = proximalMiles.toString();
  if (parseFloat(distalSlider.value) < proximalMiles) {
    distalSlider.value = proximalMiles;
    distalMiles = proximalMiles;
    distalValue.textContent = distalMiles.toFixed(2);
  }
}

proximalSlider.addEventListener('input', () => {
  proximalMiles = parseFloat(proximalSlider.value);
  proximalValue.textContent = proximalMiles.toFixed(2);
  updateDistalMin();
  if (selectedMarkers.size > 0) {
    updateBuffers();
  }
});

distalSlider.addEventListener('input', () => {
  distalMiles = Math.max(parseFloat(distalSlider.value), proximalMiles);
  distalSlider.value = distalMiles;
  distalValue.textContent = distalMiles.toFixed(2);
  if (selectedMarkers.size > 0) {
    updateBuffers();
  }
});

// about button
document.getElementById('aboutBtn').addEventListener('click', () => {
  window.location.href = 'https://sounny.github.io/fej';
});

// Chart actions: wire up buttons
const chartPopoutBtn = document.getElementById('chartPopoutBtn');
const downloadPngBtn = document.getElementById('downloadPngBtn');
const downloadCsvBtn = document.getElementById('downloadCsvBtn');

if (chartPopoutBtn) {
  chartPopoutBtn.addEventListener('click', () => {
    openChartPopout();
  });
}
if (downloadPngBtn) {
  downloadPngBtn.addEventListener('click', () => {
    if (!demographicChart) return;
    const a = document.createElement('a');
    a.href = demographicChart.toBase64Image();
    a.download = 'chart.png';
    a.click();
  });
}
if (downloadCsvBtn) {
  downloadCsvBtn.addEventListener('click', () => {
    if (!lastAnalysis) return;
    const csv = buildCsvFromLastAnalysis();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'analysis.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function getBlockGroups(lat, lng, radiusMeters) {
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/10/query?where=1%3D1&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${radiusMeters}&units=esriSRUnit_Meter&outFields=STATE,COUNTY,TRACT,BLKGRP&returnGeometry=false&f=json`;
  const res = await fetch(url);
  const data = await res.json();
  return data.features ? data.features.map(f => f.attributes) : [];
}

async function getTracts(lat, lng, radiusMeters) {
  // TIGERweb Current Tracts layer is 8 in tigerWMS_Current MapServer
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/8/query?where=1%3D1&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${radiusMeters}&units=esriSRUnit_Meter&outFields=STATE,COUNTY,TRACT&returnGeometry=false&f=json`;
  const res = await fetch(url);
  const data = await res.json();
  return data.features ? data.features.map(f => f.attributes) : [];
}

async function fetchACSCount(state, county, tract, blkgrp, variables, totalVar) {
  const queryVars = [totalVar, ...variables].join(',');
  let url;
  if (GEO_LEVEL === 'tract') {
    url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${queryVars}&for=tract:${tract}&in=state:${state}%20county:${county}&key=${CENSUS_API_KEY}`;
  } else {
    url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${queryVars}&for=block%20group:${blkgrp}&in=state:${state}%20county:${county}%20tract:${tract}&key=${CENSUS_API_KEY}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Census API request failed with status ${res.status}`);
  }
  const data = await res.json();
  const row = data[1];
  const pop = parseInt(row[0]);
  let value = 0;
  for (let i = 1; i <= variables.length; i++) {
    value += parseInt(row[i]);
  }
  return { pop, value };
}

async function fetchACSMedian(state, county, tract, blkgrp, variable) {
  let url;
  if (GEO_LEVEL === 'tract') {
    url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${variable}&for=tract:${tract}&in=state:${state}%20county:${county}&key=${CENSUS_API_KEY}`;
  } else {
    url = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${variable}&for=block%20group:${blkgrp}&in=state:${state}%20county:${county}%20tract:${tract}&key=${CENSUS_API_KEY}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Census API request failed with status ${res.status}`);
  }
  const data = await res.json();
  const row = data[1];
  return parseInt(row[0]);
}

async function compileDemographics() {
  const select = document.getElementById('demographicSelect');
  const option = select.selectedOptions[0];
  const variables = option.dataset.variables.split(',');
  const label = option.dataset.label;
  const totalVar = option.dataset.total;
  const type = option.dataset.type;
  const proxRadius = proximalMiles * 1609.34;
  if (proxRadius <= 0 || selectedMarkers.size === 0) {
    alert('Please select points and set a proximal buffer distance.');
    return;
  }

  const distRadius = distalMiles * 1609.34;
  const proximalSet = new Set();
  const distalSet = new Set();
  const proxUnitDetails = [];
  const distUnitDetails = [];
  const pointSummaries = []; // per-selected-point summary for proximal ring

  for (const marker of selectedMarkers) {
    const lat = marker.getLatLng().lat;
    const lng = marker.getLatLng().lng;
    try {
      if (GEO_LEVEL === 'tract') {
        const proxTracts = await getTracts(lat, lng, proxRadius);
        proxTracts.forEach(t => proximalSet.add(`${t.STATE}|${t.COUNTY}|${t.TRACT}`));
        if (distRadius > proxRadius) {
          const distTracts = await getTracts(lat, lng, distRadius);
          distTracts.forEach(t => distalSet.add(`${t.STATE}|${t.COUNTY}|${t.TRACT}`));
        }
        // per-point proximal summary
        let pPop = 0, pMetric = 0, pCount = 0;
        if (proxTracts && proxTracts.length) {
          for (const t of proxTracts) {
            try {
              if (type === 'median') {
                const med = await fetchACSMedian(t.STATE, t.COUNTY, t.TRACT, undefined, variables[0]);
                if (!isNaN(med)) { pMetric += med; pCount++; }
              } else {
                const d = await fetchACSCount(t.STATE, t.COUNTY, t.TRACT, undefined, variables, totalVar);
                if (!isNaN(d.pop) && !isNaN(d.value)) { pPop += d.pop; pMetric += d.value; }
              }
            } catch {}
          }
        }
        const perPointValue = type === 'median' ? (pCount > 0 ? pMetric / pCount : 0) : (pPop > 0 ? (pMetric / pPop) * 1000 : 0);
        pointSummaries.push({ lat, lng, value: perPointValue, units: proxTracts.length });
      } else {
        const proxBgs = await getBlockGroups(lat, lng, proxRadius);
        proxBgs.forEach(bg => proximalSet.add(`${bg.STATE}|${bg.COUNTY}|${bg.TRACT}|${bg.BLKGRP}`));
        if (distRadius > proxRadius) {
          const distBgs = await getBlockGroups(lat, lng, distRadius);
          distBgs.forEach(bg => distalSet.add(`${bg.STATE}|${bg.COUNTY}|${bg.TRACT}|${bg.BLKGRP}`));
        }
        // per-point proximal summary
        let pPop = 0, pMetric = 0, pCount = 0;
        if (proxBgs && proxBgs.length) {
          for (const bg of proxBgs) {
            try {
              if (type === 'median') {
                const med = await fetchACSMedian(bg.STATE, bg.COUNTY, bg.TRACT, bg.BLKGRP, variables[0]);
                if (!isNaN(med)) { pMetric += med; pCount++; }
              } else {
                const d = await fetchACSCount(bg.STATE, bg.COUNTY, bg.TRACT, bg.BLKGRP, variables, totalVar);
                if (!isNaN(d.pop) && !isNaN(d.value)) { pPop += d.pop; pMetric += d.value; }
              }
            } catch {}
          }
        }
        const perPointValue = type === 'median' ? (pCount > 0 ? pMetric / pCount : 0) : (pPop > 0 ? (pMetric / pPop) * 1000 : 0);
        pointSummaries.push({ lat, lng, value: perPointValue, units: proxBgs.length });
      }
    } catch (error) {
      console.error(`Error getting geographies for marker at ${lat}, ${lng}:`, error);
    }
  }

  // remove overlaps (prox included in dist)
  proximalSet.forEach(k => distalSet.delete(k));

  let proxMetric = 0, distMetric = 0;
  let proxPop = 0, distPop = 0;
  let proxCount = 0, distCount = 0;

  for (const key of proximalSet) {
    const parts = key.split('|');
    const [s, c, t] = parts;
    const b = GEO_LEVEL === 'tract' ? undefined : parts[3];
    try {
      if (type === 'median') {
        const median = await fetchACSMedian(s, c, t, b, variables[0]);
        if (!isNaN(median)) {
          proxMetric += median;
          proxCount++;
          proxUnitDetails.push({ s, c, t, b, median });
        }
      } else {
        const data = await fetchACSCount(s, c, t, b, variables, totalVar);
        if (!isNaN(data.pop) && !isNaN(data.value)) {
          proxPop += data.pop;
          proxMetric += data.value;
          const ratePer1k = data.pop > 0 ? (data.value / data.pop) * 1000 : 0;
          proxUnitDetails.push({ s, c, t, b, pop: data.pop, value: data.value, ratePer1k });
        }
      }
    } catch (error) {
      console.error(`Error fetching ACS data for ${key}:`, error);
    }
  }

  for (const key of distalSet) {
    const parts = key.split('|');
    const [s, c, t] = parts;
    const b = GEO_LEVEL === 'tract' ? undefined : parts[3];
    try {
      if (type === 'median') {
        const median = await fetchACSMedian(s, c, t, b, variables[0]);
        if (!isNaN(median)) {
          distMetric += median;
          distCount++;
          distUnitDetails.push({ s, c, t, b, median });
        }
      } else {
        const data = await fetchACSCount(s, c, t, b, variables, totalVar);
        if (!isNaN(data.pop) && !isNaN(data.value)) {
          distPop += data.pop;
          distMetric += data.value;
          const ratePer1k = data.pop > 0 ? (data.value / data.pop) * 1000 : 0;
          distUnitDetails.push({ s, c, t, b, pop: data.pop, value: data.value, ratePer1k });
        }
      }
    } catch (error) {
      console.error(`Error fetching ACS data for ${key}:`, error);
    }
  }

  let proxValue, distValue, chartLabel;
  if (type === 'median') {
    proxValue = proxCount > 0 ? proxMetric / proxCount : 0;
    distValue = distCount > 0 ? distMetric / distCount : 0;
    chartLabel = label;
  } else {
    proxValue = proxPop > 0 ? (proxMetric / proxPop) * 1000 : 0;
    distValue = distPop > 0 ? (distMetric / distPop) * 1000 : 0;
    chartLabel = `${label} per 1,000 residents`;
  }

  const chartContainer = document.getElementById('chartContainer');
  chartContainer.innerHTML = '<canvas id="demographicChart"></canvas>';
  const ctx = document.getElementById('demographicChart').getContext('2d');
  if (demographicChart) {
    demographicChart.destroy();
  }

  demographicChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Proximal', 'Distal'],
      datasets: [{
        label: chartLabel,
        data: [proxValue, distValue],
        backgroundColor: ['#1976D2', '#F57C00']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: 'Proximal vs Distal Comparison' },
        legend: { display: true }
      },
      scales: { y: { beginAtZero: true } }
    }
  });

  // Render chart meta and details outside canvas to avoid overlap
  const chartMeta = document.getElementById('chartMeta');
  if (chartMeta) {
    const geoLabel = GEO_LEVEL === 'tract' ? 'Census Tract' : 'Census Block Group';
    const metaHtml = `ACS ${ACS_YEAR} • ${geoLabel} • Prox ${proximalMiles.toFixed(2)} mi • Dist ${distalMiles.toFixed(2)} mi`;
    chartMeta.textContent = metaHtml;
  }

  // Append details panel below chart (not inside chartContainer canvas wrapper)
  const detailsExisting = document.getElementById('bgDetails');
  if (detailsExisting) detailsExisting.remove();
  const metaHost = document.getElementById('chartMeta') || document.getElementById('chartContainer');
  const fmt = (k) => {
    const p = k.split('|');
    return GEO_LEVEL === 'tract' ? `${p[0]}-${p[1]}-${p[2]}` : `${p[0]}-${p[1]}-${p[2]}-${p[3]}`;
  };
  const proxList = Array.from(proximalSet).map(fmt).join(', ');
  const distList = Array.from(distalSet).map(fmt).join(', ');
  const detailsHtml = `
    <details id="bgDetails" style="margin-top:6px">
      <summary>Data year & geographies used</summary>
      <div><strong>ACS year:</strong> ${ACS_YEAR} (acs5)</div>
      <div><strong>Geography:</strong> ${GEO_LEVEL === 'tract' ? 'Census Tract' : 'Census Block Group'}</div>
      <div><strong>Proximal ${GEO_LEVEL === 'tract' ? 'Tracts' : 'BGs'} (${proximalSet.size}):</strong><br><code style="white-space: normal; word-break: break-word;">${proxList || 'None'}</code></div>
      <div><strong>Distal ${GEO_LEVEL === 'tract' ? 'Tracts' : 'BGs'} (${distalSet.size}):</strong><br><code style="white-space: normal; word-break: break-word;">${distList || 'None'}</code></div>
    </details>
  `;
  metaHost.insertAdjacentHTML('beforeend', detailsHtml);

  // Ensure buttons are enabled and clickable
  const popBtn = document.getElementById('chartPopoutBtn');
  const pngBtn = document.getElementById('downloadPngBtn');
  const csvBtn = document.getElementById('downloadCsvBtn');
  [popBtn, pngBtn, csvBtn].forEach(btn => { if (btn) { btn.disabled = false; btn.tabIndex = 0; } });

  // Persist last analysis for export
  lastAnalysis = {
    acsYear: ACS_YEAR,
    geography: GEO_LEVEL,
    label,
    type,
    chartLabel,
    proxValue,
    distValue,
    proximalSet: Array.from(proximalSet),
    distalSet: Array.from(distalSet),
    proximalMiles,
    distalMiles,
  proxUnits: proxUnitDetails,
  distUnits: distUnitDetails,
  pointSummaries
  };
}

// Wire up ACS year and geography selectors
const acsYearSelect = document.getElementById('acsYearSelect');
if (acsYearSelect) {
  acsYearSelect.addEventListener('change', () => {
    ACS_YEAR = parseInt(acsYearSelect.value, 10);
  });
}

const geographySelect = document.getElementById('geographySelect');
if (geographySelect) {
  geographySelect.addEventListener('change', () => {
    GEO_LEVEL = geographySelect.value; // 'bg' or 'tract'
  });
}

document.getElementById('clearSelectionBtn').addEventListener('click', clearSelection);

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  if (selectedMarkers.size === 0) {
    alert('Please select points first by clicking on markers, then try again.');
    return;
  }
  updateBuffers();
  const chartContainer = document.getElementById('chartContainer');
  chartContainer.innerHTML = '<div class="loading">Loading...</div>';
  await compileDemographics();
});

// Address Search Functionality
let searchMarker;
const FLORIDA_VIEWBOX = '-87.6349,31.000968,-79.974307,24.396308';

async function searchAddress() {
  const query = document.getElementById('search-input').value;
  if (!query) return;

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=us&viewbox=${FLORIDA_VIEWBOX}`;
  const searchBtn = document.getElementById('search-btn');
  searchBtn.textContent = 'Searching...';
  searchBtn.disabled = true;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data && data.length > 0) {
      const { lat, lon, display_name } = data[0];
      const latLng = [parseFloat(lat), parseFloat(lon)];

      map.flyTo(latLng, 14);

      if (searchMarker) {
        if (searchMarker.isSelected) {
          toggleMarkerSelection(searchMarker);
        }
        map.removeLayer(searchMarker);
      }

      searchMarker = createMarker(latLng[0], latLng[1], { 'Search Result': display_name });
      searchMarker.addTo(map).openPopup();

    } else {
      alert('Address not found. Please try a different search.');
    }
  } catch (error) {
    console.error('Error during geocoding search:', error);
    alert('An error occurred while searching for the address.');
  } finally {
    searchBtn.textContent = 'Search';
    searchBtn.disabled = false;
  }
}

document.getElementById('search-btn').addEventListener('click', searchAddress);
document.getElementById('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    searchAddress();
  }
});

// Chart actions: popout, PNG, CSV
function openChartPopout() {
  if (!demographicChart || !lastAnalysis) return;
  const w = window.open('', 'analysisReport', 'width=1100,height=800');
  if (!w) return;

  const chartImg = demographicChart.toBase64Image();
  const title = lastAnalysis.chartLabel;
  const center = map.getCenter();
  const zoom = map.getZoom();
  const selPoints = Array.from(selectedMarkers).map(m=>({lat:m.getLatLng().lat,lng:m.getLatLng().lng}));
  const proxMi = proximalMiles;
  const distMi = distalMiles;
  const geoName = lastAnalysis.geography==='tract'?'Tract':'Block Group';
  const perPointRows = (lastAnalysis.pointSummaries||[])
    .map((p,i)=>`<tr data-lat="${p.lat}" data-lng="${p.lng}"><td>${i+1}</td><td>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</td><td>${p.units}</td><td>${Number(p.value).toFixed(2)}</td></tr>`)
    .join('');

  const css = `
    body{margin:0;background:#0F172A;color:#fff;font-family:Arial,sans-serif}
    header{padding:16px 20px;background:#111827;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
    h1{font-size:18px;margin:0}
    .wrap{padding:16px}
    .section{margin-bottom:16px;background:#111827;border-radius:8px;overflow:hidden;border:1px solid #1F2937}
    .section h2{margin:0;padding:10px 12px;background:#1F2937;font-size:15px}
    .content{padding:12px}
    .table-wrap{overflow:auto}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border:1px solid #374151;padding:6px 8px;text-align:left}
    th{background:#2C3A52}
    tr:hover{background:#0B2948}
    #miniMap{height:360px}
    .pill{display:inline-block;background:#2563EB;padding:2px 8px;border-radius:999px;font-size:12px;margin-right:6px}
    .chips{display:flex;gap:6px;flex-wrap:wrap}
  `;

  const siteList = selPoints.map((p,i)=>`<li>#${i+1}: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</li>`).join('');

  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <style>${css}</style></head><body>
    <header>
      <h1>${title}</h1>
      <div class="chips">
        <span class="pill">ACS ${lastAnalysis.acsYear}</span>
        <span class="pill">${geoName}</span>
        <span class="pill">Prox ${proxMi} mi</span>
        <span class="pill">Dist ${distMi} mi</span>
      </div>
    </header>
    <div class="wrap">
      <div class="section">
        <h2>Summary Chart</h2>
        <div class="content"><img src="${chartImg}" alt="Chart" style="max-width:100%"></div>
      </div>
      <div class="section">
        <h2>Sites</h2>
        <div class="content"><ul>${siteList||'<li>No sites</li>'}</ul></div>
      </div>
      <div class="section">
        <h2>Per-point Results (proximal ring)</h2>
        <div class="content table-wrap">
          <table id="pointsTable">
            <thead><tr><th>#</th><th>Point (lat, lon)</th><th>${geoName}s in Prox</th><th>${lastAnalysis.type==='median'?'Median':'Rate per 1000'}</th></tr></thead>
            <tbody>${perPointRows||'<tr><td colspan="4">No data</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="section">
        <h2>Map & Buffers</h2>
        <div class="content"><div id="miniMap"></div></div>
      </div>
    </div>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script>
      const map2 = L.map('miniMap').setView([${center.lat}, ${center.lng}], ${Math.max(5, Math.min(12, zoom))});
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map2);
      const points = ${JSON.stringify(selPoints)};
      const proxR = ${proxMi*1609.34};
      const distR = ${distMi*1609.34};
      const mkGroup = L.featureGroup().addTo(map2);
      points.forEach(p=>{
        const mk = L.circleMarker([p.lat,p.lng],{radius:6,color:'#fff',fillColor:'#2563EB',fillOpacity:1,weight:2}).addTo(mkGroup);
        if (proxR>0) L.circle([p.lat,p.lng],{radius:proxR,color:'#1976D2',weight:1,fill:false}).addTo(mkGroup);
        if (distR>0) L.circle([p.lat,p.lng],{radius:distR,color:'#F57C00',weight:1,fill:false}).addTo(mkGroup);
      });
      if (points.length){ map2.fitBounds(mkGroup.getBounds().pad(0.25)); }

      // Hover interaction to highlight on the main map
      const tbody = document.querySelector('#pointsTable tbody');
      if (tbody && window.opener) {
        tbody.addEventListener('mouseover', (ev)=>{
          const tr = ev.target.closest('tr');
          if (!tr) return;
          const lat = parseFloat(tr.getAttribute('data-lat'));
          const lng = parseFloat(tr.getAttribute('data-lng'));
          if (!isNaN(lat) && !isNaN(lng)) {
            window.opener.postMessage({type:'highlight-point', lat, lng, proximalMiles:${proxMi}, distalMiles:${distMi}}, '*');
          }
        });
        tbody.addEventListener('mouseout', ()=>{
          window.opener.postMessage({type:'clear-highlight'}, '*');
        });
      }

      // Optional: fetch and draw geographies outlines (limited for performance)
      const geoLevel = ${JSON.stringify(lastAnalysis.geography)};
      const keys = ${JSON.stringify(lastAnalysis.proximalSet.slice(0, 50))}; // limit to 50
      const layerId = geoLevel==='tract'?8:10;
      async function drawGeos(){
        for (const k of keys){
          const parts = k.split('|');
          const s = parts[0];
          const c = parts[1];
          const t = parts[2];
          const b = parts[3];
          var where = "STATE='" + s + "' AND COUNTY='" + c + "' AND TRACT='" + t + "'";
          if (geoLevel !== 'tract') { where += " AND BLKGRP='" + b + "'"; }
          var url = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/' + layerId + '/query?where=' + encodeURIComponent(where) + '&outFields=STATE,COUNTY,TRACT' + (geoLevel !== 'tract' ? ',BLKGRP' : '') + '&returnGeometry=true&outSR=4326&f=json';
          try{
            const res = await fetch(url);
            const data = await res.json();
            if (data && data.features){
              data.features.forEach(function(f){
                const coords = (f.geometry && f.geometry.rings) ? f.geometry.rings[0].map(function(pt){ return [pt[1], pt[0]]; }) : null;
                if (coords){ L.polygon(coords,{color:'#94A3B8',weight:1,fill:false}).addTo(map2); }
              });
            }
          }catch(e){/* ignore */}
        }
      }
      drawGeos();
    </script>
  </body></html>`);
}

// Build CSV string from lastAnalysis (aggregates, per-point, per-unit)
function buildCsvFromLastAnalysis() {
  const la = lastAnalysis;
  const lines = [];
  lines.push(['Label', la.chartLabel].join(','));
  lines.push(['ACS Year', la.acsYear].join(','));
  lines.push(['Geography', la.geography].join(','));
  lines.push(['Proximal (mi)', la.proximalMiles].join(','));
  lines.push(['Distal (mi)', la.distalMiles].join(','));
  lines.push([]);
  lines.push(['Aggregate','Proximal','Distal'].join(','));
  lines.push(['Value', la.proxValue, la.distValue].join(','));
  lines.push([]);
  // Per-point summaries
  lines.push(['Per-point (proximal ring)'].join(','));
  lines.push(['Lat','Lng','Units in Prox','Value'].join(','));
  (la.pointSummaries||[]).forEach(p=>{
    lines.push([p.lat, p.lng, p.units, p.value].join(','));
  });
  lines.push([]);
  // Per-unit details
  const geoHeader = la.geography==='tract' ? ['STATE','COUNTY','TRACT','b'] : ['STATE','COUNTY','TRACT','BLKGRP'];
  if (la.type==='median'){
    lines.push(['Proximal Units (Median)'].join(','));
    lines.push([...geoHeader, 'median'].join(','));
    la.proxUnits.forEach(u=>{ lines.push([u.s,u.c,u.t,u.b||'',u.median].join(',')); });
    lines.push([]);
    lines.push(['Distal Units (Median)'].join(','));
    lines.push([...geoHeader, 'median'].join(','));
    la.distUnits.forEach(u=>{ lines.push([u.s,u.c,u.t,u.b||'',u.median].join(',')); });
  } else {
    lines.push(['Proximal Units (Rate)'].join(','));
    lines.push([...geoHeader, 'pop','value','ratePer1k'].join(','));
    la.proxUnits.forEach(u=>{ lines.push([u.s,u.c,u.t,u.b||'',u.pop,u.value,u.ratePer1k].join(',')); });
    lines.push([]);
    lines.push(['Distal Units (Rate)'].join(','));
    lines.push([...geoHeader, 'pop','value','ratePer1k'].join(','));
    la.distUnits.forEach(u=>{ lines.push([u.s,u.c,u.t,u.b||'',u.pop,u.value,u.ratePer1k].join(',')); });
  }
  return lines.map(r=>Array.isArray(r)?r.join(','):r).join('\n');
}
