'use strict';

// Pure filter helpers, shared with the Node test suite (see public/filters.js).
const Filters = window.RouteNatFilters;

// ---- Persistence keys ----
const LS_INPUTS = 'routenat.inputs';
const LS_CHECKED = 'routenat.checked';
const LS_ROUTE = 'routenat.route';

// ---- Module state ----
let map = null;
let mapReady = false;
let infoWindow = null;
let markers = []; // { marker, obs, speciesKey }
let routePolyline = null;

let data = null; // latest scan result
let obsById = new Map(); // id -> observation (for "Add to route")
let checkedState = loadJson(LS_CHECKED, {}); // speciesKey -> bool (live source of truth)
let viewFilter = null; // null | 'green' | 'blue' — Plants/Verts sidebar filter
let routeItems = loadJson(LS_ROUTE, []); // ordered added observations

// ---- Utilities ----
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function el(id) {
  return document.getElementById(id);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function showStatus(message, kind) {
  const box = el('status');
  if (!message) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `status ${kind || 'info'}`;
  box.textContent = message;
}

// ---- Google Maps bootstrap (called by the Maps JS SDK) ----
window.initMap = function initMap() {
  map = new google.maps.Map(el('map'), {
    center: { lat: 39.5, lng: -98.35 }, // continental US
    zoom: 4,
    mapTypeId: 'hybrid',
    gestureHandling: 'greedy', // cursor scroll = zoom
    streetViewControl: false,
    fullscreenControl: true,
  });
  infoWindow = new google.maps.InfoWindow();
  mapReady = true;
  if (data) renderMap();
};

// ---- Scan flow ----
async function runScan(routeUrl, username, isAuto) {
  showStatus(isAuto ? 'Reloading saved scan…' : 'Scanning route… this can take a moment.', 'info');
  el('scan-btn').disabled = true;

  try {
    const resp = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeUrl, username }),
    });
    // Parse defensively: a very long scan can have its connection cut by a proxy
    // or a restarting instance, leaving an empty/non-JSON body. Give a clear
    // message instead of "Unexpected end of JSON input".
    const raw = await resp.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        resp.ok
          ? 'The server returned an incomplete response — the route is likely too long/dense and the scan timed out. Try a shorter route or a smaller area.'
          : `Request failed (${resp.status}).`
      );
    }
    if (!resp.ok) throw new Error(payload.error || `Request failed (${resp.status})`);

    data = payload;
    saveJson(LS_INPUTS, { routeUrl, username });

    // Default any newly seen species to DESELECTED — the map starts empty and the
    // user reveals species via the checkboxes or the Plants/Verts/Select-all
    // buttons. Existing saved choices are preserved.
    for (const sp of data.species) {
      if (!(sp.key in checkedState)) checkedState[sp.key] = false;
    }
    saveJson(LS_CHECKED, checkedState);

    obsById = new Map();
    for (const sp of data.species) {
      for (const obs of sp.observations) obsById.set(String(obs.id), obs);
    }

    renderSidebar();
    if (mapReady) renderMap();

    const secs = data.meta ? (data.meta.timingsMs.total / 1000).toFixed(1) : null;
    let summary =
      `${data.speciesCount} unseen species · ${data.unseenCount} observations ` +
      `within 1 mi · ${data.circleCount} query circles` +
      (data.meta ? ` · ${data.meta.requests} iNat requests` : '') +
      (secs && !data.cached ? ` · ${secs}s` : '') +
      (data.cached ? ' · cached' : '');
    const circlesDone = data.meta ? data.meta.circlesQueried : null;
    if (data.partial) {
      summary +=
        ` — ⚠ stopped early after ${circlesDone}/${data.circleCount} circles ` +
        `(${data.partialReason || 'iNaturalist limit reached'}); showing partial results.`;
    } else if (data.timedOut) {
      summary +=
        ` — ⚠ hit the time limit after ${circlesDone}/${data.circleCount} circles; ` +
        'showing partial results. Try a shorter route or a smaller area.';
    } else if (data.budgetHit || data.truncated) {
      summary +=
        ' — ⚠ hit the request budget, results may be incomplete. ' +
        'Try a shorter route or a smaller QUERY_RADIUS_KM.';
    }
    showStatus(summary, data.partial || data.truncated ? 'error' : 'info');
  } catch (err) {
    showStatus(err.message || 'Scan failed.', 'error');
  } finally {
    el('scan-btn').disabled = false;
  }
}

