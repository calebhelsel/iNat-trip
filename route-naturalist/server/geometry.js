'use strict';

// Geometry helpers for the 1-mile route buffer and query-circle placement.
// All distances are in meters unless a name says otherwise.

const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_MILE = 1609.344;
const BUFFER_METERS = METERS_PER_MILE; // fixed 1-mile buffer per the brief

// Decode a Google "encoded polyline" string into [ [lat, lng], ... ].
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two [lat, lng] points, in meters.
function haversineMeters(a, b) {
  const lat1 = toRadians(a[0]);
  const lat2 = toRadians(b[0]);
  const dLat = lat2 - lat1;
  const dLng = toRadians(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Local equirectangular projection (meters) around a reference latitude.
// Accurate enough at the 1-mile scale we care about.
function projectMeters(point, refLatRad) {
  const x = toRadians(point[1]) * Math.cos(refLatRad) * EARTH_RADIUS_M;
  const y = toRadians(point[0]) * EARTH_RADIUS_M;
  return [x, y];
}

// Shortest distance (meters) from point p to segment a-b.
function pointToSegmentMeters(p, a, b) {
  const refLatRad = toRadians((a[0] + b[0]) / 2);
  const P = projectMeters(p, refLatRad);
  const A = projectMeters(a, refLatRad);
  const B = projectMeters(b, refLatRad);

  const abx = B[0] - A[0];
  const aby = B[1] - A[1];
  const apx = P[0] - A[0];
  const apy = P[1] - A[1];

  const lenSq = abx * abx + aby * aby;
  let t = lenSq === 0 ? 0 : (apx * abx + apy * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const cx = A[0] + t * abx;
  const cy = A[1] + t * aby;
  const dx = P[0] - cx;
  const dy = P[1] - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

// Shortest distance (meters) from point p to a polyline (list of [lat, lng]).
function distanceToPolylineMeters(p, polyline) {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) return haversineMeters(p, polyline[0]);
  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentMeters(p, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
    if (min === 0) break;
  }
  return min;
}

function isWithinBuffer(p, polyline, bufferMeters = BUFFER_METERS) {
  return distanceToPolylineMeters(p, polyline) <= bufferMeters;
}

// Interpolate a point at fraction t along segment a-b.
function interpolate(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Place query-circle centers along the polyline, spaced by arc-length so that
// circles of `queryRadiusM` fully cover the `bufferMeters` band around a straight
// run. On curves the chord is shorter than the arc, so arc-length spacing only
// increases overlap — safe. Returns [ { lat, lng }, ... ].
//
// A circle of radius R centered on the route covers the buffer band for a
// longitudinal half-extent of sqrt(R^2 - B^2) each side of its center, so
// consecutive centers may be up to 2*sqrt(R^2 - B^2) apart. We apply a safety
// factor to guard against curvature and floating error.
function buildCircleCenters(polyline, queryRadiusM, bufferMeters = BUFFER_METERS) {
  if (polyline.length === 0) return [];
  if (queryRadiusM <= bufferMeters) {
    throw new Error('Query radius must be larger than the buffer.');
  }

  const halfExtent = Math.sqrt(queryRadiusM * queryRadiusM - bufferMeters * bufferMeters);
  const step = 2 * halfExtent * 0.9; // safety factor

  const centers = [polyline[0]];
  let distSinceLast = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    let segLen = haversineMeters(a, b);
    if (segLen === 0) continue;

    let start = 0; // fraction along this segment already consumed
    while (distSinceLast + (1 - start) * segLen >= step) {
      const remaining = step - distSinceLast; // meters into the unconsumed part
      const t = start + remaining / segLen;
      centers.push(interpolate(a, b, t));
      start = t;
      distSinceLast = 0;
    }
    distSinceLast += (1 - start) * segLen;
  }

  const last = polyline[polyline.length - 1];
  if (haversineMeters(centers[centers.length - 1], last) > 1) {
    centers.push(last);
  }
  return centers.map(([lat, lng]) => ({ lat, lng }));
}

module.exports = {
  BUFFER_METERS,
  METERS_PER_MILE,
  decodePolyline,
  haversineMeters,
  distanceToPolylineMeters,
  isWithinBuffer,
  buildCircleCenters,
};
