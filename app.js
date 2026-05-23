/* ==========================================================================
   RUTTMÄSTAREN - APPLICATION ENGINE (app.js)
   ========================================================================== */

// Application State
const state = {
  warehouse: null, // { address: '', lat: 0, lng: 0 }
  stops: [],       // Array of: { id: '', address: '', lat: 0, lng: 0, duration: 4, status: 'pending'|'delivered'|'failed' }
  routeOrder: [],  // Array of stop indices (representing sequence including warehouse)
  routeGeometry: null,
  routeDistance: 0, // meters
  routeDuration: 0, // seconds
  globalDuration: 4, // default minutes per stop
  hudActiveIndex: -1, // active stop index in HUD mode
  isHUDActive: false,
  cameraStream: null, // WebRTC live camera stream tracker
  zoomFactor: 1.0     // Digital camera zoom scale factor
};

// Leaflet Map Globals
let map = null;
let routeLine = null;
let markersGroup = null;

// OCR Globals
let ocrWorker = null;

// ==========================================================================
// 1. INITIALIZATION & LOCALSTORAGE
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize Lucide Icons
  lucide.createIcons();
  
  // Load State from LocalStorage
  loadStateFromStorage();
  
  // Initialize Map
  initMap();
  
  // Setup Event Listeners
  setupEventListeners();
  
  // Pre-load Tesseract Worker to make scanning fast
  initOCR();
  
  // Render Initial View
  renderWarehouse();
  renderStopsList();
  updateDashboard();
  
  // If we already have stops, plot them on map
  if (state.stops.length > 0) {
    calculateRoute(false); // get cached/existing route drawn
  }
});

// Load state from local storage
function loadStateFromStorage() {
  const savedWarehouse = localStorage.getItem('rm_warehouse');
  if (savedWarehouse) {
    state.warehouse = JSON.parse(savedWarehouse);
  }
  
  const savedStops = localStorage.getItem('rm_stops');
  if (savedStops) {
    state.stops = JSON.parse(savedStops);
  }
  
  const savedGlobalDuration = localStorage.getItem('rm_global_duration');
  if (savedGlobalDuration) {
    state.globalDuration = parseInt(savedGlobalDuration, 10);
    document.getElementById('global-duration').value = state.globalDuration;
    document.getElementById('stop-duration-input').value = state.globalDuration;
  }
}

// Save state to local storage
function saveStateToStorage() {
  localStorage.setItem('rm_warehouse', JSON.stringify(state.warehouse));
  localStorage.setItem('rm_stops', JSON.stringify(state.stops));
  localStorage.setItem('rm_global_duration', state.globalDuration.toString());
}

// ==========================================================================
// 2. INTERACTIVE MAP FUNCTIONS (LEAFLET.JS)
// ==========================================================================
function initMap() {
  // Start centered on Sweden
  const startLat = state.warehouse ? state.warehouse.lat : 59.3293;
  const startLng = state.warehouse ? state.warehouse.lng : 18.0686;
  const startZoom = state.warehouse ? 13 : 5;
  
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([startLat, startLng], startZoom);
  
  // Custom dark-mode voyager tiles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19
  }).addTo(map);
  
  // Add zoom control at bottom-right
  L.control.zoom({
    position: 'bottomright'
  }).addTo(map);
  
  markersGroup = L.layerGroup().addTo(map);
}

// Generate premium custom numbered map pins
function createCustomMarker(number, type, tooltipText) {
  let numberContent = number;
  if (type === 'warehouse') numberContent = '🏠';
  
  const icon = L.divIcon({
    className: `custom-map-marker ${type}`,
    html: `
      <div class="custom-marker-pin"></div>
      <span class="custom-marker-number">${numberContent}</span>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 32]
  });
  
  return icon;
}

// Refresh all pins on the map
function updateMapMarkers() {
  if (!map || !markersGroup) return;
  markersGroup.clearLayers();
  
  // 1. Plot Warehouse if available
  if (state.warehouse) {
    const whMarker = L.marker([state.warehouse.lat, state.warehouse.lng], {
      icon: createCustomMarker('H', 'warehouse')
    }).bindPopup(`<strong>Lager (Start/Mål)</strong><br>${state.warehouse.address}`);
    
    markersGroup.addLayer(whMarker);
  }
  
  // 2. Plot all stops in their CURRENT order
  state.stops.forEach((stop, index) => {
    const markerType = stop.status; // pending, delivered, failed
    const stopNumber = index + 1;
    
    const stopMarker = L.marker([stop.lat, stop.lng], {
      icon: createCustomMarker(stopNumber, markerType)
    }).bindPopup(`
      <strong>Stopp ${stopNumber}: ${stop.address}</strong><br>
      Tid: ${stop.duration} min<br>
      Status: ${getStatusName(stop.status)}
    `);
    
    markersGroup.addLayer(stopMarker);
  });
}

function getStatusName(status) {
  if (status === 'delivered') return '<span class="text-success">Levererad ✅</span>';
  if (status === 'failed') return '<span class="text-danger">Misslyckades ❌</span>';
  return '<span class="text-primary">Väntar ⏳</span>';
}

// Draw the route path line
function drawRoutePath(coordinates) {
  if (!map) return;
  
  // Remove existing line if any
  if (routeLine) {
    map.removeLayer(routeLine);
  }
  
  if (!coordinates || coordinates.length === 0) return;
  
  // Draw thick, glowing path
  routeLine = L.polyline(coordinates, {
    color: '#3B82F6',
    weight: 6,
    opacity: 0.85,
    lineJoin: 'round',
    shadowBlur: 10,
    shadowColor: '#3B82F6',
    className: 'route-polyline'
  }).addTo(map);
  
  // Add CSS animation/glowing properties if browser supports it
  const pathElement = routeLine.getElement();
  if (pathElement) {
    pathElement.style.filter = 'drop-shadow(0px 0px 8px rgba(59, 130, 246, 0.6))';
  }
}

// Center map to cover all stops + warehouse
function fitMapBounds() {
  if (!map) return;
  
  const points = [];
  if (state.warehouse) {
    points.push([state.warehouse.lat, state.warehouse.lng]);
  }
  
  state.stops.forEach(s => points.push([s.lat, s.lng]));
  
  if (points.length > 0) {
    const bounds = L.latLngBounds(points);
    map.fitBounds(bounds, { padding: [50, 50] });
  }
}

// ==========================================================================
// 3. GEOCODING & AUTOCOMPLETE (NOMINATIM API)
// ==========================================================================
async function searchAddress(query) {
  if (!query || query.trim().length < 3) return [];
  
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&countrycodes=se`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RuttPlanerarenBudbil/1.0 (ruttmaster@example.com)'
      }
    });
    
    if (!response.ok) throw new Error('Geokodnings-fel');
    const data = await response.json();
    
    return data.map(item => ({
      address: item.display_name.split(',').slice(0, 3).join(','), // shorten details
      fullAddress: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon)
    }));
  } catch (error) {
    console.error('Nominatim Geocoding Error:', error);
    return [];
  }
}

