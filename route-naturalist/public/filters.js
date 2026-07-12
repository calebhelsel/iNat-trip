'use strict';

// Pure, framework-free helpers for the sidebar/map filtering logic. Kept separate
// from app.js (which touches the DOM, Google Maps, and localStorage) so the rules
// can be unit-tested in Node. Exposed as window.RouteNatFilters in the browser and
// as module.exports under Node.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RouteNatFilters = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // A species is "on" only when explicitly checked. Species default to OFF, so an
  // absent/false entry means hidden.
  function isSpeciesVisible(checkedState, key) {
    return checkedState[key] === true;
  }

  // Which species rows the sidebar should show given the active color filter.
  //   viewFilter: null (all) | 'green' (plants) | 'blue' (vertebrates)
  function visibleSpecies(species, viewFilter) {
    if (!viewFilter) return species.slice();
    return species.filter((sp) => sp.color === viewFilter);
  }

  // The checkedState produced by clicking a color button: only that color's
  // species are selected. Merges over `base` so unrelated keys are preserved.
  function selectionForColor(species, color, base) {
    const next = Object.assign({}, base || {});
    for (const sp of species) next[sp.key] = sp.color === color;
    return next;
  }

  // Set every species to the same checked value (Select all / Deselect all).
  function selectionForAll(species, value, base) {
    const next = Object.assign({}, base || {});
    for (const sp of species) next[sp.key] = value;
    return next;
  }

  // Is at least one species currently checked?
  function anyChecked(species, checkedState) {
    return species.some((sp) => checkedState[sp.key] === true);
  }

  return {
    isSpeciesVisible,
    visibleSpecies,
    selectionForColor,
    selectionForAll,
    anyChecked,
  };
});
