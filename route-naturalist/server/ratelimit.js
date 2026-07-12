'use strict';

// Minimal in-memory fixed-window rate limiter — no external dependencies. Guards
// the public /api/scan endpoint so a stranger with the URL can't drain the Google
// Directions quota (a "denial of wallet") or hammer iNaturalist through the proxy.
//
// Scope: this is per-process, which is correct for a single instance (Render free/
// starter). If you scale to multiple instances, move this state to Redis so the
// limit is shared.
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }

  function prune(now) {
    for (const [ip, rec] of hits) {
      if (now >= rec.resetAt) hits.delete(ip);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    // Opportunistically drop expired buckets so the map can't grow unbounded.
    if (hits.size > 5000) prune(now);

    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    let rec = hits.get(ip);
    if (!rec || now >= rec.resetAt) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count += 1;

    if (rec.count > max) {
      const retry = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many scans — try again in ${retry}s.` });
    }
    return next();
  };
}

module.exports = { createRateLimiter };