// ==========================================================================
// 4. TSP ROUTE OPTIMIZATION (2-OPT ALGORITHM)
// ==========================================================================

// Solve Traveling Salesperson Problem (TSP) using OSRM Distance Matrix
async function calculateRoute(shouldOptimize = true) {
  if (!state.warehouse) {
    alert("Vänligen ställ in lagrets adress först!");
    return;
  }
  
  if (state.stops.length === 0) {
    // Just show warehouse
    updateMapMarkers();
    if (routeLine) map.removeLayer(routeLine);
    state.routeDistance = 0;
    state.routeDuration = 0;
    updateDashboard();
    return;
  }

  const showLoader = (show) => {
    const btn = document.getElementById('optimize-route-btn');
    if (show) {
      btn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:8px;"></div> OPTIMERAR...`;
      btn.disabled = true;
    } else {
      btn.innerHTML = `<i data-lucide="sparkles"></i> OPTIMERA SNABBASTE RUTT`;
      btn.disabled = false;
      lucide.createIcons();
    }
  };

  showLoader(true);

  try {
    // If we only have 1 stop, routing is simple: Warehouse -> Stop 1 -> Warehouse
    if (state.stops.length === 1) {
      await fetchDirectRoute([state.warehouse, state.stops[0], state.warehouse]);
      showLoader(false);
      return;
    }

    // Determine stop order
    let sortedStops = [...state.stops];

    if (shouldOptimize) {
      // 1. Fetch the duration matrix from OSRM between all locations (Warehouse is index 0)
      const locations = [state.warehouse, ...state.stops];
      const matrix = await fetchOSRMDurationMatrix(locations);
      
      // 2. Solve the TSP using 2-opt heuristic
      const optimalIndicesOrder = solveTSP2Opt(matrix);
      
      // 3. Reorder stops in our state to match optimized order (excluding warehouse at start/end)
      // optimalIndicesOrder will be [0, p1, p2, ..., 0]. We want stops sorted by p1, p2, ...
      const optimizedStops = [];
      for (let i = 1; i < optimalIndicesOrder.length - 1; i++) {
        const stopIndexInStops = optimalIndicesOrder[i] - 1;
        optimizedStops.push(state.stops[stopIndexInStops]);
      }
      
      state.stops = optimizedStops;
      saveStateToStorage();
      renderStopsList();
    }

    // 4. Get the detailed path geometry for the sorted sequence
    const routeCoords = [state.warehouse, ...state.stops, state.warehouse];
    await fetchDirectRoute(routeCoords);
    
  } catch (error) {
    console.error("Optimization failed, doing fallback estimation:", error);
    // Offline/Rate limit fallback
    runFallbackRouting();
  } finally {
    showLoader(false);
  }
}

// Fetch OSRM Matrix
async function fetchOSRMDurationMatrix(locations) {
  const coordsQuery = locations.map(loc => `${loc.lng},${loc.lat}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coordsQuery}?sources=all&destinations=all&annotations=duration`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error("Failed to fetch OSRM duration table");
  
  const data = await response.json();
  return data.durations; // 2D matrix of travel times in seconds
}

// TSP Solver (2-Opt Heuristic)
// Starts at 0, visits all points once, returns to 0, minimizing sum of driving times
function solveTSP2Opt(matrix) {
  const n = matrix.length; // total nodes (1 warehouse + N stops)
  
  // Start with a greedy nearest-neighbor tour
  let bestTour = [0];
  let unvisited = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  
  let current = 0;
  while (unvisited.size > 0) {
    let nearest = -1;
    let minDistance = Infinity;
    
    for (let candidate of unvisited) {
      const dist = matrix[current][candidate];
      if (dist < minDistance) {
        minDistance = dist;
        nearest = candidate;
      }
    }
    
    bestTour.push(nearest);
    unvisited.delete(nearest);
    current = nearest;
  }
  bestTour.push(0); // return to warehouse

  // Calculate total duration of a tour
  const getTourCost = (tour) => {
    let cost = 0;
    for (let i = 0; i < tour.length - 1; i++) {
      cost += matrix[tour[i]][tour[i+1]];
    }
    return cost;
  };

  let bestCost = getTourCost(bestTour);
  let improved = true;

  // Run 2-opt swaps iteratively
  let attempts = 0;
  const maxAttempts = 500; // prevent endless loop
  
  while (improved && attempts < maxAttempts) {
    improved = false;
    attempts++;
    
    // We cannot swap warehouse indices at start (0) or end (length - 1)
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // Swap segment from i to j
        const newTour = [...bestTour];
        // Reverse subsegment in place
        reverseSubsegment(newTour, i, j);
        
        const newCost = getTourCost(newTour);
        if (newCost < bestCost) {
          bestTour = newTour;
          bestCost = newCost;
          improved = true;
        }
      }
    }
  }

  return bestTour;
}

// Reverse sub-segment helper for 2-opt
function reverseSubsegment(arr, i, j) {
  while (i < j) {
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
    i++;
    j--;
  }
}

// Fetch detailed road routing geometry from OSRM
async function fetchDirectRoute(coordsList) {
  const coordsQuery = coordsList.map(loc => `${loc.lng},${loc.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordsQuery}?overview=full&geometries=geojson`;
  
  const response = await fetch(url);
  if (!response.ok) throw new Error("OSRM routing geometry error");
  
  const data = await response.json();
  
  if (data.code === 'Ok' && data.routes && data.routes.length > 0) {
    const route = data.routes[0];
    state.routeDistance = route.distance; // meters
    state.routeDuration = route.duration; // seconds
    
    // Convert GeoJSON to Leaflet Coordinates [lat, lng]
    const routeCoords = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);
    
    drawRoutePath(routeCoords);
    updateMapMarkers();
    fitMapBounds();
    updateDashboard();
  }
}

