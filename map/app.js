const map = L.map('map').setView([28.5, -82], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

const markers = L.layerGroup().addTo(map);

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
  } catch(e) {
    console.error('Failed to load dataset', e);
    return [];
  }
}

function updateMarkers(data) {
  markers.clearLayers();
  data.forEach(row => {
    const lat = parseFloat(row.Latitude);
    const lng = parseFloat(row.Longitude);
    if(!isNaN(lat) && !isNaN(lng)) {
      L.marker([lat,lng]).bindPopup(row.Location || 'Site').addTo(markers);
    }
  });
}

document.getElementById('datasetSelect').addEventListener('change', async (e) => {
  const url = e.target.value;
  if(!url) return;
  const data = await loadDataset(url);
  updateMarkers(data);
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const text = await file.text();
  const data = parseCSV(text);
  updateMarkers(data);
});
