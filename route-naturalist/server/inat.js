'use strict';

// iNaturalist API client with a single global rate limiter.
// Because every user's traffic flows through this proxy, one shared limiter
// keeps the whole app under iNat's limits (~60/min target, 100/min ceiling).

const API_BASE = 'https://api.inaturalist.org/v1';
// >= 1s between call starts -> <= 60/min. Overridable so tests can disable the
// real 1s spacing (set INAT_MIN_INTERVAL_MS=0).
const MIN_INTERVAL_MS = Number.isFinite(Number(process.env.INAT_MIN_INTERVAL_MS))
  ? Number(process.env.INAT_MIN_INTERVAL_MS)
  : 1000;
// Base for exponential retry backoff. Overridable so tests don't sleep seconds.
const BACKOFF_BASE_MS = Number(process.env.INAT_BACKOFF_BASE_MS) || 1000;
const MAX_RETRIES = 4;
const PER_PAGE = 200; // API cap
const MAX_PAGES_PER_CIRCLE = 50; // hard stop so one dense circle can't run away

const CONTACT = process.env.INAT_CONTACT || 'unknown-contact';
const USER_AGENT = `RouteNat/1.0 (+${CONTACT})`;

// ---- Instrumentation ----
// Cumulative counters so callers/benchmarks can see where time and requests go.
const metrics = { requests: 0, retries: 0, retryWaitMs: 0, waitMs: 0 };
function getMetrics() {
  return { ...metrics };
}
function resetMetrics() {
  metrics.requests = 0;
  metrics.retries = 0;
  metrics.retryWaitMs = 0;
  metrics.waitMs = 0;
}

// Global rate limiter: space request *starts* at least MIN_INTERVAL_MS apart
// (caps the rate at ~60/min) but do NOT wait for each request to finish before
// starting the next. iNat's heavier queries take ~2s+ each, so serializing on
// completion left us running at ~24/min — far under budget. Decoupling lets
// several slow requests overlap, cutting wall-clock while staying under 60/min.
let nextSlotAt = 0;

function schedule(task) {
  const now = Date.now();
  const start = Math.max(now, nextSlotAt);
  nextSlotAt = start + MIN_INTERVAL_MS;
  const wait = start - now;
  if (wait > 0) {
    metrics.waitMs += wait;
    return sleep(wait).then(task);
  }
  return Promise.resolve().then(task);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One rate-limited GET returning parsed JSON, with 429/5xx backoff.
async function inatGet(path, params) {
  const query = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}?${query}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await schedule(() => {
        metrics.requests += 1;
        return fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
      });
    } catch (err) {
      // Transient network failure (ECONNRESET, DNS blip, socket close) — fetch
      // throws rather than returning a response. Back off and retry; these are a
      // common cause of "failed to fetch" on long scans.
      if (attempt === MAX_RETRIES) {
        throw new Error(`iNaturalist request failed after ${MAX_RETRIES} retries: ${err.message}`);
      }
      const backoff = Math.min(30000, BACKOFF_BASE_MS * 2 ** attempt);
      metrics.retries += 1;
      metrics.retryWaitMs += backoff;
      await sleep(backoff);
      continue;
    }

    if (resp.ok) {
      return resp.json();
    }

    if (resp.status === 429 || resp.status >= 500) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`iNaturalist API HTTP ${resp.status} after ${MAX_RETRIES} retries`);
      }
      const retryAfter = Number(resp.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30000, BACKOFF_BASE_MS * 2 ** attempt);
      metrics.retries += 1;
      metrics.retryWaitMs += backoff;
      await sleep(backoff);
      continue;
    }

    throw new Error(`iNaturalist API HTTP ${resp.status} for ${path}`);
  }
}

// Confirm an iNaturalist login exists (one cheap request). Without this, an
// unknown user makes unobserved_by_user_id return HTTP 422 on every circle.
async function userExists(username) {
  try {
    const data = await inatGet(`/users/${encodeURIComponent(username)}`, {});
    return !!(data.results && data.results.length);
  } catch {
    return false; // 404 (and anything else) -> treat as not found
  }
}