// Fallback Straight-Line Routing if internet is down or OSRM is rate-limiting
function runFallbackRouting() {
  console.log("Running fallback routing...");
  const coords = [];
  
  if (state.warehouse) {
    coords.push([state.warehouse.lat, state.warehouse.lng]);
  }
  
  let totalDistanceMeters = 0;
  
  // Connect warehouse -> stops -> warehouse
  for (let i = 0; i < state.stops.length; i++) {
    coords.push([state.stops[i].lat, state.stops[i].lng]);
    
    // Calc distance
    const prev = i === 0 ? state.warehouse : state.stops[i-1];
    totalDistanceMeters += calculateHaversineDistance(prev.lat, prev.lng, state.stops[i].lat, state.stops[i].lng);
  }
  
  if (state.stops.length > 0 && state.warehouse) {
    coords.push([state.warehouse.lat, state.warehouse.lng]);
    totalDistanceMeters += calculateHaversineDistance(state.stops[state.stops.length - 1].lat, state.stops[state.stops.length - 1].lng, state.warehouse.lat, state.warehouse.lng);
  }

  // Estimate duration: assume average driving speed of 45 km/h (12.5 m/s) including stoplights
  const averageSpeedMps = 12.5; 
  state.routeDistance = totalDistanceMeters;
  state.routeDuration = totalDistanceMeters / averageSpeedMps;

  drawRoutePath(coords);
  updateMapMarkers();
  fitMapBounds();
  updateDashboard();
}

// Haversine formula for spherical distance in meters
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in meters
}

// ==========================================================================
// 5. OCR ADDRESS SCANNER & LABEL CREATION (TESSERACT.JS)
// ==========================================================================

function initOCR() {
  console.log("OCR engine initialized.");
}

// Helper to draw a modern mock shipping label onto the canvas
function generateMockLabelCanvas() {
  const canvas = document.getElementById('label-canvas');
  if (!canvas) return;
  
  canvas.width = 400;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  
  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Border
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  
  // Header Logo / Company
  ctx.fillStyle = '#000000';
  ctx.font = '800 16px Outfit, Arial, sans-serif';
  ctx.fillText('⚡ POSTNORD EXPRESS', 25, 40);
  
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(20, 50);
  ctx.lineTo(380, 50);
  ctx.stroke();
  
  // Delivery details title
  ctx.font = 'bold 10px Arial, sans-serif';
  ctx.fillText('LEVERANSMOTTAGARE (SHIP TO):', 25, 75);
  
  // Generate random Swedish address for testing
  const mockAddresses = [
    { name: 'Kalle Karlsson', street: 'Sveavägen 44', zip: '111 34', city: 'Stockholm' },
    { name: 'Erik Johansson', street: 'Kungsgatan 12', zip: '111 43', city: 'Stockholm' },
    { name: 'Sven Svensson', street: 'Vasagatan 8', zip: '411 08', city: 'Göteborg' },
    { name: 'Johanna Berg', street: 'Drottninggatan 30', zip: '111 51', city: 'Stockholm' },
    { name: 'Lars Larsson', street: 'Odengatan 56', zip: '113 22', city: 'Stockholm' }
  ];
  
  const chosen = mockAddresses[Math.floor(Math.random() * mockAddresses.length)];
  
  // Recipient details inside manifest
  ctx.font = '800 18px Arial, sans-serif';
  ctx.fillText(chosen.name.toUpperCase(), 25, 105);
  ctx.fillText(chosen.street.toUpperCase(), 25, 130);
  ctx.fillText(`${chosen.zip} ${chosen.city.toUpperCase()}`, 25, 155);
  
  // Horizontal divider
  ctx.beginPath();
  ctx.moveTo(20, 175);
  ctx.lineTo(380, 175);
  ctx.stroke();
  
  // Package ID / barcode fake lines
  ctx.font = 'bold 9px Arial, sans-serif';
  ctx.fillText('FRAKTSEDELNUMMER (TRACKING ID):', 25, 195);
  ctx.font = '12px Courier, monospace';
  ctx.fillText(`SE-${Math.floor(10000 + Math.random() * 90000)}-DK`, 25, 215);
  
  // Barcode visualization
  ctx.fillStyle = '#000000';
  let startX = 25;
  const barcodeY = 230;
  const barcodeHeight = 45;
  
  for (let i = 0; i < 40; i++) {
    const width = Math.random() > 0.4 ? 4 : 2;
    const spacing = Math.random() > 0.4 ? 3 : 1;
    ctx.fillRect(startX, barcodeY, width, barcodeHeight);
    startX += width + spacing;
    if (startX > 370) break;
  }
  
  // Show Canvas
  canvas.classList.remove('hide');
  document.querySelector('.preview-placeholder-icon').classList.add('hide');
  document.querySelector('.scan-preview-container p').classList.add('hide');
}

