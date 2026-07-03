# RouteNat performance: testing plan & strategies

The symptom: long or dense routes take a very long time and sometimes fail to
fetch. This document explains **where the time goes**, gives a **repeatable
testing plan** to measure it, and lists **strategies** ranked by impact.

## Why it's slow (measured, not assumed)

The instrumentation contradicted the obvious guess. On a dense ~15 km route,
70 iNat requests took **178 s**, but time spent parked in the rate limiter
(`meta.inat.waitMs`) was **0.6 s**. So the scan was **not rate-limited** — it was
**latency-bound**: each `unobserved_by_user_id` query takes ~2–2.5 s of iNat
server time, and the original limiter *serialized on completion*, so:

```
time ≈ Σ per-request latency ≈ 70 × 2.5s ≈ 175s      (only ~24 requests/min!)
```

We had huge headroom under the 60/min budget and weren't using it. Two levers
follow:

1. **Concurrency is the big win (implemented).** Because we're latency-bound, run
   several requests in flight at once. The limiter now spaces request *starts*
   ≥1s apart (still ≤60/min) instead of waiting for each to finish, and circles
   are queried by a bounded worker pool (`INAT_CONCURRENCY`, default 4). Wall-clock
   drops toward the 60/min floor (~1 req/s) instead of the ~2.5 s/req latency.
2. **Request count still matters at the margin.** iNat returns 200/req, so
   `requests ≈ ceil(observations_in_swept_area / 200)`. In **dense** areas a
   *bigger* radius sweeps more area → more observations to page → *more* requests,
   most discarded by the 1-mile buffer filter. The brief's "bigger circles = fewer
   requests" only holds in **sparse** areas. Use the benchmark to find the
   crossover and right-size `QUERY_RADIUS_KM` per density.

Also confirmed by the benchmark: server-side `unobserved_by_user_id` filtering
is both correct (verified it excludes taxa the user has observed) and far more
budget-efficient than the local `species_counts` filter, which truncated on the
same route. It is the default (`filterStrategy: 'server'`).

## What was already changed

- **Server-side unseen filter** (`unobserved_by_user_id`) — default; typically
  the single biggest reduction for power users.
- **`hrank=species&lrank=species`** — only species-level records (also the
  correctness fix requested).
- **id-cursor pagination** (`id_above`) instead of page offsets — correct past
  iNat's 10k offset cap.
- **Per-scan request budget** (`MAX_REQUESTS_PER_SCAN`, default 400) — a scan now
  fails fast with partial results + a warning instead of hanging for minutes.
- **Per-circle page cap** (50) — one dense circle can't run away.
- **Username validation** — unknown users fail immediately with a clear message.
- **Instrumentation** — every scan returns `meta` with request counts, per-phase
  timings, and rate-limiter wait time.

## The testing plan

### 1. Instrumentation (built in)

Each scan result carries `meta`:

```
meta.circleCount        circles placed along the route
meta.circlesQueried     circles actually queried before the budget hit
meta.requests           iNat requests spent
meta.rawObservations    deduped observations pulled (before buffer filter)
meta.timingsMs          { directions, circles, filter, total }
meta.inat               { requests, retries, retryWaitMs, waitMs }
```

`waitMs` (time parked in the rate limiter) vs `total` tells you immediately
whether you're **rate-limited** (waitMs ≈ total) or **network/compute-bound**.

### 2. Benchmark harness

`scripts/benchmark.js` drives the pipeline over a synthetic polyline (no Google
key needed — Directions is not the bottleneck) across radius × strategy combos:

```bash
# sparse rural route, compare server vs local filtering
node scripts/benchmark.js --user=<you> --scenario=short --strategy=server,local

# find the radius crossover in a dense metro area
node scripts/benchmark.js --user=<you> --scenario=dense --radius=2,5,10,15 --budget=200
```

