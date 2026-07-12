'use strict';

// Keep the rate limiter and retry backoff instant so the suite runs fast. Must be
// set BEFORE requiring the iNat client (it reads these at module load).
process.env.INAT_MIN_INTERVAL_MS = process.env.INAT_MIN_INTERVAL_MS || '0';
process.env.INAT_BACKOFF_BASE_MS = process.env.INAT_BACKOFF_BASE_MS || '1';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { scanPolyline, groupBySpecies, colorForIconicTaxon } = require('../server/pipeline');
const { makeInatFetch, makeObservation, straightPolyline } = require('./helpers/inat-mock');

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

// Common scan options: no cache, single-threaded for deterministic ordering.
function opts(extra = {}) {
  return { queryRadiusKm: 5, cacheTtlMs: 0, concurrency: 1, ...extra };
}

const ROUTE = straightPolyline(42.0, -76.0, 40); // ~40 km -> several circles
const ON_ROUTE = [42.0, -76.0]; // first vertex, distance 0 from the route

// ---------------------------------------------------------------------------
// Pure grouping / sorting
// ---------------------------------------------------------------------------

test('colorForIconicTaxon maps groups to pin colors', () => {
  assert.equal(colorForIconicTaxon('Plantae'), 'green');
  assert.equal(colorForIconicTaxon('Aves'), 'blue');
  assert.equal(colorForIconicTaxon('Mammalia'), 'blue');
  assert.equal(colorForIconicTaxon('Insecta'), 'red');
});

test('groupBySpecies sorts globally-rarest first, unknown counts last', () => {
  const norm = (id, globalObsCount) => ({
    id,
    taxonId: id,
    scientificName: `sp${id}`,
    displayName: `sp${id}`,
    globalObsCount,
    color: 'green',
    photoUrl: null,
  });
  const groups = groupBySpecies([norm(1, 500), norm(2, 10), norm(3, null), norm(4, 90)]);
  assert.deepEqual(
    groups.map((g) => g.taxonId),
    [2, 4, 1, 3], // 10, 90, 500, then unknown
  );
});

// ---------------------------------------------------------------------------
// Full pipeline over a mocked iNaturalist
// ---------------------------------------------------------------------------

test('scan groups in-buffer species and sorts rarest-first', async () => {
  const observations = [
    makeObservation(1, ...ON_ROUTE, { name: 'Common Plant', globalCount: 9000, iconic: 'Plantae' }),
    makeObservation(2, ...ON_ROUTE, { name: 'Rare Plant', globalCount: 12, iconic: 'Plantae' }),
    makeObservation(3, ...ON_ROUTE, { name: 'A Bird', globalCount: 300, iconic: 'Aves' }),
  ];
  const { fakeFetch } = makeInatFetch({ observations });
  global.fetch = fakeFetch;

  const res = await scanPolyline({ polyline: ROUTE, username: 'tester' }, opts());

  assert.equal(res.speciesCount, 3);
  assert.equal(res.partial, false);
  assert.equal(res.truncated, false);
  // Rarest (globalCount 12) first, commonest (9000) last.
  assert.deepEqual(res.species.map((s) => s.scientificName), ['Rare Plant', 'A Bird', 'Common Plant']);
});

test('scan excludes observations outside the 1-mile buffer', async () => {
  const observations = [
    makeObservation(1, ...ON_ROUTE, { name: 'In Range' }),
    makeObservation(2, 43.0, -76.0, { name: 'Far Away' }), // ~111 km off-route
  ];
  const { fakeFetch } = makeInatFetch({ observations });
  global.fetch = fakeFetch;

  const res = await scanPolyline({ polyline: ROUTE, username: 'tester' }, opts());
  assert.equal(res.speciesCount, 1);
  assert.equal(res.species[0].scientificName, 'In Range');
});