// Perform OCR Recognition via Tesseract.js
async function runOCRScan(imageSource) {
  const loader = document.getElementById('ocr-loader');
  const resultCard = document.getElementById('scan-result-card');
  const laser = document.querySelector('.scan-laser');
  
  loader.classList.remove('hide');
  resultCard.classList.add('hide');
  laser.style.display = 'block'; // animate laser
  
  try {
    // Run client-side OCR
    const result = await Tesseract.recognize(imageSource, 'swe', {
      logger: m => {
        if (m.status === 'recognizing text') {
          document.getElementById('ocr-loader-text').innerText = `Läser av adressen: ${Math.round(m.progress * 100)}%`;
        }
      }
    });
    
    laser.style.display = 'none'; // stop laser
    loader.classList.add('hide');
    
    const text = result.data.text;
    console.log("OCR Text Detected:", text);
    
    // Parse multiple addresses from OCR text
    const detectedAddresses = parseAddressesFromText(text);
    
    const listContainer = document.getElementById('scanned-addresses-list');
    listContainer.innerHTML = '';
    
    if (detectedAddresses.length === 0) {
      // Fallback row
      const row = document.createElement('div');
      row.className = 'scanned-address-row';
      row.innerHTML = `
        <input type="checkbox" checked class="address-chk">
        <input type="text" class="address-txt" value="" placeholder="Kunde inte tyda adresser. Skriv manuellt...">
      `;
      listContainer.appendChild(row);
    } else {
      // Create checklist for each scanned address
      detectedAddresses.forEach((addr, idx) => {
        const row = document.createElement('div');
        row.className = 'scanned-address-row';
        row.innerHTML = `
          <input type="checkbox" checked class="address-chk" id="addr-chk-${idx}">
          <input type="text" class="address-txt" value="${addr}" id="addr-txt-${idx}" placeholder="Adress...">
        `;
        listContainer.appendChild(row);
      });
    }
    
    // Update count title
    const count = detectedAddresses.length;
    const titleElement = document.getElementById('scan-result-title');
    if (count > 1) {
      titleElement.innerHTML = `<i data-lucide="check-circle-2" class="text-success"></i> ${count} adresser identifierade!`;
    } else if (count === 1) {
      titleElement.innerHTML = `<i data-lucide="check-circle-2" class="text-success"></i> Adress identifierad!`;
    } else {
      titleElement.innerHTML = `<i data-lucide="alert-triangle" class="text-warning"></i> Skriv in adress manuellt`;
    }
    
    document.getElementById('scanned-duration-input').value = state.globalDuration;
    
    // Re-trigger Lucide icon renders
    lucide.createIcons();
    resultCard.classList.remove('hide');
  } catch (error) {
    console.error("OCR Scan failed:", error);
    laser.style.display = 'none';
    loader.classList.add('hide');
    alert("Kunde inte läsa av bilden. Vänligen skriv in adressen manuellt.");
  }
}

// Custom parser to extract multiple Swedish address lines
function parseAddressesFromText(text) {
  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 3 && !l.includes("POSTNORD") && !l.includes("EXPRESS"));
  
  // Standard Swedish address pattern: StreetName followed by street number, e.g. "Sveavägen 44" or "Kungsgatan 12"
  const streetRegex = /^([a-zåäöé\- ]{3,})\s+(\d+)\s*([a-zåäö]?)\b/i;
  const zipCityRegex = /\b(\d{3})\s*(\d{2})\s+([a-zåäö\- ]{3,})/i;
  
  const foundAddresses = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (streetRegex.test(line)) {
      const streetMatch = line.match(streetRegex)[0].trim();
      let cityMatch = "";
      
      // Look at the current line or the next 2 lines to find a zip code / city
      for (let offset = 0; offset <= 2; offset++) {
        const targetIdx = i + offset;
        if (targetIdx < lines.length) {
          const targetLine = lines[targetIdx];
          if (zipCityRegex.test(targetLine)) {
            const match = targetLine.match(zipCityRegex);
            cityMatch = match[3].trim(); // Extract the city name
            break;
          }
        }
      }
      
      // Format address and capitalize words nicely
      let fullAddress = cityMatch ? `${streetMatch}, ${cityMatch}` : streetMatch;
      const cleanAddress = fullAddress.replace(/\b[a-zåäö]/gi, char => char.toUpperCase());
      
      if (!foundAddresses.includes(cleanAddress)) {
        foundAddresses.push(cleanAddress);
      }
    }
  }
  
  // Fallback: If no strict street patterns were matched but we have some lines that look like addresses,
  // extract any lines that have text and numbers (e.g. "Odengatan 56")
  if (foundAddresses.length === 0) {
    for (let line of lines) {
      if (/\b\d+\b/.test(line) && line.length > 6 && line.length < 50) {
        const cleanLine = line.replace(/\b[a-zåäö]/gi, char => char.toUpperCase());
        if (!foundAddresses.includes(cleanLine)) {
          foundAddresses.push(cleanLine);
        }
      }
    }
  }
  
  return foundAddresses;
}

// ==========================================================================
// 6. DASHBOARD & RENDER FUNCTIONS
// ==========================================================================

// Update stats calculations on Dashboard
function updateDashboard() {
  const totalStopsCount = state.stops.length;
  
  // Calculate Progress
  const completedCount = state.stops.filter(s => s.status !== 'pending').length;
  const deliveredCount = state.stops.filter(s => s.status === 'delivered').length;
  const pct = totalStopsCount > 0 ? Math.round((completedCount / totalStopsCount) * 100) : 0;
  
  document.getElementById('stops-counter').innerText = `${totalStopsCount} stopp`;
  document.getElementById('progress-text').innerText = `${completedCount} / ${totalStopsCount} stopp bockade (${pct}%)`;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  
  // Calculate timings
  // Driving time from OSRM (seconds -> minutes)
  const driveMinutes = Math.round(state.routeDuration / 60);
  
  // Work time sum of stop durations
  const workMinutes = state.stops.reduce((sum, stop) => sum + parseInt(stop.duration || 0, 10), 0);
  
  // Total duration (driving + working)
  const totalMinutes = driveMinutes + workMinutes;
  
  // Distans conversion from meters -> km
  const distanceKm = (state.routeDistance / 1000).toFixed(1);
  
  // Update texts
  document.getElementById('stat-total-time').innerText = formatMinutes(totalMinutes);
  document.getElementById('stat-drive-time').innerText = formatMinutes(driveMinutes);
  document.getElementById('stat-work-time').innerText = formatMinutes(workMinutes);
  document.getElementById('stat-distance').innerText = `${distanceKm} km`;
  
  // Sluttid (ETA)
  if (totalStopsCount > 0) {
    const now = new Date();
    const etaDate = new Date(now.getTime() + totalMinutes * 60 * 1000);
    const etaHours = String(etaDate.getHours()).padStart(2, '0');
    const etaMins = String(etaDate.getMinutes()).padStart(2, '0');
    
    document.getElementById('stat-eta').innerText = `Kl ${etaHours}:${etaMins}`;
    
    // Also update HUD bottom ETA text if active
    const hudEta = document.getElementById('hud-eta-timer');
    if (hudEta) hudEta.innerText = `Klar ca ${etaHours}:${etaMins}`;
    
    // HUD distance left: remaining distance & stops calculation
    const hudDistLeft = document.getElementById('hud-dist-left');
    if (hudDistLeft) {
      const remainingStops = state.stops.filter(s => s.status === 'pending').length;
      hudDistLeft.innerText = `Kvar: ${distanceKm} km (${remainingStops} stopp)`;
    }
  } else {
    document.getElementById('stat-eta').innerText = "Inga stopp tillagda";
  }
}