Scenarios: `short` (~15 km rural), `medium` (~45 km), `long` (~120 km),
`dense` (~25 km metro). It prints circles, requests, rawObs, inBuffer, unseen,
species, rate-limiter wait, total time, and whether the budget truncated.

### 3. Test matrix to run

| Dimension | Values | What it isolates |
|-----------|--------|------------------|
| Route length | short / medium / long | requests scale with route length |
| Density | rural vs `dense` metro | the discard-rate problem |
| Radius | 2, 5, 10, 15 km | the "bigger circle" crossover |
| Strategy | server vs local | value of server-side filtering |
| User | new vs power user | how much `unobserved` actually removes |

For each cell record: **requests**, **total time**, **rawObs vs inBuffer**
(discard ratio), and **truncated?**.

### 4. What to look for

- `waitMs ≈ total` → rate-limited → **reduce request count** (below), don't
  parallelize (the limiter caps you at 60/min regardless).
- `rawObservations ≫ totalInBuffer` → circles too big for the density → **lower
  `QUERY_RADIUS_KM`** for that area.
- `requests` climbs linearly with route length → expected; use the budget +
  caching, and consider the streaming/progress work below.
- `server` requests ≪ `local` requests → confirms the default is right.

## Strategies, ranked by impact

1. **Server-side `unobserved_by_user_id` (done).** Biggest win for real users.
2. **Right-size the radius per density (tunable now).** Use the benchmark to pick
   `QUERY_RADIUS_KM`: large in sparse areas, small in dense ones. A future
   improvement is *adaptive* radius — start large, shrink when a circle hits many
   pages.
3. **Request budget + partial results (done).** Bounds worst-case latency.
4. **Progress streaming (recommended next).** Switch `/api/scan` to Server-Sent
   Events (or chunked/polling) emitting "circle k/N, R requests" so long scans
   show progress instead of appearing hung and tripping browser/proxy timeouts.
   This is the highest-value *remaining* UX fix.
5. **Persist the cache (recommended).** The cache is in-memory today; a small
   on-disk/Redis store keyed by polyline+username survives restarts and shares
   across instances, making repeat/reload scans effectively free.
6. **`only_id` two-phase for overlap-heavy routes.** Fetch ids per circle, dedup
   across overlapping circles, then batch full records via `id=` (200/req). Helps
   payload when circles overlap a lot; doesn't reduce the paging floor.
7. **Skip fully-covered circles on straight runs.** Minor; spacing already
   overlaps conservatively.
8. **Higher steady rate (careful).** iNat tolerates up to ~100/min; nudging the
   limiter from 60→~90/min cuts wall-clock ~1.5× but risks 429s — only with solid
   backoff and a registered OAuth app for headroom.

## Reproducing / measured results

Run the harness and paste results here as a baseline to track regressions:

<!-- BENCHMARK_RESULTS -->

Measured during development (scenario `short`, ~15 km through well-observed
central Vermont, user `kueda`, radius 5 km, server strategy):

| metric | value | reading |
|--------|-------|---------|
| requests | 70 (3 circles) | each 5 km circle paged deep |
| rawObservations | 12,864 | before buffer filter |
| in-buffer | 5,175 | ~60% discarded by the 1-mile filter → radius too big for this density |
| rate-limiter wait | **0.6 s** | **not** rate-limited |
| total | 178 s (concurrency 1) | ⇒ ~2.5 s/request iNat latency dominates |

Limiter concurrency (mocked 3 s/request, verified deterministically):

```
4 concurrent single-page circles, 3s latency each:
  serialized-on-completion: ~12s
  decoupled (new default):   6.0s   (starts 1s apart, latency overlaps)
```

Takeaways confirmed by the numbers: latency-bound not rate-bound (⇒ concurrency),
5 km circles over-pull in dense areas (⇒ lower `QUERY_RADIUS_KM` there), and a
single dense circle can hit the 50-page / 10k-observation ceiling (⇒ the budget +
per-circle cap keep it bounded). Dense metro routes remain heavy by nature —
lean on caching and smaller radii.
