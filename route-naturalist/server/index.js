'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const { scanRoute } = require('./pipeline');

const app = express();
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT) || 5050;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const QUERY_RADIUS_KM = Number(process.env.QUERY_RADIUS_KM) || 5;
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_MINUTES) || 180) * 60 * 1000;
const FILTER_STRATEGY = process.env.FILTER_STRATEGY || 'server';
const MAX_REQUESTS_PER_SCAN = Number(process.env.MAX_REQUESTS_PER_SCAN) || 400;
const INAT_CONCURRENCY = Number(process.env.INAT_CONCURRENCY) || 4;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Serve index.html with the Maps JS key injected. The Maps JS SDK key is
// necessarily public in the browser, so restrict it by HTTP referrer.
function serveIndex(req, res) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  res.type('html').send(html.replace(/__GOOGLE_MAPS_API_KEY__/g, GOOGLE_MAPS_API_KEY));
}

app.get('/', serveIndex);
app.get('/index.html', serveIndex);

// Static assets (app.js, styles.css) — index.html is handled above.
app.use(express.static(PUBLIC_DIR, { index: false }));

app.post('/api/scan', async (req, res) => {
  const routeUrl = (req.body && req.body.routeUrl ? String(req.body.routeUrl) : '').trim();
  const username = (req.body && req.body.username ? String(req.body.username) : '').trim();

  if (!routeUrl || !username) {
    return res.status(400).json({ error: 'Both a route URL and an iNaturalist username are required.' });
  }
  if (!GOOGLE_MAPS_API_KEY) {
    return res.status(500).json({ error: 'Server is missing GOOGLE_MAPS_API_KEY.' });
  }

  try {
    const result = await scanRoute(
      { routeUrl, username },
      {
        googleApiKey: GOOGLE_MAPS_API_KEY,
        queryRadiusKm: QUERY_RADIUS_KM,
        cacheTtlMs: CACHE_TTL_MS,
        filterStrategy: FILTER_STRATEGY,
        maxRequests: MAX_REQUESTS_PER_SCAN,
        concurrency: INAT_CONCURRENCY,
      }
    );
    res.json(result);
  } catch (err) {
    console.error('scan failed:', err);
    res.status(400).json({ error: err.message || 'Scan failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`RouteNat running at http://localhost:${PORT}`);
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn('WARNING: GOOGLE_MAPS_API_KEY is not set — scans and the map will fail.');
  }
});
