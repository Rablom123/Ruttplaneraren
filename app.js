/* ==========================================================================
   RUTTMÄSTAREN - APPLICATION ENGINE (app.js)
   ========================================================================== */

// Application State
const state = {
  warehouse: null, // { address: '', lat: 0, lng: 0 }
  stops: [],       // Array of: { id: '', address: '', lat: 0, lng: 0, duration: 4, status: 'pending'|'delivered'|'failed', isPinnedStart: false, isPinnedEnd: false }
  routeOrder: [],  // Array of stop indices (representing sequence including warehouse)
  routeGeometry: null,
  routeDistance: 0, // meters
  routeDuration: 0, // seconds
  globalDuration: 4, // default minutes per stop
  hudActiveIndex: -1, // active stop index in HUD mode
  isHUDActive: false,
  defaultCity: ''      // Default city to append to typed or scanned addresses
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
  
  // Pre-load OCR and other components removed
  
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
    state.stops = JSON.parse(savedStops).map(s => ({
      ...s,
      isPinnedStart: !!s.isPinnedStart,
      isPinnedEnd: !!s.isPinnedEnd
    }));
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
// ============================// Fetch current GPS location with high accuracy and a 5-second timeout fallback
function getCurrentGPSPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      console.warn("GPS stöds inte av din webbläsare.");
      resolve(null);
      return;
    }
    
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude
        });
      },
      (err) => {
        console.warn("GPS-hämtning misslyckades eller nekades:", err);
        resolve(null);
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0
      }
    );
  });
}