// Convert minutes to pretty text e.g. "2 tim 15 min"
function formatMinutes(mins) {
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours} t ${remainingMins} min`;
}

// Render warehouse display
function renderWarehouse() {
  const display = document.getElementById('warehouse-display');
  const addressText = document.getElementById('warehouse-address-text');
  
  if (state.warehouse) {
    addressText.innerText = state.warehouse.address;
    display.classList.remove('hide');
  } else {
    addressText.innerText = "Ingen lageradress sparad. Vänligen ställ in en lageradress nedan.";
  }
}

// Render the entire list of stops
function renderStopsList() {
  const list = document.getElementById('stops-sortable-list');
  const emptyView = document.getElementById('empty-list-view');
  
  list.innerHTML = '';
  
  if (state.stops.length === 0) {
    emptyView.classList.remove('hide');
    return;
  }
  
  emptyView.classList.add('hide');
  
  state.stops.forEach((stop, index) => {
    const li = document.createElement('li');
    li.className = `stop-item ${stop.status}`;
    li.draggable = true;
    li.dataset.id = stop.id;
    li.dataset.index = index;
    
    // Deep link navigation logic: launches native map navigation
    const googleMapNavUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.address)}&travelmode=driving`;
    
    li.innerHTML = `
      <div class="drag-handle"><i data-lucide="grip-vertical"></i></div>
      <div class="stop-index-badge">${index + 1}</div>
      <div class="stop-content">
        <div class="stop-address" title="${stop.address}">${stop.address}</div>
        <div class="stop-details-row">
          <div class="stop-duration-tag">
            <i data-lucide="clock"></i>
            <input type="number" class="stop-dur-edit" value="${stop.duration}" min="1" max="120" data-id="${stop.id}"> min
          </div>
        </div>
      </div>
      
      <div class="stop-actions-wrapper">
        <!-- Direct Android Auto Launch Nav -->
        <a href="${googleMapNavUrl}" target="_blank" class="btn-nav-stop" title="Navigera till stoppet">
          <i data-lucide="navigation"></i> KÖR
        </a>
        
        <select class="stop-status-select" data-id="${stop.id}">
          <option value="pending" ${stop.status === 'pending' ? 'selected' : ''}>⏳ Väntar</option>
          <option value="delivered" ${stop.status === 'delivered' ? 'selected' : ''}>✅ Lev.</option>
          <option value="failed" ${stop.status === 'failed' ? 'selected' : ''}>❌ Problem</option>
        </select>
        
        <!-- Touch Arrows for Mobile Reordering -->
        <div class="mobile-arrows">
          <button class="btn-arrow btn-up" data-index="${index}" title="Flytta upp">
            <i data-lucide="chevron-up"></i>
          </button>
          <button class="btn-arrow btn-down" data-index="${index}" title="Flytta ner">
            <i data-lucide="chevron-down"></i>
          </button>
        </div>
        
        <button class="btn-delete-stop" data-id="${stop.id}" title="Ta bort stopp">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;
    
    list.appendChild(li);
  });
  
  // Re-create icons for new elements
  lucide.createIcons();
  
  // Setup drag and drop events
  setupDragAndDrop();
  
  // Bind dynamic inline inputs inside list
  bindDynamicListInputs();
}

// ==========================================================================
// 7. DRAG & DROP & LIST ORDER CONTROLLERS
// ==========================================================================
let dragSourceElement = null;

function setupDragAndDrop() {
  const items = document.querySelectorAll('.sortable-list .stop-item');
  
  items.forEach(item => {
    item.addEventListener('dragstart', handleDragStart, false);
    item.addEventListener('dragover', handleDragOver, false);
    item.addEventListener('drop', handleDrop, false);
    item.addEventListener('dragend', handleDragEnd, false);
  });
}

function handleDragStart(e) {
  this.classList.add('dragging');
  dragSourceElement = this;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault(); // Necessary. Allows us to drop.
  }
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDrop(e) {
  if (e.stopPropagation) {
    e.stopPropagation(); // stops the browser from redirecting.
  }
  
  if (dragSourceElement !== this) {
    const srcIndex = parseInt(dragSourceElement.dataset.index, 10);
    const destIndex = parseInt(this.dataset.index, 10);
    
    // Swap/reorder in our state
    const temp = state.stops.splice(srcIndex, 1)[0];
    state.stops.splice(destIndex, 0, temp);
    
    saveStateToStorage();
    renderStopsList();
    
    // Instantly recalculate path for manual sequence (without auto TSP reoptimizing)
    calculateRoute(false);
  }
  return false;
}

function handleDragEnd() {
  this.classList.remove('dragging');
  const items = document.querySelectorAll('.sortable-list .stop-item');
  items.forEach(item => item.classList.remove('dragging'));
}

// Inline input change bindings
function bindDynamicListInputs() {
  // Inline duration edit
  document.querySelectorAll('.stop-dur-edit').forEach(input => {
    input.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      const val = Math.max(1, parseInt(e.target.value, 10) || 4);
      
      const stop = state.stops.find(s => s.id === id);
      if (stop) {
        stop.duration = val;
        saveStateToStorage();
        updateDashboard();
        
        // If we are in HUD mode, sync HUD view
        if (state.isHUDActive && state.hudActiveIndex !== -1) {
          renderHUDActiveStop();
        }
      }
    });
  });

  // Status select changes
  document.querySelectorAll('.stop-status-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      const status = e.target.value;
      
      const stop = state.stops.find(s => s.id === id);
      if (stop) {
        stop.status = status;
        saveStateToStorage();
        renderStopsList();
        updateMapMarkers();
        updateDashboard();
        
        // Sync HUD if active
        if (state.isHUDActive) {
          renderHUDActiveStop();
        }
      }
    });
  });

  // Up and Down button clicks (mobile reordering)
  document.querySelectorAll('.btn-up').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.currentTarget.dataset.index, 10);
      if (index > 0) {
        const temp = state.stops.splice(index, 1)[0];
        state.stops.splice(index - 1, 0, temp);
        saveStateToStorage();
        renderStopsList();
        calculateRoute(false);
      }
    });
  });

  document.querySelectorAll('.btn-down').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt(e.currentTarget.dataset.index, 10);
      if (index < state.stops.length - 1) {
        const temp = state.stops.splice(index, 1)[0];
        state.stops.splice(index + 1, 0, temp);
        saveStateToStorage();
        renderStopsList();
        calculateRoute(false);
      }
    });
  });

  // Delete stop
  document.querySelectorAll('.btn-delete-stop').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      state.stops = state.stops.filter(s => s.id !== id);
      saveStateToStorage();
      renderStopsList();
      calculateRoute(false);
    });
  });
}

// ==========================================================================
// 8. DRIVING HUD MODE (DASHBOARD CONTROLLER)
// ==========================================================================
function toggleHUDMode(active) {
  const hudOverlay = document.getElementById('hud-overlay');
  state.isHUDActive = active;
  
  if (active) {
    if (!state.warehouse) {
      alert("Du måste ställa in en lageradress först!");
      state.isHUDActive = false;
      return;
    }
    if (state.stops.length === 0) {
      alert("Lägg till några leveransstopp innan du startar körläget!");
      state.isHUDActive = false;
      return;
    }
    
    // Find first pending stop index in sequence
    const firstPendingIdx = state.stops.findIndex(s => s.status === 'pending');
    state.hudActiveIndex = firstPendingIdx !== -1 ? firstPendingIdx : 0;
    
    hudOverlay.classList.remove('hide');
    renderHUDActiveStop();
    updateDashboard(); // sync HUD footer stats
  } else {
    hudOverlay.classList.add('hide');
    // Refresh main view lists just in case status changed
    renderStopsList();
    updateMapMarkers();
  }
}

function renderHUDActiveStop() {
  if (state.hudActiveIndex === -1 || state.stops.length === 0) return;
  
  const stop = state.stops[state.hudActiveIndex];
  
  // Update top title text
  document.getElementById('hud-subtitle').innerText = `Stopp ${state.hudActiveIndex + 1} av ${state.stops.length}`;
  
  // Update card details
  const activeCard = document.getElementById('hud-active-stop-card');
  const indexBadge = activeCard.querySelector('.hud-index-badge');
  const durBadge = document.getElementById('hud-stop-duration');
  const addressText = document.getElementById('hud-active-address');
  const navLink = document.getElementById('hud-nav-link');
  
  // Set badge status colors
  indexBadge.innerText = `NÄSTA STOPP ${state.hudActiveIndex + 1}`;
  durBadge.innerText = `⏱️ ${stop.duration} min`;
  addressText.innerText = stop.address;
  
  // Set active card border style based on status
  activeCard.className = `hud-active-card ${stop.status}`;
  
  // Start navigation link setup for Android Auto (Universal dynamic intent)
  // Clicking this automatically initiates driving maps turn-by-turn navigation on the Android phone & synced dashboard
  const mapNavUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.address)}&travelmode=driving`;
  navLink.href = mapNavUrl;
  
  // Check buttons disabled queues
  document.getElementById('hud-prev-btn').disabled = state.hudActiveIndex === 0;
  document.getElementById('hud-next-btn').disabled = state.hudActiveIndex === state.stops.length - 1;
}

