'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BUFFER_METERS,
  haversineMeters,
  distanceToPolylineMeters,
  isWithinBuffer,
  buildCircleCenters,
} = require('../server/geometry');

test('BUFFER_METERS is one mile', () => {
  assert.ok(Math.abs(BUFFER_METERS - 1609.344) < 0.001);
});

test('haversineMeters ~ 111 km per degree of latitude', () => {
  const d = haversineMeters([42, -76], [43, -76]);
  assert.ok(d > 110000 && d < 112000, `got ${d}`);
});

test('distanceToPolylineMeters is ~0 on the line and large off it', () => {
  const line = [[42, -76], [42, -75]];
  assert.ok(distanceToPolylineMeters([42, -75.5], line) < 1);
  assert.ok(distanceToPolylineMeters([43, -75.5], line) > 100000);
});

test('isWithinBuffer respects the 1-mile band', () => {
  const line = [[42, -76], [42, -75]];
  // ~0.005 deg lat north of the line ≈ 555 m — inside 1 mile.
  assert.equal(isWithinBuffer([42.005, -75.5], line), true);
  // ~0.02 deg lat ≈ 2.2 km — outside 1 mile.
  assert.equal(isWithinBuffer([42.02, -75.5], line), false);
});

test('buildCircleCenters covers a long route and rejects a too-small radius', () => {
  const line = [[42, -76], [42, -75]]; // ~82 km
  const centers = buildCircleCenters(line, 5000, BUFFER_METERS);
  assert.ok(centers.length > 5, `expected several circles, got ${centers.length}`);
  for (const c of centers) {
    assert.equal(typeof c.lat, 'number');
    assert.equal(typeof c.lng, 'number');
  }
  assert.throws(() => buildCircleCenters(line, BUFFER_METERS, BUFFER_METERS));
});
