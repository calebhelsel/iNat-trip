'use strict';

// Performance benchmark for the iNaturalist half of the pipeline (the actual
// bottleneck). Builds a synthetic polyline between two coordinates — no Google
// key needed — and runs scanPolyline across radius × strategy combinations,
// printing where time and requests go.
//
// Usage:
//   node scripts/benchmark.js --user=<inat_username> [options]
//
// Options:
//   --user=NAME        iNaturalist username to test the "unseen" filter against (required)
//   --scenario=NAME    one of: short | medium | long | dense   (default: short)
//   --radius=5,10      comma list of query-circle radii in km   (default: 5)
//   --strategy=server  comma list: server,local                 (default: server)
//   --budget=120       max iNat requests per run                (default: 120)
//
// Example:
//   node scripts/benchmark.js --user=me --scenario=medium --radius=3,5,10 --strategy=server,local

require('dotenv').config();

const { scanPolyline } = require('../server/pipeline');
const { haversineMeters } = require('../server/geometry');

// --- Scenarios: [startLat, startLng] -> [endLat, endLng].
// Chosen to span sparse (rural) to dense (metro) observation densities.
const SCENARIOS = {
  short: { name: 'short rural (~15 km)', from: [44.26, -72.58], to: [44.20, -72.75] }, // central Vermont
  medium: { name: 'medium (~45 km)', from: [42.44, -76.5], to: [42.1, -77.05] }, // Ithaca -> south
  long: { name: 'long (~120 km)', from: [42.44, -76.5], to: [43.16, -77.61] }, // Ithaca -> Rochester
  dense: { name: 'dense metro (~25 km)', from: [37.8, -122.45], to: [37.6, -122.4] }, // San Francisco peninsula
};

function parseArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

// Straight-line polyline between two points with vertices ~1 km apart, so
// buildCircleCenters produces a realistic number of circles.
function syntheticPolyline(from, to) {
  const total = haversineMeters(from, to);
  const steps = Math.max(2, Math.round(total / 1000));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return points;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  const args = parseArgs();
  const username = args.user;
  if (!username) {
    console.error('Error: --user=<inat_username> is required.');
    process.exit(1);
  }
  if (!process.env.INAT_CONTACT) {
    console.warn('Note: INAT_CONTACT is not set — set it to identify the app to iNaturalist.\n');
  }

  const scenario = SCENARIOS[args.scenario || 'short'];
  if (!scenario) {
    console.error(`Unknown scenario "${args.scenario}". Options: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const radii = (args.radius || '5').split(',').map(Number);
  const strategies = (args.strategy || 'server').split(',');
  const budget = Number(args.budget || 120);
  const concurrency = Number(args.concurrency || 4);

  const polyline = syntheticPolyline(scenario.from, scenario.to);

  console.log(`Scenario: ${scenario.name}  (${polyline.length} polyline vertices)`);
  console.log(`User: ${username}   Budget: ${budget} requests/run   Concurrency: ${concurrency}\n`);

  const cols = ['radiusKm', 'strategy', 'circles', 'queried', 'requests', 'rawObs', 'inBuf', 'unseen', 'species', 'waitS', 'totalS', 'trunc'];
  console.log(cols.map((c) => pad(c, 9)).join(''));
  console.log('-'.repeat(cols.length * 9));

  for (const radius of radii) {
    for (const strategy of strategies) {
      const res = await scanPolyline(
        { polyline, username },
        { queryRadiusKm: radius, filterStrategy: strategy, maxRequests: budget, concurrency, cacheTtlMs: 0 }
      );
      const m = res.meta;
      const row = [
        radius,
        strategy,
        m.circleCount,
        m.circlesQueried,
        m.requests,
        m.rawObservations,
        res.totalInBuffer,
        res.unseenCount,
        res.speciesCount,
        (m.inat.waitMs / 1000).toFixed(1),
        (m.timingsMs.total / 1000).toFixed(1),
        res.truncated ? 'YES' : '-',
      ];
      console.log(row.map((c) => pad(c, 9)).join(''));
    }
  }
  console.log('\nColumns: circles=placed, queried=actually run before budget, rawObs=deduped pulled,');
  console.log('inBuf=within 1mi, unseen=after species filter, waitS=time spent in the rate limiter.');
}

main().catch((e) => {
  console.error('Benchmark failed:', e.message);
  process.exit(1);
});
