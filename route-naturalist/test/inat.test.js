'use strict';

process.env.INAT_MIN_INTERVAL_MS = process.env.INAT_MIN_INTERVAL_MS || '0';
process.env.INAT_BACKOFF_BASE_MS = process.env.INAT_BACKOFF_BASE_MS || '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { trimObservation } = require('../server/inat');

// A raw iNaturalist observation carries far more than the app uses. trimObservation
// must keep the fields normalizeObservation() reads and drop the rest so thousands
// of records don't OOM a small instance.
test('trimObservation keeps only the fields we use and drops bloat', () => {
  const raw = {
    id: 42,
    location: '42.1,-76.2',
    observed_on: '2024-05-01',
    time_observed_at: '2024-05-01T12:00:00',
    quality_grade: 'research',
    photos: [{ url: 'https://x/square.jpg', id: 9, attribution: '...' }],
    // bloat that must not be retained:
    identifications: new Array(30).fill({ big: 'payload' }),
    ofvs: [{ a: 1 }],
    comments: ['lots', 'of', 'text'],
    taxon: {
      id: 7,
      name: 'Species x',
      preferred_common_name: 'Common X',
      iconic_taxon_name: 'Aves',
      observations_count: 123,
      ancestry: '48460/1/2/3/4/5/6',
      ancestor_ids: [48460, 1, 2, 3, 4, 5, 6],
    },
  };

  const trimmed = trimObservation(raw);

  // kept
  assert.equal(trimmed.id, 42);
  assert.equal(trimmed.location, '42.1,-76.2');
  assert.equal(trimmed.quality_grade, 'research');
  assert.equal(trimmed.taxon.observations_count, 123);
  assert.equal(trimmed.taxon.iconic_taxon_name, 'Aves');
  assert.equal(trimmed.photos[0].url, 'https://x/square.jpg');

  // dropped
  assert.equal(trimmed.identifications, undefined);
  assert.equal(trimmed.ofvs, undefined);
  assert.equal(trimmed.comments, undefined);
  assert.equal(trimmed.taxon.ancestry, undefined);
  assert.equal(trimmed.taxon.ancestor_ids, undefined);
  assert.equal(trimmed.photos[0].attribution, undefined);
});

test('trimObservation tolerates a missing taxon/photos', () => {
  const trimmed = trimObservation({ id: 1, location: '0,0' });
  assert.deepEqual(trimmed.photos, []);
  assert.equal(trimmed.taxon.id, undefined);
});
