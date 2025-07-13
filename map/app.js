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
let bufferMiles = 0;

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
  if (bufferMiles <= 0) return;
  sites.forEach(([lat, lng]) => {
    L.circle([lat, lng], {
      radius: bufferMiles * 1609.34,
      color: '#1976D2',
      weight: 1,
      fill: false
    }).addTo(bufferLayer);
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

// buffer slider
const slider = document.getElementById('bufferSlider');
const bufferValue = document.getElementById('bufferValue');
slider.addEventListener('input', () => {
  bufferMiles = parseFloat(slider.value);
  bufferValue.textContent = bufferMiles;
  updateBuffers();
});

// panel toggle
const hamburger = document.getElementById('hamburger');
const sidePanel = document.getElementById('sidePanel');
hamburger.addEventListener('click', () => {
  sidePanel.classList.toggle('closed');
});

// about button
document.getElementById('aboutBtn').addEventListener('click', () => {
  alert('Environmental Hazard Dashboard: visualizing environmental datasets in Florida.');
});
