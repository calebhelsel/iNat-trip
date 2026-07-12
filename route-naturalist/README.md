# RouteNat

Scan a driving route for iNaturalist species you've **never observed**, then build a
detour route to reach them. A Node/Express proxy holds the Google Maps key and owns the
buffer/dedup/filter logic; a static single page displays results on a Google Map.

## How it works

1. **Parse the route.** Waypoints are pulled from a Google Maps `…/maps/dir/…` URL and
   sent to the **Directions API**, whose road-following polyline is decoded to coordinates.
2. **Cover a 1-mile buffer.** Query circles (radius `QUERY_RADIUS_KM`, larger than the
   buffer to cut request count) are spaced along the polyline so consecutive circles fully
   cover the 1-mile band.
3. **Query iNaturalist** for each circle (`per_page=200`, paginated), deduping by
   observation id. Only **public, precise-location** records are fetched
   (`geoprivacy=open&taxon_geoprivacy=open`) — obscured coordinates are randomized
   and would map inaccurately. All calls go through one **global rate limiter**
   (≥1s spacing, 429 backoff) with a descriptive `User-Agent`. If iNaturalist errors
   out mid-scan (e.g. a sustained 429 on a huge/dense route), the scan **stops and
   returns the observations gathered so far** rather than failing outright.
4. **Filter geometrically** to observations truly within 1 mile of the route, then **filter
   to unseen species** using a single `species_counts` fetch for the user (local set filter).
5. **Group by species**, sorted by descending count in the buffer.

Results are cached (keyed by route polyline + username) so the checkbox-driven reload is fast.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env
npm start                 # http://localhost:5050
```

Required env (see `.env.example`):

- `GOOGLE_MAPS_API_KEY` — enable **Directions API** *and* **Maps JavaScript API** on it.
  It is used server-side for Directions and injected into the page for the Maps JS SDK
  (which is necessarily public), so **restrict it by HTTP referrer** in Google Cloud.
- `INAT_CONTACT` — contact email/URL sent in the iNaturalist `User-Agent` header.

Optional: `PORT`, `QUERY_RADIUS_KM` (default 5), `CACHE_TTL_MINUTES` (default 180),
`FILTER_STRATEGY` (`server`/`local`), `INAT_CONCURRENCY` (default 4),
`MAX_REQUESTS_PER_SCAN` (default 400). See **[PERFORMANCE.md](PERFORMANCE.md)** for
the bottleneck analysis, the `scripts/benchmark.js` harness, and tuning guidance.

## Using it

Paste a Google Maps directions URL and an iNaturalist username, then **Scan route**.

- **Map** (hybrid): a pin per observation — plants green, vertebrates blue, everything else
  red. Click a pin for a card with photo, species, date, a "Research Grade" badge, and
  **Add to route**.
- **Sidebar**: one row per species (photo, linked name, local count, and the species'
  **total observation count on iNaturalist**). Species are sorted so the globally
  **rarest** (fewest total iNat observations) appear first. Species start
  **deselected** (the map opens empty); reveal them with the checkboxes or the header
  buttons — **Select all / Deselect all**, **Plants** (filters the sidebar to green/plant
  species and shows only their pins), and **Verts** (blue/vertebrate species). Click an
  active **Plants**/**Verts** button again to clear the filter. Every control updates the
  map **live** — no page reload. Selections persist across reloads (the saved scan
  re-runs from cache).
- **Route builder**: added observations, in selection order, each removable. **Create new
  route** opens a Google Maps directions URL with your original stops plus the added
  observations. Google Maps caps `dir/` URLs around ~10 stops; the app warns past that.

## Performance

Long/dense routes are heavy because a scan pages through every observation the
circles sweep (200/request). Measurement showed the bottleneck is **iNaturalist
response latency, not the rate limiter**, so the app now runs circle queries
**concurrently** (`INAT_CONCURRENCY`) while still capping the rate ~60/min, filters
unseen species **server-side** (`unobserved_by_user_id`), retries transient network
errors, and enforces a **per-scan request budget** (returning partial results with a
warning rather than hanging). In dense areas, *smaller* `QUERY_RADIUS_KM` usually
helps (less over-pull past the 1-mile buffer). Full analysis, the benchmark harness,
and tuning guidance are in **[PERFORMANCE.md](PERFORMANCE.md)**.

## Testing

```bash
npm test
```

Uses Node's built-in test runner (no extra dependencies), so adding a case is just
another `test('...', () => { ... })`. The suite lives in `test/`:

- `test/geometry.test.js` — buffer math and circle placement.
- `test/filters.test.js` — the sidebar/map filter rules (including that **Plants**
  shows only green species and **Verts** only blue).
- `test/pipeline.test.js` — the full scan over a **mocked** iNaturalist
  (`test/helpers/inat-mock.js`): grouping, rarest-first sort, buffer/color filtering,
  public-only query params, and the long-route resilience paths — a **mid-scan 429
  returns partial results** and a **transient network error is retried** (the two
  causes of "failed to fetch").
- `test/ratelimit.test.js` — the per-IP scan limiter.

The mock fakes `global.fetch`, so tests are offline and deterministic; they set
`INAT_MIN_INTERVAL_MS=0` / `INAT_BACKOFF_BASE_MS=1` so the limiter/backoff don't
sleep.

## Deploy (Render)

A [`render.yaml`](render.yaml) blueprint is included. In Render: **New → Blueprint**,
point it at this repo, then set the two secrets (`GOOGLE_MAPS_API_KEY`,
`INAT_CONTACT`) in the dashboard — they are marked `sync: false` so they are never
committed. Render injects `PORT` automatically and terminates TLS. `buildCommand` is
`npm install`, `startCommand` is `npm start`.

**Before sharing the public URL, read [SECURITY.md](SECURITY.md).** The most
important step: the Maps JS key is public in the browser, so **restrict it by HTTP
referrer** to your Render domain, limit it to the Maps JavaScript + Directions APIs,
and set a Google Cloud **budget alert**. The public `/api/scan` endpoint is protected
by a per-IP rate limit (`SCAN_RATE_MAX` / `SCAN_RATE_WINDOW_MIN`).