test('scan assigns pin colors so plants=green and verts=blue can be filtered', async () => {
  const observations = [
    makeObservation(1, ...ON_ROUTE, { name: 'Plant', iconic: 'Plantae' }),
    makeObservation(2, ...ON_ROUTE, { name: 'Bird', iconic: 'Aves' }),
    makeObservation(3, ...ON_ROUTE, { name: 'Fish', iconic: 'Actinopterygii' }),
    makeObservation(4, ...ON_ROUTE, { name: 'Bug', iconic: 'Insecta' }),
  ];
  const { fakeFetch } = makeInatFetch({ observations });
  global.fetch = fakeFetch;

  const res = await scanPolyline({ polyline: ROUTE, username: 'tester' }, opts());
  const greens = res.species.filter((s) => s.color === 'green').map((s) => s.scientificName);
  const blues = res.species.filter((s) => s.color === 'blue').map((s) => s.scientificName);
  assert.deepEqual(greens, ['Plant']);
  assert.deepEqual(blues.sort(), ['Bird', 'Fish']);
});

test('scan requests only public records (geoprivacy=open) at species rank', async () => {
  const { fakeFetch, calls } = makeInatFetch({ observations: [] });
  global.fetch = fakeFetch;
  await scanPolyline({ polyline: ROUTE, username: 'tester' }, opts());

  const obsUrl = calls.urls.find((u) => u.includes('/observations') && !u.includes('species_counts'));
  assert.ok(obsUrl, 'expected an observations request');
  assert.match(obsUrl, /geoprivacy=open/);
  assert.match(obsUrl, /taxon_geoprivacy=open/);
  assert.match(obsUrl, /hrank=species/);
  assert.match(obsUrl, /lrank=species/);
});

test('unknown iNaturalist user fails fast with a clear message', async () => {
  const { fakeFetch } = makeInatFetch({ userFound: false });
  global.fetch = fakeFetch;
  await assert.rejects(
    scanPolyline({ polyline: ROUTE, username: 'nobody' }, opts()),
    /was not found/,
  );
});

// ---------------------------------------------------------------------------
// Long / dense route resilience — the "failed to fetch" scenarios
// ---------------------------------------------------------------------------

test('a mid-scan 429 returns PARTIAL results instead of throwing', async () => {
  const observations = [makeObservation(1, ...ON_ROUTE, { name: 'Seen Before Limit' })];
  // Succeed for the first 2 circles, then every request 429s.
  const { fakeFetch } = makeInatFetch({ observations, failObservationsAfter: 2 });
  global.fetch = fakeFetch;

  const res = await scanPolyline({ polyline: ROUTE, username: 'tester' }, opts());

  assert.equal(res.partial, true, 'scan should be flagged partial');
  assert.ok(/429/.test(res.partialReason || ''), `reason was: ${res.partialReason}`);
  assert.ok(res.meta.circlesQueried >= 1, 'at least one circle completed');
  assert.ok(res.meta.circlesQueried < res.circleCount, 'did not finish every circle');
  assert.equal(res.speciesCount, 1, 'still surfaces what was gathered before the limit');
});

test('a transient network error is retried, not surfaced as a failure', async () => {
  const observations = [makeObservation(1, ...ON_ROUTE, { name: 'Recovered' })];
  const { fakeFetch } = makeInatFetch({ observations, throwOnceForObservations: true });
  global.fetch = fakeFetch;

  const res = await scanPolyline({ polyline: ROUTE, username: 'tester' }, opts());
  assert.equal(res.partial, false, 'retry should recover, no partial flag');
  assert.equal(res.speciesCount, 1);
});

test('a long route places many circles and completes', async () => {
  const longRoute = straightPolyline(42.0, -76.0, 160, 40); // ~160 km
  const observations = [makeObservation(1, ...ON_ROUTE, { name: 'Anywhere' })];
  const { fakeFetch, calls } = makeInatFetch({ observations });
  global.fetch = fakeFetch;

  const res = await scanPolyline({ polyline: longRoute, username: 'tester' }, opts());
  assert.ok(res.circleCount > 10, `expected many circles, got ${res.circleCount}`);
  assert.equal(res.meta.circlesQueried, res.circleCount, 'all circles queried');
  assert.equal(calls.observations, res.circleCount, 'one page fetched per circle');
  assert.equal(res.partial, false);
});