// Reduce a raw iNaturalist observation to only the fields the app uses. Raw
// records are large (full taxon ancestry, identifications, project links, faves,
// etc.); holding thousands of them OOMs a small instance. Trimming on arrival —
// before anything accumulates — cuts per-observation memory ~20-50x. The output
// keeps the same field names normalizeObservation() reads, so nothing downstream
// changes.
function trimObservation(o) {
  const t = o.taxon || {};
  const photo = o.photos && o.photos[0];
  return {
    id: o.id,
    location: o.location,
    observed_on: o.observed_on,
    time_observed_at: o.time_observed_at,
    quality_grade: o.quality_grade,
    taxon: {
      id: t.id,
      name: t.name,
      preferred_common_name: t.preferred_common_name,
      iconic_taxon_name: t.iconic_taxon_name,
      observations_count: t.observations_count,
    },
    photos: photo && photo.url ? [{ url: photo.url }] : [],
  };
}

// Fetch every species-level observation within a circle (lat, lng, radius km).
// Uses id-cursor pagination (id_above) rather than page offsets so it stays
// correct past iNat's 10k page-offset limit. `radiusKm` may exceed the buffer.
//
// opts.unobservedByUserId — when set, iNat filters server-side to taxa this user
//   has never observed. This is the single biggest request-count reducer for
//   power users, because most common species drop out before pagination.
//
// Only PUBLIC observations are returned: geoprivacy=open and taxon_geoprivacy=open
// exclude records whose coordinates are obscured (user-obscured or auto-obscured
// for threatened taxa). Obscured points are randomized ~0.2° anyway, so mapping
// them would be misleading.
//
// Returns { results, requests, error }. On a network/HTTP failure that survives
// all retries, `error` is set and whatever pages were already fetched are still
// returned — so a scan can surface partial results instead of failing outright.
async function fetchObservationsInCircle(lat, lng, radiusKm, opts = {}) {
  const results = [];
  let idAbove = 0;
  let requests = 0;
  let error = null;

  while (requests < MAX_PAGES_PER_CIRCLE) {
    const params = {
      lat,
      lng,
      radius: radiusKm,
      per_page: PER_PAGE,
      order: 'asc',
      order_by: 'id',
      id_above: idAbove,
      geo: 'true',
      // Only species-level records — drops genus/coarser identifications.
      hrank: 'species',
      lrank: 'species',
      // Public, precise-location records only (no obscured coordinates).
      geoprivacy: 'open',
      taxon_geoprivacy: 'open',
    };
    if (opts.unobservedByUserId) {
      params.unobserved_by_user_id = opts.unobservedByUserId;
    }

    let data;
    try {
      data = await inatGet('/observations', params);
    } catch (err) {
      // Bubble the failure up as data, not an exception, so the caller keeps the
      // pages we already have (e.g. a 429 on a long/dense route).
      error = err;
      break;
    }
    requests += 1;
    const raw = data.results || [];
    // Trim each page immediately so the full raw records become garbage right away
    // and never accumulate across pages/circles.
    for (const o of raw) results.push(trimObservation(o));
    if (raw.length < PER_PAGE) break;
    idAbove = raw[raw.length - 1].id;
  }
  return { results, requests, error };
}

// Fetch the set of taxon ids the user has ever observed, via species_counts
// (one bulk fetch, paginated). Only used by the "local" filter strategy;
// the default "server" strategy uses unobserved_by_user_id instead.
// Returns { ids, requests }.
async function fetchObservedTaxonIds(username) {
  const ids = new Set();
  let page = 1;
  let requests = 0;
  const MAX_PAGES = 100;

  while (page <= MAX_PAGES) {
    const data = await inatGet('/observations/species_counts', {
      user_id: username,
      per_page: 500,
      page,
    });
    requests += 1;
    const batch = data.results || [];
    for (const row of batch) {
      const taxonId = row.taxon && row.taxon.id;
      if (taxonId != null) ids.add(taxonId);
    }
    const total = data.total_results || 0;
    if (page * 500 >= total || batch.length === 0) break;
    page += 1;
  }
  return { ids, requests };
}

module.exports = {
  userExists,
  fetchObservationsInCircle,
  fetchObservedTaxonIds,
  getMetrics,
  resetMetrics,
  MAX_PAGES_PER_CIRCLE,
  // Exported for unit tests.
  trimObservation,
};
