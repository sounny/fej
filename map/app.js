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
let demographicChart;

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

// fullscreen toggle
const fullscreenBtn = document.getElementById('fullscreenBtn');
fullscreenBtn.addEventListener('click', () => {
  document.body.classList.toggle('fullscreen');
  fullscreenBtn.textContent = document.body.classList.contains('fullscreen') ? 'Exit Full Screen' : 'Full Screen';
  setTimeout(() => {
    map.invalidateSize();
  }, 310);
});

async function getBlockGroups(lat, lng, radiusMeters) {
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/10/query?where=1%3D1&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${radiusMeters}&units=esriSRUnit_Meter&outFields=STATE,COUNTY,TRACT,BLKGRP&returnGeometry=false&f=json`;
  const res = await fetch(url);
  const data = await res.json();
  return data.features ? data.features.map(f => f.attributes) : [];
}

async function fetchACSCount(state, county, tract, blkgrp, variables, totalVar) {
  const queryVars = [totalVar, ...variables].join(',');
  const url = `https://api.census.gov/data/2023/acs/acs5?get=${queryVars}&for=block%20group:${blkgrp}&in=state:${state}%20county:${county}%20tract:${tract}&key=${CENSUS_API_KEY}`;
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
  // Note: Census API appends state, county, tract, blkgrp at end of row
  return { pop, value };
}

async function fetchACSMedian(state, county, tract, blkgrp, variable) {
  const url = `https://api.census.gov/data/2023/acs/acs5?get=${variable}&for=block%20group:${blkgrp}&in=state:${state}%20county:${county}%20tract:${tract}&key=${CENSUS_API_KEY}`;
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

  for (const marker of selectedMarkers) {
    const lat = marker.getLatLng().lat;
    const lng = marker.getLatLng().lng;
    try {
      const proxBgs = await getBlockGroups(lat, lng, proxRadius);
      proxBgs.forEach(bg => proximalSet.add(`${bg.STATE}|${bg.COUNTY}|${bg.TRACT}|${bg.BLKGRP}`));
      if (distRadius > proxRadius) {
        const distBgs = await getBlockGroups(lat, lng, distRadius);
        distBgs.forEach(bg => distalSet.add(`${bg.STATE}|${bg.COUNTY}|${bg.TRACT}|${bg.BLKGRP}`));
      }
    } catch (error) {
      console.error(`Error getting block groups for marker at ${lat}, ${lng}:`, error);
    }
  }

  proximalSet.forEach(k => distalSet.delete(k));

  let proxMetric = 0, distMetric = 0;
  let proxPop = 0, distPop = 0;
  let proxCount = 0, distCount = 0;

  for (const key of proximalSet) {
    const [s, c, t, b] = key.split('|');
    try {
      if (type === 'median') {
        const median = await fetchACSMedian(s, c, t, b, variables[0]);
        if (!isNaN(median)) {
          proxMetric += median;
          proxCount++;
        }
      } else {
        const data = await fetchACSCount(s, c, t, b, variables, totalVar);
        if (!isNaN(data.pop) && !isNaN(data.value)) {
          proxPop += data.pop;
          proxMetric += data.value;
        }
      }
    } catch (error) {
      console.error(`Error fetching ACS data for ${key}:`, error);
    }
  }

  for (const key of distalSet) {
    const [s, c, t, b] = key.split('|');
    try {
      if (type === 'median') {
        const median = await fetchACSMedian(s, c, t, b, variables[0]);
        if (!isNaN(median)) {
          distMetric += median;
          distCount++;
        }
      } else {
        const data = await fetchACSCount(s, c, t, b, variables, totalVar);
        if (!isNaN(data.pop) && !isNaN(data.value)) {
          distPop += data.pop;
          distMetric += data.value;
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
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
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

async function searchAddress() {
  const query = document.getElementById('search-input').value;
  if (!query) return;

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
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
        map.removeLayer(searchMarker);
      }

      searchMarker = L.marker(latLng, {
        icon: L.divIcon({
          className: 'search-result-marker',
          html: '<div class="pulsating-dot"></div>'
        })
      }).addTo(map).bindPopup(`<b>Search Result:</b><br>${display_name}`).openPopup();

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