// ---- Sidebar ----
function renderSidebar() {
  const list = el('species-list');
  const filterBtns = el('filter-btns');
  list.innerHTML = '';
  if (!data || data.species.length === 0) {
    list.innerHTML = '<p class="empty">No unseen species found within 1 mile of this route.</p>';
    filterBtns.hidden = true;
    return;
  }

  filterBtns.hidden = false;
  updateFilterButtons();

  // The color buttons narrow which species rows are shown (Plants/Verts). The
  // species are already sorted globally-rarest-first by the server.
  const rows = Filters.visibleSpecies(data.species, viewFilter);
  if (rows.length === 0) {
    list.innerHTML = '<p class="empty">No species of this group in range.</p>';
    return;
  }

  for (const sp of rows) {
    const row = document.createElement('div');
    row.className = 'species-row';

    const checked = Filters.isSpeciesVisible(checkedState, sp.key);
    const thumb = sp.photoUrl
      ? `<img class="thumb" src="${escapeHtml(sp.photoUrl)}" alt="" />`
      : `<span class="thumb placeholder"></span>`;
    const rarity =
      sp.globalObsCount != null
        ? `${sp.globalObsCount.toLocaleString()} on iNat`
        : 'count unknown';

    row.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} data-key="${escapeHtml(sp.key)}" />
      ${thumb}
      <div class="species-meta">
        <a href="${sp.taxonUrl ? escapeHtml(sp.taxonUrl) : '#'}" target="_blank" rel="noopener">
          ${escapeHtml(sp.displayName)}
        </a>
        <div class="species-count">
          <span class="swatch" style="background:${swatchColor(sp.color)}"></span>
          ${sp.count} here · <span class="rarity">${escapeHtml(rarity)}</span>
        </div>
      </div>`;

    const cb = row.querySelector('input');
    cb.addEventListener('change', () => onToggleSpecies(sp.key, cb.checked));
    list.appendChild(row);
  }
}

// Individual checkbox toggle — now applies to the map LIVE (no page reload).
function onToggleSpecies(key, isChecked) {
  checkedState[key] = isChecked;
  saveJson(LS_CHECKED, checkedState);
  setSpeciesVisibility(key, isChecked);
  updateFilterButtons();
}

function anyChecked() {
  return !!(data && Filters.anyChecked(data.species, checkedState));
}

// Reflect current state onto the header buttons: the Select/Deselect-all label
// and which color filter (if any) is active.
function updateFilterButtons() {
  el('toggle-all-btn').textContent = anyChecked() ? 'Deselect all' : 'Select all';
  for (const [id, color] of [['plants-btn', 'green'], ['verts-btn', 'blue']]) {
    const btn = el(id);
    const active = viewFilter === color;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

// Select all / Deselect all — live map update over already-loaded markers.
function toggleAll() {
  if (!data) return;
  const turnOn = !anyChecked();
  checkedState = Filters.selectionForAll(data.species, turnOn, checkedState);
  saveJson(LS_CHECKED, checkedState);
  renderSidebar();
  applyLiveFilter();
}

// Plants ('green') / Verts ('blue'): filter the sidebar to that group AND select
// only that group on the map. Clicking the active button again clears the filter,
// returning the sidebar to all species. Live — no reload.
function toggleColorFilter(color) {
  if (!data) return;
  if (viewFilter === color) {
    viewFilter = null; // reverse: show every species again
  } else {
    viewFilter = color;
    checkedState = Filters.selectionForColor(data.species, color, checkedState);
    saveJson(LS_CHECKED, checkedState);
  }
  renderSidebar();
  applyLiveFilter();
}

// Show/hide one species' markers immediately.
function setSpeciesVisibility(key, visible) {
  for (const m of markers) {
    if (m.speciesKey === key) m.marker.setMap(visible ? map : null);
  }
}

// Sync every marker's visibility to the current checkbox state.
function applyLiveFilter() {
  for (const m of markers) {
    const visible = Filters.isSpeciesVisible(checkedState, m.speciesKey);
    m.marker.setMap(visible ? map : null);
  }
}

function swatchColor(color) {
  return color === 'green' ? '#4a7c35' : color === 'blue' ? '#2f6fd0' : '#c0392b';
}
function pinColor(color) {
  return color === 'green' ? '#2f9e2f' : color === 'blue' ? '#2f6fd0' : '#e23b3b';
}

// ---- Map ----
function renderMap() {
  // Clear old markers + route.
  for (const m of markers) m.marker.setMap(null);
  markers = [];
  if (routePolyline) {
    routePolyline.setMap(null);
    routePolyline = null;
  }

  if (!data) return;

  // Draw the route.
  if (data.polyline && data.polyline.length) {
    routePolyline = new google.maps.Polyline({
      path: data.polyline.map(([lat, lng]) => ({ lat, lng })),
      geodesic: true,
      strokeColor: '#ffd21e',
      strokeOpacity: 0.9,
      strokeWeight: 4,
      map,
    });
  }

  const bounds = new google.maps.LatLngBounds();
  for (const [lat, lng] of data.polyline || []) bounds.extend({ lat, lng });

  // Create a marker per observation for EVERY species, but only attach it to the
  // map if its species is currently selected. Creating them all (hidden) up front
  // lets the live filters (Select all / Plants / Verts / individual checkboxes)
  // reveal species instantly without re-querying. The map starts empty because
  // species default to deselected.
  for (const sp of data.species) {
    const visible = Filters.isSpeciesVisible(checkedState, sp.key);
    for (const obs of sp.observations) {
      const position = { lat: obs.lat, lng: obs.lng };
      const marker = new google.maps.Marker({
        position,
        map: visible ? map : null,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: pinColor(obs.color),
          fillOpacity: 0.95,
          strokeColor: '#ffffff',
          strokeWeight: 1.5,
        },
        title: obs.displayName,
      });
      marker.addListener('click', () => openCard(obs, marker));
      markers.push({ marker, obs, speciesKey: sp.key });
      if (visible) bounds.extend(position);
    }
  }

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, 40);
  }
}

function openCard(obs, marker) {
  const alreadyAdded = routeItems.some((r) => String(r.id) === String(obs.id));
  const thumb = obs.photoUrl
    ? `<a href="${escapeHtml(obs.obsUrl)}" target="_blank" rel="noopener">
         <img class="obs-thumb" src="${escapeHtml(obs.photoUrl)}" alt="" /></a>`
    : `<a href="${escapeHtml(obs.obsUrl)}" target="_blank" rel="noopener">
         <div class="obs-thumb"></div></a>`;

  const html = `
    <div class="obs-card">
      ${thumb}
      <p class="obs-name">${escapeHtml(obs.displayName)}</p>
      <p class="obs-date">${escapeHtml(obs.date || 'date unknown')}</p>
      ${obs.researchGrade ? '<span class="rg-badge">Research Grade</span>' : ''}
      <button class="add-btn" data-id="${escapeHtml(obs.id)}" ${alreadyAdded ? 'disabled' : ''}>
        ${alreadyAdded ? 'Added to route' : 'Add to route'}
      </button>
    </div>`;

  infoWindow.setContent(html);
  infoWindow.open({ map, anchor: marker });

  google.maps.event.addListenerOnce(infoWindow, 'domready', () => {
    const btn = document.querySelector('.obs-card .add-btn');
    if (btn && !btn.disabled) {
      btn.addEventListener('click', () => {
        addToRoute(obs);
        btn.disabled = true;
        btn.textContent = 'Added to route';
      });
    }
  });
}

// ---- Route builder ----
function addToRoute(obs) {
  if (routeItems.some((r) => String(r.id) === String(obs.id))) return;
  routeItems.push({
    id: obs.id,
    displayName: obs.displayName,
    date: obs.date,
    obsUrl: obs.obsUrl,
    lat: obs.lat,
    lng: obs.lng,
  });
  saveJson(LS_ROUTE, routeItems);
  renderRouteBuilder();
}

function removeFromRoute(id) {
  routeItems = routeItems.filter((r) => String(r.id) !== String(id));
  saveJson(LS_ROUTE, routeItems);
  renderRouteBuilder();
  // Re-enable the add button if that card is open.
  const btn = document.querySelector(`.obs-card .add-btn[data-id="${CSS.escape(String(id))}"]`);
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Add to route';
  }
}

function renderRouteBuilder() {
  const list = el('route-list');
  const createBtn = el('create-route-btn');
  list.innerHTML = '';

  if (routeItems.length === 0) {
    list.innerHTML = '<li class="empty">Add observations from the map to build a detour route.</li>';
    createBtn.disabled = true;
    el('route-warn').hidden = true;
    return;
  }

  for (const item of routeItems) {
    const li = document.createElement('li');
    li.className = 'route-item';
    li.innerHTML = `
      <span class="ri-name">${escapeHtml(item.displayName)}</span>
      <span class="ri-date">${escapeHtml(item.date || '')}</span>
      <a class="ri-link" href="${escapeHtml(item.obsUrl)}" target="_blank" rel="noopener">observation ↗</a>
      <button class="ri-remove" title="Remove" data-id="${escapeHtml(item.id)}">🗑</button>`;
    li.querySelector('.ri-remove').addEventListener('click', () => removeFromRoute(item.id));
    list.appendChild(li);
  }
  createBtn.disabled = false;

  // Warn about the practical ~10-waypoint cap on Google Maps dir/ URLs.
  const originalCount = data && data.waypoints ? data.waypoints.length : 2;
  const total = originalCount + routeItems.length;
  const warn = el('route-warn');
  if (total > 10) {
    warn.hidden = false;
    warn.textContent =
      `⚠ This route has ${total} stops. Google Maps directions URLs practically cap ` +
      `around 10 — remove some observations or split the trip, or the link may not open correctly.`;
  } else {
    warn.hidden = true;
  }
}

function createNewRoute() {
  if (!data || !data.waypoints || routeItems.length === 0) return;
  const wp = data.waypoints;
  const start = wp[0];
  const end = wp[wp.length - 1];
  const originalMiddle = wp.slice(1, -1);
  const detours = routeItems.map((r) => `${r.lat},${r.lng}`); // selection order

  const ordered = [start, ...originalMiddle, ...detours, end];
  const path = ordered.map((s) => encodeURIComponent(s)).join('/');
  const url = `https://www.google.com/maps/dir/${path}`;
  window.open(url, '_blank', 'noopener');
}

// ---- Wire up ----
document.addEventListener('DOMContentLoaded', () => {
  renderRouteBuilder();

  const saved = loadJson(LS_INPUTS, null);
  if (saved) {
    el('route-url').value = saved.routeUrl || '';
    el('username').value = saved.username || '';
  }

  el('scan-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const routeUrl = el('route-url').value.trim();
    const username = el('username').value.trim();
    if (!routeUrl || !username) return;
    runScan(routeUrl, username, false);
  });

  el('create-route-btn').addEventListener('click', createNewRoute);
  el('toggle-all-btn').addEventListener('click', toggleAll);
  el('plants-btn').addEventListener('click', () => toggleColorFilter('green'));
  el('verts-btn').addEventListener('click', () => toggleColorFilter('blue'));

  // Auto-run the saved scan on reload so persisted checkbox filters apply.
  if (saved && saved.routeUrl && saved.username) {
    runScan(saved.routeUrl, saved.username, true);
  }
});
