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
  zoomFactor: 1.0,    // Digital camera zoom scale factor
  availableCameras: [], // Discovered back-facing video input devices
  currentCameraIndex: 0, // Currently active camera index in list
  defaultCity: '',      // Default city to append to typed or scanned addresses
  isListeningToVoice: false // Track voice recognition microphone status
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
  
  // Real-time clock update: refresh Sluttid/ETA stats every 30 seconds automatically
  setInterval(updateDashboard, 30000);
  
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
  
  const savedDefaultCity = localStorage.getItem('rm_default_city');
  if (savedDefaultCity) {
    state.defaultCity = savedDefaultCity;
    document.getElementById('default-city-input').value = state.defaultCity;
  }
}

// Save state to local storage
function saveStateToStorage() {
  localStorage.setItem('rm_warehouse', JSON.stringify(state.warehouse));
  localStorage.setItem('rm_stops', JSON.stringify(state.stops));
  localStorage.setItem('rm_global_duration', state.globalDuration.toString());
  localStorage.setItem('rm_default_city', state.defaultCity);
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
// Helper function to format Swedish address and preserve street/house numbers
function formatSwedishAddress(item, originalQuery) {
  const addr = item.address || {};
  
  // Extract house number from original query (e.g. "Sveavägen 44" -> "44", "Kungsgatan 12 B" -> "12 B")
  const queryNumberRegex = /\b(\d+\s*[a-zåäö]?)\b/i;
  let originalNumber = "";
  if (originalQuery) {
    const numMatch = originalQuery.match(queryNumberRegex);
    if (numMatch) {
      originalNumber = numMatch[1].trim();
    }
  }
  
  let road = addr.road || addr.pedestrian || addr.footway || addr.cycleway || "";
  let houseNumber = addr.house_number || originalNumber || ""; // Fallback to user's originally typed number if API returns undefined
  let city = addr.city || addr.town || addr.village || addr.suburb || addr.municipality || "";
  
  if (road) {
    let cleanRoad = road;
    
    // If we have a house number and it's not already in the street name string, append it!
    if (houseNumber && !cleanRoad.toLowerCase().includes(houseNumber.toLowerCase())) {
      cleanRoad = `${cleanRoad} ${houseNumber}`;
    }
    
    // Capitalize words nicely
    cleanRoad = cleanRoad.toLowerCase().replace(/\b[a-zåäöéèüïäåæø]/gi, char => char.toUpperCase());
    
    if (city) {
      const cleanCity = city.toLowerCase().replace(/\b[a-zåäöéèüïäåæø]/gi, char => char.toUpperCase());
      // Prevent duplicating city name if it's already part of the road string
      if (cleanRoad.toLowerCase().includes(cleanCity.toLowerCase())) {
        return cleanRoad;
      }
      return `${cleanRoad}, ${cleanCity}`;
    }
    return cleanRoad;
  }
  
  // Fallback split method if no road was parsed, but inject house number if missing
  let fallback = item.display_name.split(',').slice(0, 3).join(',').trim();
  if (originalNumber && !fallback.toLowerCase().includes(originalNumber.toLowerCase())) {
    const parts = fallback.split(',');
    parts[0] = `${parts[0].trim()} ${originalNumber}`;
    fallback = parts.join(', ');
  }
  
  // Clean capitalization
  return fallback.toLowerCase().replace(/\b[a-zåäöéèüïäåæø]/gi, char => char.toUpperCase());
}

async function searchAddress(query, isStop = false) {
  if (!query || query.trim().length < 3) return [];
  
  let searchQuery = query;
  if (isStop && state.defaultCity && !query.toLowerCase().includes(state.defaultCity.toLowerCase())) {
    searchQuery = `${query}, ${state.defaultCity}`;
  }
  
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=5&addressdetails=1&countrycodes=se`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RuttPlanerarenBudbil/1.0 (ruttmaster@example.com)'
      }
    });
    
    if (!response.ok) throw new Error('Geokodnings-fel');
    const data = await response.json();
    
    return data.map(item => {
      const formatted = formatSwedishAddress(item, query);
      return {
        address: formatted,
        fullAddress: item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon)
      };
    });
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

// Custom parser to extract multiple Swedish address lines while ignoring noise
function parseAddressesFromText(text) {
  // Split into lines, trim, and filter out completely empty lines
  const lines = text.split('\n')
    .map(l => {
      let clean = l.trim();
      // Strip leading stop numbers, bullets, labels, etc. (common in Bring manifest lists)
      clean = clean.replace(/^(stopp\s*\d+[:\-\s]*|[\d\.\-•:]+\s*|adress[:\-\s]*|gata[:\-\s]*|mottagaradress[:\-\s]*|leveransadress[:\-\s]*)/i, '');
      return clean.trim();
    })
    .filter(l => l.length > 2);
    
  // Blacklist words that commonly appear on shipping labels as noise
  const blacklist = [
    'postnord', 'express', 'varubrev', 'mypack', 'collect', 'dhl', 'schenker', 'ups', 'fedex',
    'vikt', 'weight', ' kg', ' kolli', 'paket', 'frakt', 'tracking', 'sändning', 'order',
    'referens', ' ref', 'mottagare', 'avsändare', 'sender', 'receiver', 'ship to', 'from',
    'tel', 'mobil', 'phone', 'e-post', 'email', 'retur', 'undeliverable', 'barcode', 'co2'
  ];
  
  // Standard Swedish street name + house number regex:
  // Must start with a street name (letters, spaces, dashes), followed by a house number (digits + optional letter like 12, 44A, 12 B)
  const streetRegex = /^([A-ZÅÄÖa-zåäöéèüïäå\-\s]{3,})\s+(\d+\s*[A-Za-zåäöÅÄÖ]?)\b/i;
  
  // Standard Swedish Zip Code + City regex:
  // E.g. "111 34 Stockholm" or "11134 Stockholm" or "41108 GÖTEBORG"
  const zipCityRegex = /\b(\d{3})\s*(\d{2})\s+([A-ZÅÄÖa-zåäöé\-\s]{3,})\b/i;
  
  const foundAddresses = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if line contains any blacklisted noise words
    const containsBlacklist = blacklist.some(term => line.toLowerCase().includes(term));
    if (containsBlacklist) continue;
    
    // Check if line matches a street address structure
    if (streetRegex.test(line)) {
      const streetMatch = line.match(streetRegex)[0].trim();
      let cityPart = "";
      
      // Look at the current line or the next 2 lines for a Zip + City line
      for (let offset = 0; offset <= 2; offset++) {
        const targetIdx = i + offset;
        if (targetIdx < lines.length) {
          const targetLine = lines[targetIdx];
          // Don't check target lines if they are blacklisted
          if (blacklist.some(term => targetLine.toLowerCase().includes(term))) continue;
          
          if (zipCityRegex.test(targetLine)) {
            const match = targetLine.match(zipCityRegex);
            const zip = `${match[1]} ${match[2]}`;
            const city = match[3].trim();
            cityPart = `${zip} ${city}`;
            break;
          }
        }
      }
      
      // Assemble the final address string
      let fullAddress = streetMatch;
      if (cityPart) {
        fullAddress = `${streetMatch}, ${cityPart}`;
      }
      
      // Clean and capitalize each word nicely (e.g. "SVEAVÄGEN 44" -> "Sveavägen 44")
      const cleanAddress = fullAddress
        .replace(/\b([A-ZÅÄÖa-zåäöéèüïäå]+)\b/g, word => {
          // If word is a zip code, keep it as digits
          if (/^\d+$/.test(word)) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .replace(/\s+/g, ' ');
        
      if (!foundAddresses.includes(cleanAddress)) {
        foundAddresses.push(cleanAddress);
      }
    }
  }
  
  // Fallback: If no street + zip combinations were found,
  // let's grab lines that strictly match the streetRegex on their own (without zip code)
  if (foundAddresses.length === 0) {
    for (let line of lines) {
      const containsBlacklist = blacklist.some(term => line.toLowerCase().includes(term));
      if (containsBlacklist) continue;
      
      if (streetRegex.test(line)) {
        const streetMatch = line.match(streetRegex)[0].trim();
        // Capitalize nicely
        const cleanAddress = streetMatch
          .replace(/\b([A-ZÅÄÖa-zåäöéèüïäå]+)\b/g, word => {
            if (/^\d+$/.test(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
          });
          
        if (!foundAddresses.includes(cleanAddress)) {
          foundAddresses.push(cleanAddress);
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
    
    // Also update HUD prominent badge inside the active stop card
    const hudEtaBadge = document.getElementById('hud-eta-badge');
    if (hudEtaBadge) hudEtaBadge.innerText = `🏁 Sluttid: Kl ${etaHours}:${etaMins}`;
    
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
function bindAutocomplete(inputId, dropdownId, onSelectCallback, isStop = false) {
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
      const results = await searchAddress(query, isStop);
      
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

// Parse Swedish spoken address string into street and house number fields
function parseSpokenAddress(text) {
  let cleanText = text.trim();
  
  // Clean trailing punctuation
  cleanText = cleanText.replace(/[\.\?!,]+$/, '').trim();
  
  // Replace spoken words like "nummer" or "nr" for high-accuracy splitting
  cleanText = cleanText.replace(/\b(nummer|nr)\b/gi, '').replace(/\s+/g, ' ').trim();
  
  // Capitalize words nicely in Title Case
  cleanText = cleanText.toLowerCase().replace(/\b[a-zåäöéèüïäåæø]/gi, char => char.toUpperCase());
  
  // Swedish address matching regex:
  // e.g. "Kungsgatan 12 Varberg" or "Sveavägen 44 B"
  // Group 1: Street Name (e.g. "Kungsgatan", "Västra Hamngatan")
  // Group 2: House Number (e.g. "12", "44 B", "12a")
  // Group 3: Optional City Name at the end (e.g. "Varberg", "Göteborg")
  const addressRegex = /^([A-ZÅÄÖa-zåäöéèüïäå\-\s]{3,})\s+(\d+\s*[A-Za-zåäöÅÄÖ]?)\b(?:\s+([A-ZÅÄÖa-zåäöéèüïäå\-\s]{3,}))?$/i;
  const match = cleanText.match(addressRegex);
  
  if (match) {
    const street = match[1].trim();
    const number = match[2].trim();
    const city = match[3] ? match[3].trim() : "";
    
    let finalStreet = street;
    if (city) {
      finalStreet = `${street}, ${city}`;
    }
    
    return {
      street: finalStreet,
      number: number
    };
  }
  
  // Fallback if no house numbers are found in spoken speech (e.g., just "Kungsgatan")
  return {
    street: cleanText,
    number: ""
  };
}

// Stop WebRTC camera stream and reset viewport states
function stopCameraStream() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
  }
  
  // Reset zoom state and style
  state.zoomFactor = 1.0;
  const zoomOverlay = document.getElementById('scan-zoom-overlay');
  if (zoomOverlay) zoomOverlay.classList.add('hide');
  const zoomSlider = document.getElementById('scan-zoom-slider');
  if (zoomSlider) zoomSlider.value = 1.0;
  
  const video = document.getElementById('scan-video');
  if (video) {
    video.srcObject = null;
    video.style.transform = 'scale(1)';
    video.classList.add('hide');
  }
  const captureBtn = document.getElementById('capture-photo-btn');
  if (captureBtn) {
    captureBtn.classList.add('hide');
  }
  const switchCameraBtn = document.getElementById('scan-switch-camera-btn');
  if (switchCameraBtn) {
    switchCameraBtn.classList.add('hide');
  }
  const preview = document.getElementById('scan-preview-container');
  if (preview) {
    const canvas = document.getElementById('label-canvas');
    if (canvas && canvas.classList.contains('hide')) {
      preview.classList.remove('hide');
    }
  }
  
  // Deactivate fullscreen camera overlay styling
  const scanModal = document.getElementById('scan-modal');
  if (scanModal) {
    scanModal.classList.remove('camera-active');
  }
}

// ==========================================================================
// 10. BINDING COMPONENT EVENT LISTENERS
// ==========================================================================
function setupEventListeners() {
  
  // 0. Force Update & Clear Cache Binding
  const clearCacheBtn = document.getElementById('clear-cache-btn');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      if (confirm("Vill du rensa appens cache och hämta den absolut senaste uppdateringen? (Din rutt försvinner inte!)")) {
        // Unregister service workers
        if ('serviceWorker' in navigator) {
          try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let registration of registrations) {
              await registration.unregister();
            }
          } catch (e) {
            console.error("SW unregister error:", e);
          }
        }
        // Clear caches
        if ('caches' in window) {
          try {
            const keys = await caches.keys();
            for (let key of keys) {
              await caches.delete(key);
            }
          } catch (e) {
            console.error("Cache clear error:", e);
          }
        }
        // Force hard reload from server
        window.location.reload(true);
      }
    });
  }
  
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
  const defaultCityInput = document.getElementById('default-city-input');
  if (defaultCityInput) {
    defaultCityInput.addEventListener('input', (e) => {
      state.defaultCity = e.target.value.trim();
      saveStateToStorage();
    });
  }

  let selectedStopItem = null;
  bindAutocomplete('stop-address-input', 'stop-autocomplete-results', (selectedItem) => {
    selectedStopItem = selectedItem;
    const numberInputField = document.getElementById('stop-number-input');
    if (numberInputField) {
      numberInputField.focus();
    }
  }, true);
  
  // "Lägg till i listan" button
  const addStopBtn = document.getElementById('add-stop-text-btn');
  const searchStopBtn = document.getElementById('search-stop-btn');
  
  const handleAddStop = async () => {
    const addressInput = document.getElementById('stop-address-input').value.trim();
    const numberInput = document.getElementById('stop-number-input').value.trim();
    const durInput = parseInt(document.getElementById('stop-duration-input').value, 10) || state.globalDuration;
    
    if (!addressInput || addressInput.length === 0) {
      alert("Vänligen skriv in en adress!");
      return;
    }
    
    // Join street name and street number beautifully (inserting before comma if standardort exists)
    let addressToSearch = addressInput;
    if (numberInput) {
      if (addressInput.includes(',')) {
        const parts = addressInput.split(',');
        parts[0] = `${parts[0].trim()} ${numberInput}`;
        addressToSearch = parts.join(', ');
      } else {
        addressToSearch = `${addressInput} ${numberInput}`;
      }
    }
    
    let lat = 0, lng = 0, address = "";
    
    // Verify geocoding details
    if (selectedStopItem && selectedStopItem.address === addressToSearch) {
      lat = selectedStopItem.lat;
      lng = selectedStopItem.lng;
      address = selectedStopItem.address;
    } else {
      const results = await searchAddress(addressToSearch, true);
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
    document.getElementById('stop-number-input').value = '';
    selectedStopItem = null;
    document.getElementById('stop-address-input').focus();
    
    // Auto-calculate route for the new stop in queue
    calculateRoute(false);
  };
  
  addStopBtn.addEventListener('click', handleAddStop);
  searchStopBtn.addEventListener('click', handleAddStop);
  
  // Enter keys navigation & submission listeners
  const stopAddressInputField = document.getElementById('stop-address-input');
  const stopNumberInputField = document.getElementById('stop-number-input');
  
  if (stopAddressInputField && stopNumberInputField) {
    stopAddressInputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stopNumberInputField.focus();
      }
    });

    stopNumberInputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddStop();
      }
    });
  }
  
  // Voice Speech recognition setup & event binding (Immersive Continuous Modal View)
  const voiceBtn = document.getElementById('voice-stop-btn');
  const voiceModal = document.getElementById('voice-modal');
  const closeVoiceModalBtn = document.getElementById('close-voice-modal-btn');
  const approveVoiceBtn = document.getElementById('approve-voice-btn');
  const voiceAddressesList = document.getElementById('voice-addresses-list');
  const voiceResultCard = document.getElementById('voice-result-card');
  const voiceStatusText = document.getElementById('voice-status-text');
  let voiceRecognition = null;
  
  // Register global empty checker for voice list removal actions
  window.checkVoiceListEmpty = () => {
    const list = document.getElementById('voice-addresses-list');
    if (list && list.querySelectorAll('.scanned-address-row').length === 0) {
      list.innerHTML = `
        <div class="empty-voice-addresses">
          <i data-lucide="map-pin" style="width:24px;height:24px;opacity:0.5;margin-bottom:8px;"></i>
          <p>Inga adresser tolkade än. Säg adresser som "Kungsgatan 12 Varberg" eller "Storgatan 5"...</p>
        </div>
      `;
      lucide.createIcons();
    }
  };
  
  const handleCloseVoiceModal = () => {
    state.isListeningToVoice = false;
    if (voiceRecognition) {
      try { voiceRecognition.stop(); } catch (e) {}
    }
    if (voiceModal) {
      voiceModal.classList.add('hide');
      voiceModal.classList.remove('voice-active');
    }
    document.body.style.overflow = ''; // unlock background scroll
  };

  if (voiceBtn && voiceModal) {
    if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      voiceRecognition = new SpeechRecognition();
      voiceRecognition.lang = 'sv-SE';
      voiceRecognition.continuous = true;
      voiceRecognition.interimResults = true; // Enabled for real-time Gemini-style stream
      
      voiceRecognition.onstart = () => {
        state.isListeningToVoice = true;
        if (voiceStatusText) {
          voiceStatusText.innerText = "🎤 Lyssnar... Tala på svenska nu.";
          voiceStatusText.style.color = '#10B981'; // Neongreen when active listening
        }
      };
      
      voiceRecognition.onend = () => {
        if (state.isListeningToVoice && !voiceModal.classList.contains('hide')) {
          // Automatic restart for continuous speech entry
          setTimeout(() => {
            if (state.isListeningToVoice && !voiceModal.classList.contains('hide')) {
              try { voiceRecognition.start(); } catch (err) { console.error('Failed to restart voice recognition:', err); }
            }
          }, 350);
        } else {
          state.isListeningToVoice = false;
          if (voiceStatusText) {
            voiceStatusText.innerText = "Avstängd";
            voiceStatusText.style.color = 'var(--text-secondary)';
          }
        }
      };
      
      voiceRecognition.onerror = (event) => {
        console.error('Voice recognition modal error:', event.error);
        if (event.error === 'not-allowed') {
          alert("Mikrofonbehörighet krävs för röstinmatning. Vänligen tillåt mikrofonen i din webbläsare.");
          handleCloseVoiceModal();
        } else if (event.error === 'aborted') {
          // Ignore manual stops
        } else {
          if (state.isListeningToVoice && !voiceModal.classList.contains('hide')) {
            setTimeout(() => {
              if (state.isListeningToVoice && !voiceModal.classList.contains('hide')) {
                try { voiceRecognition.start(); } catch (e) {}
              }
            }, 500);
          }
        }
      };
      
      // Real-time parser to split long continuous speech streams and add checklist rows
      function extractAndAddAddressFromSegment(text) {
        console.log('Extracting addresses from final speech segment:', text);
        
        // 1. Clean punctuation
        let cleanText = text.trim().replace(/[\.\?!,]+/g, ' ').replace(/\s+/g, ' ');
        
        // 2. Split by Swedish transition/conjunction words used to chain addresses
        const splitRegex = /\b(?:och sedan|och sen|sedan|sen|nästa stopp|nästa|stopp|eller|och)\b/gi;
        const parts = cleanText.split(splitRegex);
        
        parts.forEach(part => {
          const trimmedPart = part.trim();
          if (trimmedPart.length < 3) return;
          
          // Try to match street + number structure
          const parsed = parseSpokenAddress(trimmedPart);
          if (parsed && parsed.street) {
            const formattedAddress = parsed.number ? `${parsed.street} ${parsed.number}` : parsed.street;
            
            // Check for duplicates in the checklist rows
            const existingInputs = Array.from(voiceAddressesList.querySelectorAll('.address-txt')).map(inp => inp.value.trim().toLowerCase());
            if (existingInputs.includes(formattedAddress.toLowerCase())) return;
            
            // Remove the empty placeholder if present
            const placeholder = voiceAddressesList.querySelector('.empty-voice-addresses');
            if (placeholder) {
              placeholder.remove();
            }
            
            // Generate unique row ID
            const rowId = `voice-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            const row = document.createElement('div');
            row.className = 'scanned-address-row';
            row.style.animation = 'modalOpen 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
            row.innerHTML = `
              <div class="row-left">
                <input type="checkbox" checked class="address-chk" id="chk-${rowId}">
                <i data-lucide="map-pin" class="row-pin-icon text-primary"></i>
              </div>
              <input type="text" class="address-txt" value="${formattedAddress}" id="txt-${rowId}" placeholder="Adress...">
              <button class="btn-remove-row" onclick="this.parentElement.remove(); checkVoiceListEmpty();" title="Ta bort">
                <i data-lucide="trash-2"></i>
              </button>
            `;
            
            voiceAddressesList.appendChild(row);
            lucide.createIcons();
            
            // Pulse the section header to provide success feedback
            const listHeader = voiceResultCard.querySelector('h3');
            if (listHeader) {
              listHeader.style.animation = 'pulseGreenText 0.5s ease';
              setTimeout(() => listHeader.style.animation = '', 500);
            }
          }
        });
      }
      
      voiceRecognition.onresult = (event) => {
        let interimTranscript = '';
        
        // Loop through all results in the current session
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const segment = event.results[i][0].transcript.trim();
          if (event.results[i].isFinal) {
            if (!state.processedVoiceIndices) {
              state.processedVoiceIndices = new Set();
            }
            if (!state.processedVoiceIndices.has(i)) {
              state.processedVoiceIndices.add(i);
              if (segment.length >= 3) {
                state.spokenFinalSegments.push(segment);
                // Extract and append checklist rows
                extractAndAddAddressFromSegment(segment);
              }
            }
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        
        // Render transcript box in real time (glowing words stream)
        const transcriptDiv = document.getElementById('voice-live-transcript');
        if (transcriptDiv) {
          let html = '';
          state.spokenFinalSegments.forEach(seg => {
            html += `<span class="transcript-final">${seg} </span>`;
          });
          if (interimTranscript) {
            html += `<span class="transcript-interim">${interimTranscript}...</span>`;
          }
          
          if (!html) {
            html = `<span class="transcript-placeholder">Börja tala så strömmar orden här i realtid...</span>`;
          }
          
          transcriptDiv.innerHTML = html;
          transcriptDiv.scrollTop = transcriptDiv.scrollHeight; // Keep scrolled to bottom
        }
      };
      
      // Trigger voice modal opening on mic click
      voiceBtn.addEventListener('click', () => {
        // Clear checklist and show default placeholder
        voiceAddressesList.innerHTML = `
          <div class="empty-voice-addresses">
            <i data-lucide="map-pin" style="width:24px;height:24px;opacity:0.5;margin-bottom:8px;"></i>
            <p>Inga adresser tolkade än. Säg adresser som "Kungsgatan 12 Varberg" eller "Storgatan 5"...</p>
          </div>
        `;
        lucide.createIcons();
        
        // Reset transcript trackers
        state.spokenFinalSegments = [];
        state.processedVoiceIndices = new Set();
        
        const transcriptDiv = document.getElementById('voice-live-transcript');
        if (transcriptDiv) {
          transcriptDiv.innerHTML = `<span class="transcript-placeholder">Börja tala så strömmar orden här i realtid...</span>`;
        }
        
        // Open overlay with voice fullscreen class
        voiceModal.classList.add('voice-active');
        voiceModal.classList.remove('hide');
        document.body.style.overflow = 'hidden'; // lock background scroll
        
        state.isListeningToVoice = true;
        try {
          voiceRecognition.start();
        } catch (err) {
          console.error("Failed to start speech recognition:", err);
        }
      });
      
      if (closeVoiceModalBtn) {
        closeVoiceModalBtn.addEventListener('click', handleCloseVoiceModal);
      }
      
      // Batch geocoding and stops addition (identical flow to scanned photo stops)
      if (approveVoiceBtn) {
        approveVoiceBtn.addEventListener('click', async () => {
          // Stop recording
          state.isListeningToVoice = false;
          try { voiceRecognition.stop(); } catch (e) {}
          
          const rows = voiceAddressesList.querySelectorAll('.scanned-address-row');
          const selectedAddresses = [];
          
          rows.forEach(row => {
            const chk = row.querySelector('.address-chk');
            const txt = row.querySelector('.address-txt');
            if (chk && chk.checked && txt && txt.value.trim().length > 0) {
              selectedAddresses.push({
                addressText: txt.value.trim(),
                rowElement: row
              });
            }
          });
          
          if (selectedAddresses.length === 0) {
            alert("Inga adresser valda att spara!");
            return;
          }
          
          approveVoiceBtn.disabled = true;
          approveVoiceBtn.innerHTML = `<div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:8px;"></div> GEOMAPPAR ADRESSER...`;
          
          let successCount = 0;
          let hasErrors = false;
          
          // Batch geocode all in parallel
          const geocodePromises = selectedAddresses.map(async (item) => {
            // Remove previous error markings
            item.rowElement.classList.remove('geocode-error');
            const txtInput = item.rowElement.querySelector('.address-txt');
            if (txtInput) {
              txtInput.style.color = '';
              txtInput.style.borderColor = '';
            }
            
            try {
              // Run searchAddress with Sweden country code constraint
              const results = await searchAddress(item.addressText, true);
              if (results.length > 0) {
                const newStop = {
                  id: 'stop_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                  address: results[0].address,
                  lat: results[0].lat,
                  lng: results[0].lng,
                  duration: state.globalDuration,
                  status: 'pending'
                };
                state.stops.push(newStop);
                successCount++;
                
                // Color green for visual success feedback
                item.rowElement.style.borderColor = 'var(--success)';
                item.rowElement.style.background = 'rgba(16, 185, 129, 0.1)';
                
                // Uncheck so they are not saved again on retry
                const chk = item.rowElement.querySelector('.address-chk');
                if (chk) chk.checked = false;
              } else {
                throw new Error("Geocoding failed");
              }
            } catch (err) {
              hasErrors = true;
              item.rowElement.classList.add('geocode-error');
              if (txtInput) {
                txtInput.style.color = '#FCA5A5';
                txtInput.style.borderColor = 'var(--danger)';
              }
            }
          });
          
          await Promise.all(geocodePromises);
          
          approveVoiceBtn.disabled = false;
          approveVoiceBtn.innerHTML = `<i data-lucide="plus-circle"></i> Lägg till valda stopp i rutt`;
          lucide.createIcons();
          
          if (successCount > 0) {
            saveStateToStorage();
            renderStopsList();
            calculateRoute(false);
          }
          
          if (!hasErrors) {
            handleCloseVoiceModal();
          } else {
            alert("Vissa adresser kunde inte hittas på kartan. Kontrollera och rätta stavningen på de rödmarkerade fälten direkt i rutorna, och klicka sedan på spara igen!");
          }
        });
      }
    } else {
      voiceBtn.addEventListener('click', () => {
        alert("Röstinmatning stöds inte i din nuvarande webbläsare. Använd Google Chrome eller Safari på din mobil!");
      });
    }
  }
  
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
  
  // Camera Switching & Setup Helpers
  const startCamera = async (deviceId = null) => {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(track => track.stop());
      state.cameraStream = null;
    }
    
    const constraints = {
      video: {
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };
    
    if (deviceId) {
      constraints.video.deviceId = { exact: deviceId };
    } else {
      constraints.video.facingMode = { ideal: 'environment' };
    }
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.cameraStream = stream;
      videoElement.srcObject = stream;
      videoElement.classList.remove('hide');
      zoomOverlay.classList.remove('hide');
      previewContainer.classList.add('hide');
      capturePhotoBtn.classList.remove('hide');
      scanModal.classList.add('camera-active');
      
      // Force hardware sensor zoom to minimum (most zoomed out) if supported
      try {
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
          const capabilities = videoTrack.getCapabilities();
          if ('zoom' in capabilities) {
            await videoTrack.applyConstraints({
              advanced: [{ zoom: capabilities.zoom.min || 1.0 }]
            });
          }
        }
      } catch (zoomErr) {
        console.warn("Hardware zoom min constraints failed:", zoomErr);
      }
      
      // Scan and find other back cameras (now that we have permissions granted!)
      await enumerateBackCameras(stream);
      
    } catch (err) {
      console.warn("Could not start camera track:", err);
      if (deviceId) {
        // Fallback to default back camera if specific lens failed
        await startCamera(null);
      } else {
        stopCameraStream();
      }
    }
  };

  const enumerateBackCameras = async (activeStream) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      // Find back cameras (exclude front/user facing ones if labels exist)
      const backCameras = videoDevices.filter(device => {
        const label = (device.label || '').toLowerCase();
        return !label.includes('front') && !label.includes('user');
      });
      
      const finalCameras = backCameras.length > 0 ? backCameras : videoDevices;
      state.availableCameras = finalCameras.map(c => c.deviceId);
      
      // Detect current device ID
      if (activeStream) {
        const activeTrack = activeStream.getVideoTracks()[0];
        if (activeTrack && activeTrack.getSettings) {
          const activeDeviceId = activeTrack.getSettings().deviceId;
          if (activeDeviceId) {
            const idx = state.availableCameras.indexOf(activeDeviceId);
            if (idx !== -1) {
              state.currentCameraIndex = idx;
            }
          }
        }
      }
      
      // Show switcher if we discovered multiple lenses
      const switchBtn = document.getElementById('scan-switch-camera-btn');
      if (switchBtn) {
        if (state.availableCameras.length > 1) {
          switchBtn.classList.remove('hide');
        } else {
          switchBtn.classList.add('hide');
        }
      }
    } catch (e) {
      console.warn("Device enumeration failed:", e);
    }
  };

  cameraTrigger.addEventListener('click', () => {
    scanModal.classList.remove('hide');
    canvasElement.classList.add('hide');
    document.getElementById('scan-result-card').classList.add('hide');
    previewContainer.classList.remove('hide');
    
    state.zoomFactor = 1.0;
    zoomSlider.value = 1.0;
    videoElement.style.transform = 'scale(1)';
    
    // Start camera stream (default back lens)
    startCamera(null);
  });
  
  // Lens switch button click
  const switchCameraBtn = document.getElementById('scan-switch-camera-btn');
  if (switchCameraBtn) {
    switchCameraBtn.addEventListener('click', () => {
      if (state.availableCameras.length <= 1) return;
      
      // Cycle index
      state.currentCameraIndex = (state.currentCameraIndex + 1) % state.availableCameras.length;
      const nextDeviceId = state.availableCameras[state.currentCameraIndex];
      
      startCamera(nextDeviceId);
    });
  }
  
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
    
    // First, clear any previous error stylings
    rows.forEach(row => {
      row.classList.remove('geocode-error');
      const txt = row.querySelector('.address-txt');
      if (txt) txt.style.borderColor = '';
    });
    
    // Count checked rows
    let checkedCount = 0;
    rows.forEach(row => {
      const chk = row.querySelector('.address-chk');
      if (chk && chk.checked) checkedCount++;
    });
    
    if (checkedCount === 0) {
      alert("Inga adresser är markerade!");
      return;
    }
    
    // UI Button feedback to show loading state
    const approveBtn = document.getElementById('approve-scan-btn');
    const originalHtml = approveBtn.innerHTML;
    approveBtn.disabled = true;
    approveBtn.innerHTML = `<span class="spinner" style="width: 14px; height: 14px; display: inline-block; vertical-align: middle; margin-right: 8px; border-width: 2px;"></span> Geokodar adresser...`;
    
    let addedCount = 0;
    let failedCount = 0;
    
    // Geocode and add each selected address to the route list
    for (const row of rows) {
      const chk = row.querySelector('.address-chk');
      const txt = row.querySelector('.address-txt');
      
      if (chk && chk.checked && txt && txt.value.trim().length > 0) {
        const addr = txt.value.trim();
        try {
          const results = await searchAddress(addr, true);
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
            
            // Successfully geocoded! Uncheck this box so they don't add it again by mistake
            chk.checked = false;
          } else {
            // Geocoding returned zero matches on map
            failedCount++;
            row.classList.add('geocode-error');
            txt.style.borderColor = 'var(--danger)';
          }
        } catch (err) {
          console.error("Geocoding failed for:", addr, err);
          failedCount++;
          row.classList.add('geocode-error');
          txt.style.borderColor = 'var(--danger)';
        }
      }
    }
    
    approveBtn.disabled = false;
    approveBtn.innerHTML = originalHtml;
    
    if (addedCount > 0) {
      saveStateToStorage();
      renderStopsList();
      calculateRoute(false);
    }
    
    if (failedCount > 0) {
      alert(`Klar! ${addedCount} stopp lades till i listan.\n\n${failedCount} adresser kunde inte hittas på kartan och har rödmarkerats. Kontrollera stavningen på de rödmarkerade fälten (t.ex. lägg till gatunummer eller rätta stavfel) direkt i rutorna, och klicka sedan på "Lägg till" igen!`);
    } else {
      // Everything succeeded, safe to close modal!
      stopCameraStream();
      scanModal.classList.add('hide');
    }
  });
}
