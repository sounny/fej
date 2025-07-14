const map = L.map('map').setView([28.5, -82], 6);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap contributors © CARTO'
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
let sites = [];
let proximalMiles = 0;
let distalMiles = 0;
const CENSUS_API_KEY = 'bf7969bb8b520c9011c65dfbea35994c603a38d7';

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

function updateMarkers(data) {
  clusterGroup.clearLayers();
  bufferLayer.clearLayers();
  sites = [];
  data.forEach(row => {
    const lat = parseFloat(row.Latitude);
    const lng = parseFloat(row.Longitude);
    if (!isNaN(lat) && !isNaN(lng)) {
      const marker = L.marker([lat, lng]).bindPopup(`<strong>${row.Location || 'Site'}</strong>`);
      clusterGroup.addLayer(marker);
      sites.push([lat, lng]);
    }
  });
  updateBuffers();
}

function updateBuffers() {
  bufferLayer.clearLayers();
  if (proximalMiles <= 0 && distalMiles <= 0) return;
  sites.forEach(([lat, lng]) => {
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
Array.from(document.querySelectorAll('#loadData li')).forEach(li => {
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
  updateBuffers();
});

distalSlider.addEventListener('input', () => {
  distalMiles = Math.max(parseFloat(distalSlider.value), proximalMiles);
  distalSlider.value = distalMiles;
  distalValue.textContent = distalMiles.toFixed(2);
  updateBuffers();
});

// panel toggle
const hamburger = document.getElementById('hamburger');
const sidePanel = document.getElementById('sidePanel');
hamburger.addEventListener('click', () => {
  sidePanel.classList.toggle('closed');
  setTimeout(() => {
    map.invalidateSize();
  }, 310);
});

// about button
document.getElementById('aboutBtn').addEventListener('click', () => {
  window.location.href = 'https://sounny.github.io/fej';
});

async function getBlockGroups(lat, lng, radiusMeters) {
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/10/query?where=1%3D1&geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=${radiusMeters}&units=esriSRUnit_Meter&outFields=STATE,COUNTY,TRACT,BLKGRP&returnGeometry=false&f=json`;
  const res = await fetch(url);
  const data = await res.json();
  return data.features ? data.features.map(f => f.attributes) : [];
}

async function fetchACS(state, county, tract, blkgrp) {
  const url = `https://api.census.gov/data/2023/acs/acs5?get=B02001_001E,B02001_003E&for=block%20group:${blkgrp}&in=state:${state}%20county:${county}%20tract:${tract}&key=${CENSUS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data[1];
}

async function compileDemographics() {
  const radius = proximalMiles * 1609.34;
  if (radius <= 0) return;
  const unique = new Set();
  for (const [lat, lng] of sites) {
    const bgs = await getBlockGroups(lat, lng, radius);
    bgs.forEach(bg => unique.add(`${bg.STATE}|${bg.COUNTY}|${bg.TRACT}|${bg.BLKGRP}`));
  }
  let totalPop = 0;
  let totalBlack = 0;
  for (const key of unique) {
    const [s, c, t, b] = key.split('|');
    const row = await fetchACS(s, c, t, b);
    if (row) {
      const pop = parseInt(row[0]);
      const black = parseInt(row[1]);
      if (!isNaN(pop) && !isNaN(black)) {
        totalPop += pop;
        totalBlack += black;
      }
    }
  }
  if (totalPop > 0) {
    const percent = (totalBlack / totalPop) * 100;
    alert(`Average percent Black: ${percent.toFixed(2)}%`);
  } else {
    alert('No demographic data found.');
  }
}

document.getElementById('demographicsBtn').addEventListener('click', compileDemographics);
