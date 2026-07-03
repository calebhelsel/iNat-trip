# Project Brief: Route Naturalist

A web tool for iNaturalist power users to scan a driving route for species they haven't yet observed, and build a modified route that detours to those observations.

## Architecture
- **Backend proxy** (Node + Express, or equivalent). Holds the Google Maps API key; proxies all Google and iNaturalist calls to avoid CORS and key exposure. Owns the buffer/dedup/filter logic.
- **Static frontend** (single page) that talks only to the backend. Uses the Google Maps JS SDK for display.

## Inputs
Two text fields: (1) a Google Maps route URL, (2) an iNaturalist username. Buffer distance is **fixed at 1 mile** (no UI control).

## Pipeline

### 1. Parse route → coordinates
Extract the ordered waypoint coordinates from the `/maps/dir/...` URL path. Call the Google **Directions API** with those waypoints to get the road-following polyline for the full route. Decode it to an ordered coordinate list.

### 2. Build query circles over the 1-mile buffer
The iNat `GET /observations` endpoint takes `lat`, `lng`, `radius` (a circle). The buffer around the route is a union of 1-mile circles, so cover it by placing query circles along the polyline. Space circle centers so consecutive circles overlap enough to leave no gaps along straight runs (≈ √2 · radius when radius = the buffer); sample more densely through curves. Goal: minimize query count while fully covering the buffer. See step 3 for using **larger** query circles to cut request count.

### 3. Query observations (rate-limit-aware)
For each circle: `GET /observations?lat=&lng=&radius=<km>&place_id=any`, paginating as needed. **Dedup by observation id** so each observation counts once.

**Stay within iNaturalist's limits** (max ~100 requests/minute, target ~60/min, hard ceiling ~10,000/day):

- **Global rate limiter.** Route every iNat call through a single backend queue (token-bucket or `p-limit` with a ~1s minimum interval). Because all traffic goes through the proxy, one global limiter covers all users.
- **Fewer, larger circles.** `radius` is not limited to the 1-mile buffer. Query with a radius *larger* than the buffer to cover a long stretch of route per call, then discard observations outside the true 1-mile buffer during the dedup/geometry step. Fewer, bigger circles = far fewer requests, at the cost of pulling some observations you'll throw away. Tune the tradeoff.
- **Max page size.** Use `per_page=200` (the API cap) so each circle needs fewer pages.
- **Two-phase fetch.** Optionally query with `only_id=true` first to learn which observations exist, then batch-fetch full records for the survivors via `id=1,2,3,...` (up to 200 ids per call) — turns N detail requests into N/200.
- **Skip redundant circles.** Omit circles whose coverage is already contained in neighbors on straight segments.
- **Handle 429s gracefully.** Respect `Retry-After` and back off exponentially rather than retrying immediately.
- **Descriptive `User-Agent`.** Send a `User-Agent` header identifying the app and a contact. Registering an OAuth app gives more headroom and clearer identification.

The biggest lever is **larger query circles + `per_page=200`**, which can cut request count by an order of magnitude versus many small 1-mile circles.

### 4. Filter to species the user has never observed
Fetch the user's observed taxa **once** via `GET /observations/species_counts?user_id=<username>` (paginate fully). Build a set of taxon ids, then drop any buffer observation whose species is in that set. Do **not** query per-species — one bulk fetch + local filter.

### 5. Sort
Group remaining observations by species; sort species by descending observation count within the buffer.

## Display

### Map (main area, most of the screen)
Google Maps hybrid view with an observation pin per observation:
- Plants (`iconic_taxon_name = Plantae`) → **green**
- Vertebrates (`Aves`, `Amphibia`, `Reptilia`, `Mammalia`, `Actinopterygii`) → **blue**
- Everything else → **red**

Supports cursor zoom/scroll. Clicking a pin opens a white speech-bubble card:
1. Square thumbnail of the observation photo (none if sound); clicking the thumbnail links to the iNat observation page.
2. Species name.
3. Observation date.
4. Green "Research Grade" badge, shown only if `quality_grade = research`.
5. "Add to route" button (see Route Builder).
6. "×" close control, top-right.

### Sidebar (right of map)
One horizontal banner per species:
1. Checkbox at far left, **all checked by default**. Filtering applies on **explicit page reload** — toggling a box does not update the map until the page is reloaded. Persist checkbox state across the reload.
2. Small species photo icon.
3. Species name, linked to its iNat taxon page (e.g. `https://www.inaturalist.org/taxa/69940-Hemiargus-ceraunus`).
4. Count of that species' observations within the buffer.

### Route Builder (below map + sidebar)
Bullet list of observations added via "Add to route", updating in real time. Each entry: species name, date, link to the observation, and a red trash icon to remove it.

### Create new route button (below the list)
Large blue button. Builds a new Google Maps directions URL containing all original route points **plus** every Route Builder observation's coordinates inserted between start and end in **selection order** (the order they were added). Opens the URL in a new window.

> ⚠️ Google Maps `dir/` URLs practically cap at ~10 waypoints — if the list exceeds this, warn the user (or split) rather than silently producing a broken URL.

## Config & operational notes
- **API keys**: Google Maps API key via env var; enable the Directions API + Maps JS API.
- **Caching**: cache route→observations results (keyed by route polyline + username) so the checkbox-driven page reload doesn't re-run every query. Short TTL (hours) is fine — observations change slowly.