// Solve Traveling Salesperson Problem (TSP) using OSRM Distance Matrix starting from GPS position
async function calculateRoute(shouldOptimize = true) {
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
    // 1. Get current GPS position or fallback to warehouse
    let startPoint = null;
    if (shouldOptimize) {
      startPoint = await getCurrentGPSPosition();
      if (startPoint) {
        console.log("GPS-position hämtad framgångsrikt:", startPoint);
      } else {
        console.log("Kunde inte hämta GPS-position, använder lagret som startpunkt.");
      }
    }
    
    // Fallback to warehouse if GPS failed or not optimizing
    if (!startPoint) {
      startPoint = state.warehouse;
    }

    if (!startPoint) {
      alert("Hittade ingen startposition! Vänligen ställ in lagrets adress eller tillåt GPS-delning i webbläsaren.");
      showLoader(false);
      return;
    }

    // If we only have 1 stop, routing is simple: StartPoint -> Stop 1 -> Warehouse (or StartPoint if no warehouse)
    if (state.stops.length === 1) {
      const endPt = state.warehouse || startPoint;
      await fetchDirectRoute([startPoint, state.stops[0], endPt]);
      showLoader(false);
      return;
    }

    // Determine stop order
    if (shouldOptimize && state.stops.length > 1) {
      // 2. Identify startPoint, pinnedStart, pinnedEnd, and endPoint
      const pinnedStartStop = state.stops.find(s => s.isPinnedStart);
      const pinnedEndStop = state.stops.find(s => s.isPinnedEnd);
      
      // Free stops are all stops that are NOT pinned start or pinned end
      const freeStops = state.stops.filter(s => !s.isPinnedStart && !s.isPinnedEnd);

      // Endpoint is state.warehouse if it exists, otherwise the last stop
      const endPoint = state.warehouse || state.stops[state.stops.length - 1];

      // 3. Construct locations array for matrix calculation
      // Format: [StartPoint, PinnedStart (if exists), ...FreeStops, PinnedEnd (if exists), EndPoint]
      const locations = [startPoint];
      if (pinnedStartStop) locations.push(pinnedStartStop);
      locations.push(...freeStops);
      if (pinnedEndStop) locations.push(pinnedEndStop);
      locations.push(endPoint);

      // 4. Fetch the travel durations from OSRM between all locations
      const matrix = await fetchOSRMDurationMatrix(locations);
      
      // 5. Solve the constrained TSP
      const optimalIndicesOrder = solveTSP2OptConstrained(matrix, !!pinnedStartStop, !!pinnedEndStop);
      
      // 6. Reassemble stops order based on optimalIndicesOrder
      const optimizedStops = [];
      
      // First is the pinned start stop, if it exists
      if (pinnedStartStop) {
        optimizedStops.push(pinnedStartStop);
      }
      
      // Then the free stops in their optimized order
      const firstFreeLocIdx = pinnedStartStop ? 2 : 1;
      
      for (let i = 1; i < optimalIndicesOrder.length - 1; i++) {
        const locIdx = optimalIndicesOrder[i];
        if (locIdx >= firstFreeLocIdx && locIdx < firstFreeLocIdx + freeStops.length) {
          const freeStopIdx = locIdx - firstFreeLocIdx;
          optimizedStops.push(freeStops[freeStopIdx]);
        }
      }
      
      // Finally, the pinned end stop, if it exists
      if (pinnedEndStop) {
        optimizedStops.push(pinnedEndStop);
      }
      
      state.stops = optimizedStops;
      saveStateToStorage();
      renderStopsList();
    }

    // 7. Get the detailed path geometry for the sorted sequence
    const routeCoords = [startPoint, ...state.stops];
    if (state.warehouse) {
      routeCoords.push(state.warehouse);
    }
    await fetchDirectRoute(routeCoords);
    
  } catch (error) {
    console.error("Optimization failed, doing fallback estimation:", error);
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

// TSP Solver (Constrained 2-Opt Heuristic)
function solveTSP2OptConstrained(matrix, hasPinnedStart, hasPinnedEnd) {
  const n = matrix.length;
  
  const firstFreeIdx = hasPinnedStart ? 2 : 1;
  const lastFreeIdx = hasPinnedEnd ? n - 3 : n - 2;
  
  // Initial tour: startPoint (0) -> pinnedStart (1, if exists) -> greedy free stops -> pinnedEnd (n-2, if exists) -> endPoint (n-1)
  let bestTour = [0];
  if (hasPinnedStart) {
    bestTour.push(1);
  }
  
  // Greedy nearest-neighbor tour for the free stops
  const unvisited = new Set();
  for (let i = firstFreeIdx; i <= lastFreeIdx; i++) {
    unvisited.add(i);
  }
  
  let current = hasPinnedStart ? 1 : 0;
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
  
  if (hasPinnedEnd) {
    bestTour.push(n - 2);
  }
  bestTour.push(n - 1); // endPoint
  
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
  let attempts = 0;
  const maxAttempts = 500;
  
  while (improved && attempts < maxAttempts) {
    improved = false;
    attempts++;
    
    // We only swap indices between firstFreeIdx and lastFreeIdx (inclusive)
    for (let i = firstFreeIdx; i < lastFreeIdx; i++) {
      for (let j = i + 1; j <= lastFreeIdx; j++) {
        const newTour = [...bestTour];
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
}= arr[j];
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

// OCR Address Scanner functions removed

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
  
  // Calculate remaining work minutes (only pending stops!)
  const remainingWorkMinutes = state.stops
    .filter(s => s.status === 'pending')
    .reduce((sum, stop) => sum + parseInt(stop.duration || 0, 10), 0);
  
  // Estimate remaining drive time (linear approximation based on remaining segments)
  let remainingDriveMinutes = driveMinutes;
  if (totalStopsCount > 0 && completedCount > 0) {
    const segmentsTotal = totalStopsCount + 1;
    const segmentsLeft = Math.max(1, segmentsTotal - completedCount);
    remainingDriveMinutes = Math.round(driveMinutes * (segmentsLeft / segmentsTotal));
  }
  
  // Total remaining duration
  const remainingTotalMinutes = remainingDriveMinutes + remainingWorkMinutes;
  
  // Distans conversion from meters -> km
  const totalDistanceKm = (state.routeDistance / 1000).toFixed(1);
  
  // Estimate remaining distance
  let remainingDistanceKm = totalDistanceKm;
  if (totalStopsCount > 0 && completedCount > 0) {
    const segmentsTotal = totalStopsCount + 1;
    const segmentsLeft = Math.max(1, segmentsTotal - completedCount);
    remainingDistanceKm = ((state.routeDistance / 1000) * (segmentsLeft / segmentsTotal)).toFixed(1);
  }
  
  // Update texts (we show remaining stats in HUD and on dashboard as they progress)
  document.getElementById('stat-total-time').innerText = formatMinutes(remainingTotalMinutes);
  document.getElementById('stat-drive-time').innerText = formatMinutes(remainingDriveMinutes);
  document.getElementById('stat-work-time').innerText = formatMinutes(remainingWorkMinutes);
  document.getElementById('stat-distance').innerText = `${remainingDistanceKm} km`;
  
  // Sluttid (ETA)
  if (totalStopsCount > 0) {
    const now = new Date();
    const etaDate = new Date(now.getTime() + remainingTotalMinutes * 60 * 1000);
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
      hudDistLeft.innerText = `Kvar: ${remainingDistanceKm} km (${remainingStops} stopp)`;
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
    
    let pinnedClass = '';
    if (stop.isPinnedStart) pinnedClass = 'pinned-start';
    else if (stop.isPinnedEnd) pinnedClass = 'pinned-end';
    
    li.className = `stop-item ${stop.status} ${pinnedClass}`;
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
          <div class="pin-actions-group">
            <button class="btn-pin-toggle pin-start ${stop.isPinnedStart ? 'active' : ''}" data-id="${stop.id}" title="Fäst som startstopp">
              <i data-lucide="anchor"></i> Startstopp
            </button>
            <button class="btn-pin-toggle pin-end ${stop.isPinnedEnd ? 'active' : ''}" data-id="${stop.id}" title="Fäst som slutstopp">
              <i data-lucide="flag"></i> Slutstopp
            </button>
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

  // Pin Start Toggle
  document.querySelectorAll('.pin-start').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const stop = state.stops.find(s => s.id === id);
      if (stop) {
        const currentVal = !!stop.isPinnedStart;
        // Clear other start pins
        state.stops.forEach(s => s.isPinnedStart = false);
        // Toggle this stop
        stop.isPinnedStart = !currentVal;
        // If it becomes start pin, it cannot be end pin
        if (stop.isPinnedStart) {
          stop.isPinnedEnd = false;
        }
        saveStateToStorage();
        renderStopsList();
        calculateRoute(false);
      }
    });
  });

  // Pin End Toggle
  document.querySelectorAll('.pin-end').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.id;
      const stop = state.stops.find(s => s.id === id);
      if (stop) {
        const currentVal = !!stop.isPinnedEnd;
        // Clear other end pins
        state.stops.forEach(s => s.isPinnedEnd = false);
        // Toggle this stop
        stop.isPinnedEnd = !currentVal;
        // If it becomes end pin, it cannot be start pin
        if (stop.isPinnedEnd) {
          stop.isPinnedStart = false;
        }
        saveStateToStorage();
        renderStopsList();
        calculateRoute(false);
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

// WebRTC and Spoken voice parser helpers removed

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
      status: 'pending',
      isPinnedStart: false,
      isPinnedEnd: false
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
  
  // Voice feature listeners removed
  
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
  
  // Camera and OCR scanning listeners removed
}
