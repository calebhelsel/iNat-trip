'use strict';

const { decodePolyline } = require('./geometry');

const COORD_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;

// Extract the ordered waypoints from a Google Maps /maps/dir/... URL.
// Waypoints live in the path between "/dir/" and the "/@..." view segment or
// the "/data=..." blob. Each is either "lat,lng" or a place/address string.
// Returns { waypoints: string[] } preserving order; coord waypoints are kept as
// "lat,lng" and address waypoints as decoded text (both accepted by Directions).
function parseRouteUrl(routeUrl) {
  let url;
  try {
    url = new URL(routeUrl);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  const dirIndex = url.pathname.indexOf('/dir/');
  if (dirIndex === -1) {
    throw new Error('URL must be a Google Maps directions link (contains "/maps/dir/").');
  }

  const after = url.pathname.slice(dirIndex + '/dir/'.length);
  const rawSegments = after.split('/');

  const waypoints = [];
  for (const seg of rawSegments) {
    if (!seg) continue;
    if (seg.startsWith('@')) break; // map view segment — waypoints end here
    if (seg.startsWith('data=')) break; // encoded data blob — stop
    let decoded;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg;
    }
    decoded = decoded.replace(/\+/g, ' ').trim();
    if (!decoded) continue;
    waypoints.push(decoded);
  }

  if (waypoints.length < 2) {
    throw new Error(
      'Could not read at least a start and end from the route URL. ' +
        'Use a "Directions" link with explicit stops.'
    );
  }
  return { waypoints };
}

function isCoord(s) {
  return COORD_RE.test(s);
}

// Call the Google Directions API for the given ordered waypoints and return the
// decoded overview polyline as [ [lat, lng], ... ].
async function fetchRoutePolyline(waypoints, apiKey) {
  const origin = waypoints[0];
  const destination = waypoints[waypoints.length - 1];
  const middle = waypoints.slice(1, -1);

  const params = new URLSearchParams({
    origin,
    destination,
    key: apiKey,
  });
  if (middle.length > 0) {
    params.set('waypoints', middle.join('|'));
  }

  const endpoint = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;
  const resp = await fetch(endpoint);
  if (!resp.ok) {
    throw new Error(`Directions API HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (data.status !== 'OK') {
    const msg = data.error_message ? `: ${data.error_message}` : '';
    throw new Error(`Directions API returned "${data.status}"${msg}`);
  }

  const route = data.routes[0];
  const encoded = route && route.overview_polyline && route.overview_polyline.points;
  if (!encoded) {
    throw new Error('Directions API returned no polyline.');
  }
  return decodePolyline(encoded);
}

module.exports = { parseRouteUrl, fetchRoutePolyline, isCoord };