// Mark active HUD delivery status
function setHUDActiveStopStatus(status) {
  if (state.hudActiveIndex === -1) return;
  
  // 1. Update status
  state.stops[state.hudActiveIndex].status = status;
  saveStateToStorage();
  
  // 2. Refresh UI stats
  updateDashboard();
  updateMapMarkers();
  
  // 3. Move to next pending stop if current is finished
  if (state.hudActiveIndex < state.stops.length - 1) {
    state.hudActiveIndex++;
    renderHUDActiveStop();
  } else {
    // Finished all stops
    alert("Bra jobbat! Du har slutfört alla planerade stopp på din rutt.");
    toggleHUDMode(false); // return to summary screen
  }
}

// ==========================================================================
// 9. GEOCODING DROPDOWN UTILS
// ==========================================================================
function bindAutocomplete(inputId, dropdownId, onSelectCallback) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  let timeout = null;
  
  input.addEventListener('input', () => {
    clearTimeout(timeout);
    const query = input.value;
    
    if (query.trim().length < 3) {
      dropdown.classList.add('hide');
      return;
    }
    
    timeout = setTimeout(async () => {
      const results = await searchAddress(query);
      
      if (results.length === 0) {
        dropdown.classList.add('hide');
        return;
      }
      
      dropdown.innerHTML = '';
      dropdown.classList.remove('hide');
      
      results.forEach(item => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item';
        div.innerHTML = `<i data-lucide="map-pin" style="width:14px;height:14px;flex-shrink:0;"></i> <span>${item.address}</span>`;
        
        div.addEventListener('click', () => {
          input.value = item.address;
          dropdown.classList.add('hide');
          onSelectCallback(item);
        });
        
        dropdown.appendChild(div);
      });
      lucide.createIcons();
    }, 450); // debounce API requests
  });
  
  // Hide dropdown if clicked outside
  document.addEventListener('click', (e) => {
    if (e.target !== input && e.target !== dropdown) {
      dropdown.classList.add('hide');
    }
  });
}

// Stop WebRTC camera stream and reset viewport states
function stopCameraStream() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
  }
  const video = document.getElementById('scan-video');
  if (video) {
    video.srcObject = null;
    video.classList.add('hide');
  }
  const captureBtn = document.getElementById('capture-photo-btn');
  if (captureBtn) {
    captureBtn.classList.add('hide');
  }
  const preview = document.getElementById('scan-preview-container');
  if (preview) {
    const canvas = document.getElementById('label-canvas');
    if (canvas && canvas.classList.contains('hide')) {
      preview.classList.remove('hide');
    }
  }
}

