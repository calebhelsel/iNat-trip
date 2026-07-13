'use strict';

// A fake `global.fetch` that mimics the iNaturalist endpoints the app calls, so
// pipeline/inat behavior can be tested offline and deterministically. Supports
// fault injection (429s, transient network errors) to exercise the resilience
// paths behind "failed to fetch" on long/dense routes.

// Build one observation record shaped like the iNaturalist API response.
function makeObservation(id, lat, lng, opts = {}) {
  return {
    id,
    location: `${lat},${lng}`,
    observed_on: opts.date || '2024-05-01',
    quality_grade: opts.qualityGrade || 'research',
    photos: [{ url: 'https://static.inaturalist.org/photos/1/square.jpg' }],
    taxon: {
      id: opts.taxonId != null ? opts.taxonId : id,
      name: opts.name || `Species ${id}`,
      preferred_common_name: opts.commonName || null,
      iconic_taxon_name: opts.iconic || 'Plantae',
      // Global count across iNaturalist — drives the rarest-first sort.
      observations_count: opts.globalCount != null ? opts.globalCount : 1000,
    },
  };
}

function jsonResponse(body, { status = 200, retryAfter } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (h) =>
        h.toLowerCase() === 'retry-after' && retryAfter != null ? String(retryAfter) : null,
    },
    json: async () => body,
  };
}

// options:
//   observations           array returned (one page) for every circle query
//   userFound              whether /users/{login} resolves (default true)
//   speciesCounts          rows for the "local" strategy species_counts endpoint
//   failObservationsAfter  Nth successful obs request onward returns HTTP 429
//   throwOnceForObservations  first obs request rejects (network error), then OK
//
// Returns { fakeFetch, calls } where calls tracks counts and every requested URL.
function makeInatFetch(options = {}) {
  const {
    observations = [],
    userFound = true,
    speciesCounts = [],
    failObservationsAfter = Infinity,
    throwOnceForObservations = false,
    latencyMs = 0, // artificial per-observations-request delay (for time-budget tests)
  } = options;

  const calls = { users: 0, observations: 0, speciesCounts: 0, urls: [] };
  let threwOnce = false;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fakeFetch(url) {
    calls.urls.push(url);

    if (url.includes('/users/')) {
      calls.users += 1;
      return jsonResponse({ results: userFound ? [{ id: 1, login: 'tester' }] : [] });
    }

    if (url.includes('/observations/species_counts')) {
      calls.speciesCounts += 1;
      return jsonResponse({ results: speciesCounts, total_results: speciesCounts.length });
    }

    if (url.includes('/observations')) {
      if (throwOnceForObservations && !threwOnce) {
        threwOnce = true;
        throw new TypeError('fetch failed'); // simulate a transient network drop
      }
      if (latencyMs) await delay(latencyMs);
      calls.observations += 1;
      if (calls.observations > failObservationsAfter) {
        return jsonResponse({}, { status: 429, retryAfter: 0 });
      }
      return jsonResponse({ results: observations, total_results: observations.length });
    }

    return jsonResponse({}, { status: 404 });
  }

  return { fakeFetch, calls };
}

// A straight polyline of `points` vertices spanning ~`km` kilometers eastward
// from a start point — long enough to place several query circles.
function straightPolyline(startLat, startLng, km, points = 20) {
  const metersPerDegLng = 111320 * Math.cos((startLat * Math.PI) / 180);
  const totalDeg = (km * 1000) / metersPerDegLng;
  const line = [];
  for (let i = 0; i < points; i++) {
    line.push([startLat, startLng + (totalDeg * i) / (points - 1)]);
  }
  return line;
}

module.exports = { makeInatFetch, makeObservation, jsonResponse, straightPolyline };
