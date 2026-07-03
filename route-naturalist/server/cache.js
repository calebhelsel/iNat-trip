'use strict';

// Tiny in-memory TTL cache. Keyed by route polyline + username so the
// checkbox-driven page reload doesn't re-run every iNat query.

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expires: Date.now() + ttlMs });
}

module.exports = { get, set };