// ==========================================================================
// 10. BINDING COMPONENT EVENT LISTENERS
// ==========================================================================
function setupEventListeners() {
  
  // 1. Warehouse setup bindings
  const editWarehouseBtn = document.getElementById('edit-warehouse-btn');
  const warehouseForm = document.getElementById('warehouse-form');
  const cancelWarehouseBtn = document.getElementById('cancel-warehouse-btn');
  const saveWarehouseBtn = document.getElementById('save-warehouse-btn');
  let selectedWarehouseItem = null;
  
  editWarehouseBtn.addEventListener('click', () => {
    warehouseForm.classList.remove('hide');
    document.getElementById('warehouse-input').value = state.warehouse ? state.warehouse.address : '';
    document.getElementById('warehouse-input').focus();
  });
  
  cancelWarehouseBtn.addEventListener('click', () => {
    warehouseForm.classList.add('hide');
  });
  
  // Auto dropdown for Warehouse input
  bindAutocomplete('warehouse-input', 'warehouse-autocomplete-results', (selectedItem) => {
    selectedWarehouseItem = selectedItem;
  });
  
  saveWarehouseBtn.addEventListener('click', async () => {
    const addressInput = document.getElementById('warehouse-input').value;
    
    if (!addressInput || addressInput.trim().length === 0) {
      alert("Vänligen ange en lageradress!");
      return;
    }
    
    // If user clicked autocomplete, we already have coordinates
    if (selectedWarehouseItem && selectedWarehouseItem.address === addressInput) {
      state.warehouse = {
        address: selectedWarehouseItem.address,
        lat: selectedWarehouseItem.lat,
        lng: selectedWarehouseItem.lng
      };
    } else {
      // Manual fallback search geocoding
      const results = await searchAddress(addressInput);
      if (results.length > 0) {
        state.warehouse = {
          address: results[0].address,
          lat: results[0].lat,
          lng: results[0].lng
        };
      } else {
        alert("Kunde inte hitta adressen. Försök vara mer specifik.");
        return;
      }
    }
    
    saveStateToStorage();
    renderWarehouse();
    warehouseForm.classList.add('hide');
    
    // Pan map to new warehouse
    if (map) {
      map.setView([state.warehouse.lat, state.warehouse.lng], 13);
    }
    
    // Re-trigger routing calculations
    calculateRoute(false);
  });
  
  // 2. Add Stops autocomplete
  let selectedStopItem = null;
  bindAutocomplete('stop-address-input', 'stop-autocomplete-results', (selectedItem) => {
    selectedStopItem = selectedItem;
  });
  
  // "Lägg till i listan" button
  const addStopBtn = document.getElementById('add-stop-text-btn');
  const searchStopBtn = document.getElementById('search-stop-btn');
  
  const handleAddStop = async () => {
    const addressInput = document.getElementById('stop-address-input').value;
    const durInput = parseInt(document.getElementById('stop-duration-input').value, 10) || state.globalDuration;
    
    if (!addressInput || addressInput.trim().length === 0) {
      alert("Vänligen skriv in en adress!");
      return;
    }
    
    let lat = 0, lng = 0, address = "";
    
    // Verify geocoding details
    if (selectedStopItem && selectedStopItem.address === addressInput) {
      lat = selectedStopItem.lat;
      lng = selectedStopItem.lng;
      address = selectedStopItem.address;
    } else {
      const results = await searchAddress(addressInput);
      if (results.length > 0) {
        lat = results[0].lat;
        lng = results[0].lng;
        address = results[0].address;
      } else {
        alert("Kunde inte geokoda adressen. Kontrollera stavning eller sök mer specifikt.");
        return;
      }
    }
    
    // Build stop object
    const newStop = {
      id: 'stop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      address: address,
      lat: lat,
      lng: lng,
      duration: durInput,
      status: 'pending'
    };
    
    state.stops.push(newStop);
    saveStateToStorage();
    renderStopsList();
    
    // Clean input fields
    document.getElementById('stop-address-input').value = '';
    selectedStopItem = null;
    
    // Auto-calculate route for the new stop in queue
    calculateRoute(false);
  };
  
  addStopBtn.addEventListener('click', handleAddStop);
  searchStopBtn.addEventListener('click', handleAddStop);
  
  // 3. Optimize Buttons & Clear Routings
  document.getElementById('optimize-route-btn').addEventListener('click', () => {
    calculateRoute(true); // run TSP optimization
  });
  
  document.getElementById('clear-route-btn').addEventListener('click', () => {
    if (confirm("Är du säker på att du vill tömma din aktuella leveransrutt?")) {
      state.stops = [];
      saveStateToStorage();
      renderStopsList();
      updateMapMarkers();
      if (routeLine) map.removeLayer(routeLine);
      state.routeDistance = 0;
      state.routeDuration = 0;
      updateDashboard();
    }
  });
  
  // 4. Global standard duration update
  document.getElementById('apply-global-duration').addEventListener('click', () => {
    const val = parseInt(document.getElementById('global-duration').value, 10) || 4;
    state.globalDuration = val;
    
    // Update all current stops to match new global duration setting
    state.stops.forEach(s => s.duration = val);
    
    saveStateToStorage();
    renderStopsList();
    updateDashboard();
    alert(`Alla stopp har uppdaterats till ${val} minuter standardleveranstid.`);
  });
  
  // 5. HUD Mode Event Bindings
  document.getElementById('toggle-hud-btn').addEventListener('click', () => toggleHUDMode(true));
  document.getElementById('exit-hud-btn').addEventListener('click', () => toggleHUDMode(false));
  
  document.getElementById('hud-success-btn').addEventListener('click', () => setHUDActiveStopStatus('delivered'));
  document.getElementById('hud-fail-btn').addEventListener('click', () => setHUDActiveStopStatus('failed'));
  
  document.getElementById('hud-prev-btn').addEventListener('click', () => {
    if (state.hudActiveIndex > 0) {
      state.hudActiveIndex--;
      renderHUDActiveStop();
    }
  });
  
  document.getElementById('hud-next-btn').addEventListener('click', () => {
    if (state.hudActiveIndex < state.stops.length - 1) {
      state.hudActiveIndex++;
      renderHUDActiveStop();
    }
  });
  
  // 6. Map overlay utilities
  document.getElementById('center-map-btn').addEventListener('click', fitMapBounds);
  document.getElementById('locate-me-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      alert("GPS stöds inte av din webbläsare.");
      return;
    }
    
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      
      map.setView([lat, lng], 15);
      L.marker([lat, lng]).addTo(map).bindPopup("Här är du!").openPopup();
    }, (err) => {
      alert("Kunde inte hämta din position. Kontrollera dina platsbehörigheter.");
    });
  });
  
  // 7. Modal scanning triggers
  const scanModal = document.getElementById('scan-modal');
  const closeScanBtn = document.getElementById('close-scan-modal-btn');
  const cameraTrigger = document.getElementById('camera-scan-trigger-btn');
  const videoElement = document.getElementById('scan-video');
  const capturePhotoBtn = document.getElementById('capture-photo-btn');
  const previewContainer = document.getElementById('scan-preview-container');
  const canvasElement = document.getElementById('label-canvas');
  
  const zoomOverlay = document.getElementById('scan-zoom-overlay');
  const zoomSlider = document.getElementById('scan-zoom-slider');
  
  // Track zoom level changes
  zoomSlider.addEventListener('input', (e) => {
    const zoom = parseFloat(e.target.value);
    state.zoomFactor = zoom;
    videoElement.style.transform = `scale(${zoom})`;
  });
  
  cameraTrigger.addEventListener('click', () => {
    scanModal.classList.remove('hide');
    // reset preview and zoom
    canvasElement.classList.add('hide');
    document.getElementById('scan-result-card').classList.add('hide');
    previewContainer.classList.remove('hide');
    
    state.zoomFactor = 1.0;
    zoomSlider.value = 1.0;
    videoElement.style.transform = 'scale(1)';
    
    // Attempt to start live WebRTC video stream
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' } // prefer back camera
      })
      .then((stream) => {
        state.cameraStream = stream;
        videoElement.srcObject = stream;
        videoElement.classList.remove('hide');
        zoomOverlay.classList.remove('hide'); // Show zoom slider overlay!
        previewContainer.classList.add('hide');
        capturePhotoBtn.classList.remove('hide');
      })
      .catch((err) => {
        console.warn("Could not access live camera, falling back to file upload:", err);
        stopCameraStream();
      });
    } else {
      console.warn("MediaDevices API not supported, falling back to file upload.");
      stopCameraStream();
    }
  });
  
  // Capture photo from live video stream
  capturePhotoBtn.addEventListener('click', () => {
    if (!state.cameraStream) return;
    
    const ctx = canvasElement.getContext('2d');
    canvasElement.width = videoElement.videoWidth || 640;
    canvasElement.height = videoElement.videoHeight || 480;
    
    const zoom = state.zoomFactor || 1.0;
    
    if (zoom > 1.0) {
      // Draw mathematically cropped/zoomed camera view onto canvas
      const cropWidth = canvasElement.width / zoom;
      const cropHeight = canvasElement.height / zoom;
      const startX = (canvasElement.width - cropWidth) / 2;
      const startY = (canvasElement.height - cropHeight) / 2;
      
      ctx.drawImage(videoElement, startX, startY, cropWidth, cropHeight, 0, 0, canvasElement.width, canvasElement.height);
    } else {
      // Draw current full video frame onto canvas
      ctx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
    }
    
    // Stop live stream immediately
    stopCameraStream();
    
    // Show canvas, hide video & overlay
    videoElement.classList.add('hide');
    zoomOverlay.classList.add('hide');
    canvasElement.classList.remove('hide');
    capturePhotoBtn.classList.add('hide');
    previewContainer.classList.add('hide');
    
    // Run Tesseract OCR on canvas
    runOCRScan(canvasElement);
  });
  
  closeScanBtn.addEventListener('click', () => {
    stopCameraStream();
    scanModal.classList.add('hide');
  });
  
  // Clicked outside modal content close trigger
  scanModal.addEventListener('click', (e) => {
    if (e.target === scanModal) {
      stopCameraStream();
      scanModal.classList.add('hide');
    }
  });
  
  // Scan file input trigger
  const fileInput = document.getElementById('scan-file-input');
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Stop live camera if it was running
    stopCameraStream();
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const ctx = canvasElement.getContext('2d');
      const img = new Image();
      
      img.onload = () => {
        canvasElement.width = img.width;
        canvasElement.height = img.height;
        ctx.drawImage(img, 0, 0);
        canvasElement.classList.remove('hide');
        previewContainer.classList.add('hide');
        videoElement.classList.add('hide');
        zoomOverlay.classList.add('hide');
        capturePhotoBtn.classList.add('hide');
        
        // Perform OCR analysis
        runOCRScan(canvasElement);
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
  });
  
  // Generate & Scan Test Label
  document.getElementById('generate-test-label-btn').addEventListener('click', () => {
    // Stop live camera if running
    stopCameraStream();
    
    generateMockLabelCanvas();
    runOCRScan(canvasElement);
  });
  
  // Approve scanned OCR address & inject into route list
  document.getElementById('approve-scan-btn').addEventListener('click', async () => {
    const rows = document.querySelectorAll('.scanned-address-row');
    const durInput = state.globalDuration; // Always use the global duration directly!
    
    const addressesToAdd = [];
    rows.forEach(row => {
      const chk = row.querySelector('.address-chk');
      const txt = row.querySelector('.address-txt');
      if (chk && chk.checked && txt && txt.value.trim().length > 0) {
        addressesToAdd.push(txt.value.trim());
      }
    });
    
    if (addressesToAdd.length === 0) {
      alert("Inga adresser är markerade!");
      return;
    }
    
    // UI Button feedback to show loading state
    const approveBtn = document.getElementById('approve-scan-btn');
    const originalHtml = approveBtn.innerHTML;
    approveBtn.disabled = true;
    approveBtn.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 8px; border-width: 2px;"></span> Geokodar adresser...`;
    
    let addedCount = 0;
    
    // Geocode and add each selected address to the route list
    for (const addr of addressesToAdd) {
      try {
        const results = await searchAddress(addr);
        if (results.length > 0) {
          const newStop = {
            id: 'stop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            address: results[0].address,
            lat: results[0].lat,
            lng: results[0].lng,
            duration: durInput,
            status: 'pending'
          };
          state.stops.push(newStop);
          addedCount++;
        }
      } catch (err) {
        console.error("Geocoding failed for address:", addr, err);
      }
    }
    
    approveBtn.disabled = false;
    approveBtn.innerHTML = originalHtml;
    
    if (addedCount > 0) {
      saveStateToStorage();
      renderStopsList();
      
      // Close scan modal, clean up camera, and recalculate route
      stopCameraStream();
      scanModal.classList.add('hide');
      calculateRoute(false);
    } else {
      alert("Kunde inte hitta koordinater för de markerade adresserna. Försök redigera dem manuellt.");
    }
  });
}
