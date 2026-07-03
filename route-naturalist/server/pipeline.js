'use strict';

const { parseRouteUrl, fetchRoutePolyline } = require('./google');
const {
  userExists,
  fetchObservationsInCircle,
  fetchObservedTaxonIds,
  getMetrics,
  resetMetrics,
} = require('./inat');
const { buildCircleCenters, distanceToPolylineMeters, BUFFER_METERS } = require('./geometry');
const cache = require('./cache');

// Hard ceiling on iNat requests per scan so a huge/dense route fails fast with
// partial results instead of hanging for minutes or exhausting the daily quota.
const DEFAULT_MAX_REQUESTS = 400;

const VERTEBRATE_TAXA = new Set([
  'Aves',
  'Amphibia',
  'Reptilia',
  'Mammalia',
  'Actinopterygii',
]);

function colorForIconicTaxon(iconic) {
  if (iconic === 'Plantae') return 'green';
  if (VERTEBRATE_TAXA.has(iconic)) return 'blue';
  return 'red';
}

// iNat photo urls come back as "square" by default; upgrade to a crisp square.
function squarePhotoUrl(obs) {
  const photo = obs.photos && obs.photos[0];
  if (!photo || !photo.url) return null;
  return photo.url.replace('/square.', '/medium.');
}

function normalizeObservation(obs, polyline) {
  if (!obs.location) return null;
  const [latStr, lngStr] = obs.location.split(',');
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const taxon = obs.taxon || {};
  const commonName = taxon.preferred_common_name || null;
  const scientificName = taxon.name || 'Unknown species';

  return {
    id: obs.id,
    lat,
    lng,
    taxonId: taxon.id || null,
    iconicTaxon: taxon.iconic_taxon_name || null,
    color: colorForIconicTaxon(taxon.iconic_taxon_name),
    commonName,
    scientificName,
    displayName: commonName ? `${commonName} (${scientificName})` : scientificName,
    photoUrl: squarePhotoUrl(obs),
    date: obs.observed_on || (obs.time_observed_at || '').slice(0, 10) || null,
    qualityGrade: obs.quality_grade || null,
    researchGrade: obs.quality_grade === 'research',
    obsUrl: `https://www.inaturalist.org/observations/${obs.id}`,
    _distanceToRoute: distanceToPolylineMeters([lat, lng], polyline),
  };
}

// Group surviving observations by species and sort species by descending count.
function groupBySpecies(observations) {
  const groups = new Map();
  for (const obs of observations) {
    const key = obs.taxonId != null ? `t${obs.taxonId}` : `n:${obs.scientificName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        taxonId: obs.taxonId,
        commonName: obs.commonName,
        scientificName: obs.scientificName,
        displayName: obs.displayName,
        iconicTaxon: obs.iconicTaxon,
        color: obs.color,
        photoUrl: obs.photoUrl,
        taxonUrl: obs.taxonId
          ? `https://www.inaturalist.org/taxa/${obs.taxonId}`
          : null,
        count: 0,
        observations: [],
      });
    }
    const g = groups.get(key);
    g.count += 1;
    if (!g.photoUrl && obs.photoUrl) g.photoUrl = obs.photoUrl;
    g.observations.push(obs);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Run the full pipeline: route -> circles -> observations -> filter -> group.
//
// opts.filterStrategy:
//   'server' (default) — iNat filters unseen species server-side via
//     unobserved_by_user_id. Fewest requests + smallest payloads for power users.
//   'local' — fetch the user's species_counts once and filter locally. Kept for
//     A/B benchmarking against 'server'.
async function scanRoute({ routeUrl, username }, opts) {
  const t0 = Date.now();
  const { waypoints } = parseRouteUrl(routeUrl);
  const polyline = await fetchRoutePolyline(waypoints, opts.googleApiKey);
  const directionsMs = Date.now() - t0;
  return scanPolyline({ polyline, waypoints, username, directionsMs }, opts);
}

