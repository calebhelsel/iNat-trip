# RouteNat — security notes

RouteNat is a public, unauthenticated web app that proxies two third-party APIs
(Google Maps and iNaturalist) using **your** credentials and quota. That shape
drives the whole threat model: the main risks are about your **API key and your
billing**, not user data (the app stores nothing server-side and has no accounts).

Threats are ordered by real-world priority for a public launch.

## 1. Google Maps API key abuse — highest priority

The Maps JavaScript SDK key is, by necessity, **served to the browser** (it's in
the page HTML). Anyone can read it from view-source. The same key is also used
server-side for the Directions API. If it isn't locked down, a stranger can copy
it and run up your Google bill ("denial of wallet").

**Mitigations (do all of these in Google Cloud console before sharing the URL):**
- **HTTP referrer restriction** on the key → allow only your Render domain
  (e.g. `https://routenat.onrender.com/*`). This stops the browser key from
  working on other sites.
- **API restriction** → enable only *Maps JavaScript API* and *Directions API*.
- **Budget + alerts** → set a billing budget and quota caps so a leak is bounded.
- **Ideally split keys**: a referrer-restricted *browser* key for the Maps SDK and
  a separate, non-public, IP/quota-restricted *server* key for Directions. Today
  the app uses one key for both; splitting removes the "public key also bills
  Directions" overlap. (Would require passing two keys into `server/index.js`.)

## 2. Open proxy / quota abuse of `/api/scan`

`/api/scan` triggers Directions + many iNaturalist calls with no auth. Left open,
someone can script it to burn your Google quota and hammer iNaturalist through
your server (which could get your `User-Agent`/IP throttled or blocked by iNat).

**Mitigations (implemented):**
- **Per-IP rate limit** on `/api/scan` (`server/ratelimit.js`, default 20 scans /
  10 min; tune with `SCAN_RATE_MAX`, `SCAN_RATE_WINDOW_MIN`).
- **Per-scan request budget** (`MAX_REQUESTS_PER_SCAN`) caps work per request.
- **Global iNat rate limiter** keeps total outbound load under iNat's limits.
- **Result cache** so repeated identical scans don't re-spend quota.

**Still worth considering** if abuse appears: a lightweight shared secret / access
code for the form, Cloudflare/Render in front for bot filtering, or moving the
rate-limit state to Redis if you scale past one instance (the current limiter is
per-process).

## 3. Input handling (SSRF / injection)

- `routeUrl` is **not** fetched directly. `parseRouteUrl` only extracts waypoint
  strings from a Google `/maps/dir/` URL; those go to the Directions API as
  parameters, never as a server-side fetch target — so there's no SSRF surface
  from the URL itself.
- All user values sent to iNaturalist/Google go through `URLSearchParams`, which
  percent-encodes them (no query injection).
- The frontend escapes user/API strings via `escapeHtml` before inserting into the
  DOM, mitigating XSS from observation/species text.
- `express.json({ limit: '256kb' })` bounds request-body size.

**To tighten further:** validate `username` against iNaturalist's allowed
character set and cap its length before use; add a `Content-Security-Policy`
header (the Maps SDK needs `https://maps.googleapis.com` and
`https://*.gstatic.com` allowances).

## 4. Transport & headers

- Render terminates **TLS**, so traffic is HTTPS end to end — keep it; never post
  the form over plain HTTP.
- Consider adding **security headers** (HSTS is provided by Render; add
  `X-Content-Type-Options: nosniff`, a minimal CSP, and `Referrer-Policy`). These
  are easy wins via a small middleware (or the `helmet` package if you accept the
  dependency).

## 5. Secrets & supply chain

- **Secrets:** `GOOGLE_MAPS_API_KEY` and `INAT_CONTACT` live only in Render env
  vars and local `.env` (git-ignored). `render.yaml` marks the key `sync: false`
  so it is never committed. Confirm `.env` is not in git history before pushing.
- **Dependencies:** only `express` and `dotenv`. Run `npm audit` periodically and
  keep them patched; the test suite uses Node's built-in runner (no extra deps).
- **Client key exposure is expected**, not a leak — that is why restriction (#1)
  is the real control.

## 6. Availability / cost of dense routes

A very long/dense metro route is inherently heavy. The request budget + partial
results + cache keep a single scan bounded, and the rate limit bounds how often
anyone can start one. Set the Google budget alert (#1) as the backstop.

---

### Quick pre-launch checklist
- [ ] Restrict the Maps key by HTTP referrer to the Render domain.
- [ ] Restrict the key to Maps JavaScript + Directions APIs only.
- [ ] Set a Google Cloud **budget + alert**.
- [ ] Confirm `.env` is git-ignored and not in history; secrets set in Render.
- [ ] Sanity-check `SCAN_RATE_MAX` for your expected audience size.
- [ ] (Optional) split browser vs. server Google keys; add CSP/security headers.
