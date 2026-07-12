'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Filters = require('../public/filters');

// A tiny species set: two plants (green), one vertebrate (blue), one "other" (red).
function sampleSpecies() {
  return [
    { key: 'a', color: 'green' },
    { key: 'b', color: 'blue' },
    { key: 'c', color: 'green' },
    { key: 'd', color: 'red' },
  ];
}

test('visibleSpecies: no filter shows every species', () => {
  const species = sampleSpecies();
  assert.deepEqual(
    Filters.visibleSpecies(species, null).map((s) => s.key),
    ['a', 'b', 'c', 'd']
  );
});

test('visibleSpecies: Plants filter shows only green species', () => {
  const rows = Filters.visibleSpecies(sampleSpecies(), 'green');
  assert.deepEqual(rows.map((s) => s.key), ['a', 'c']);
  assert.ok(rows.every((s) => s.color === 'green'));
});

test('visibleSpecies: Verts filter shows only blue species', () => {
  const rows = Filters.visibleSpecies(sampleSpecies(), 'blue');
  assert.deepEqual(rows.map((s) => s.key), ['b']);
  assert.ok(rows.every((s) => s.color === 'blue'));
});

test('selectionForColor: only the chosen color is checked', () => {
  const state = Filters.selectionForColor(sampleSpecies(), 'green', {});
  assert.deepEqual(state, { a: true, b: false, c: true, d: false });
});

test('selectionForColor merges over a base without dropping unrelated keys', () => {
  const state = Filters.selectionForColor(sampleSpecies(), 'blue', { zzz: true });
  assert.equal(state.zzz, true);
  assert.equal(state.b, true);
  assert.equal(state.a, false);
});

test('selectionForAll flips every species together', () => {
  const on = Filters.selectionForAll(sampleSpecies(), true, {});
  assert.ok(Object.values(on).every((v) => v === true));
  const off = Filters.selectionForAll(sampleSpecies(), false, {});
  assert.ok(Object.values(off).every((v) => v === false));
});

test('species default to hidden; anyChecked / isSpeciesVisible use strict true', () => {
  const species = sampleSpecies();
  assert.equal(Filters.anyChecked(species, {}), false); // empty = all off
  assert.equal(Filters.isSpeciesVisible({}, 'a'), false);
  assert.equal(Filters.isSpeciesVisible({ a: true }, 'a'), true);
  assert.equal(Filters.anyChecked(species, { a: true }), true);
});