// Core pipeline over an already-resolved polyline. Separated from scanRoute so
// benchmarks can drive it with a synthetic polyline (no Google key required),
// since iNaturalist — not Directions — is the performance bottleneck.
async function scanPolyline({ polyline, waypoints = [], username, directionsMs = 0 }, opts) {
  const queryRadiusKm = opts.queryRadiusKm;
  const ttlMs = opts.cacheTtlMs;
  const filterStrategy = opts.filterStrategy || 'server';
  const maxRequests = opts.maxRequests || DEFAULT_MAX_REQUESTS;

  const t0 = Date.now();
  resetMetrics();

  const cacheKey = `${username.toLowerCase()}::${polyline.length}::${JSON.stringify(polyline[0])}::${JSON.stringify(polyline[polyline.length - 1])}::r${queryRadiusKm}::${filterStrategy}`;
  if (ttlMs) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  // Validate the username up front so an unknown user fails with a clear message
  // instead of a 422 on every circle.
  if (!(await userExists(username))) {
    throw new Error(`iNaturalist user "${username}" was not found.`);
  }

  const centers = buildCircleCenters(
    polyline,
    queryRadiusKm * 1000,
    BUFFER_METERS
  );

  // Server strategy filters unseen species at the API; nothing to prefetch.
  const circleOpts = filterStrategy === 'server' ? { unobservedByUserId: username } : {};

  // Query circles with bounded concurrency (deduping by id, honoring the budget).
  // Pages within one circle stay serial (each needs the previous id_above), but
  // different circles run in parallel so their latency overlaps under the shared
  // rate limiter. This is the biggest wall-clock win — see PERFORMANCE.md.
  const concurrency = Math.max(1, opts.concurrency || 4);
  const rawById = new Map();
  let requestsSpent = 0;
  let circlesQueried = 0;
  let nextIdx = 0;

  async function worker() {
    while (true) {
      if (requestsSpent >= maxRequests) return; // budget exhausted
      const i = nextIdx++;
      if (i >= centers.length) return;
      const c = centers[i];
      const { results, requests } = await fetchObservationsInCircle(
        c.lat,
        c.lng,
        queryRadiusKm,
        circleOpts
      );
      requestsSpent += requests;
      circlesQueried += 1;
      for (const obs of results) {
        if (!rawById.has(obs.id)) rawById.set(obs.id, obs);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, centers.length) }, () => worker())
  );
  const truncated = circlesQueried < centers.length;
  const tCircles = Date.now();

  // Normalize + keep only observations truly inside the 1-mile buffer.
  const inBuffer = [];
  for (const obs of rawById.values()) {
    const norm = normalizeObservation(obs, polyline);
    if (norm && norm._distanceToRoute <= BUFFER_METERS) {
      inBuffer.push(norm);
    }
  }

  // Filter to species the user has never observed.
  let unseen = inBuffer;
  if (filterStrategy === 'local') {
    const { ids: observedTaxa } = await fetchObservedTaxonIds(username);
    unseen = inBuffer.filter(
      (obs) => obs.taxonId == null || !observedTaxa.has(obs.taxonId)
    );
  }
  const tFilter = Date.now();

  const species = groupBySpecies(unseen);

  const result = {
    waypoints,
    polyline,
    circleCount: centers.length,
    totalInBuffer: inBuffer.length,
    unseenCount: unseen.length,
    speciesCount: species.length,
    species,
    truncated,
    cached: false,
    meta: {
      filterStrategy,
      queryRadiusKm,
      circleCount: centers.length,
      circlesQueried,
      requests: requestsSpent,
      requestBudget: maxRequests,
      rawObservations: rawById.size,
      inat: getMetrics(),
      timingsMs: {
        directions: directionsMs,
        circles: tCircles - t0,
        filter: tFilter - tCircles,
        total: directionsMs + (Date.now() - t0),
      },
    },
  };
  if (ttlMs) cache.set(cacheKey, result, ttlMs);
  return result;
}

module.exports = { scanRoute, scanPolyline };
