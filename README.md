# Madison Metro reliability tracker

**Live at [madison-bus.pages.dev](https://madison-bus.pages.dev).**

Answers a question nobody publishes: *"Route 80 at Union South, 8:50am — how
often is it actually late?"* Madison Metro's realtime feeds show what's
happening this minute and nothing about last Tuesday, and nobody archives
them. This does: a collector has been polling Metro's GTFS-RT feeds every 30
seconds since September 2026, turning a feed with no history into a growing
one, and a static site built from that data answers the question above for
every stop and route in the system.

## What it does

- **Collects continuously.** A Node worker polls Madison Metro's TripUpdates,
  VehiclePositions, and Alerts feeds around the clock, archives the raw bytes,
  decodes TripUpdates, and joins it against the static GTFS schedule to
  compute how late each bus actually ran.
- **Never loses a poll.** Every write is idempotent and convergent — a
  restart, a retry, or a replay of an archived shard all land on the same
  final row, so the pipeline degrades instead of corrupting on failure.
- **Serves it as a static site.** A nightly export turns the accumulated
  Postgres data into flat JSON, deployed to Cloudflare Pages — no live
  backend for the site itself, so it stays up even if the collector doesn't.

## Why this was hard

The interesting engineering here isn't the UI — it's what it took to turn an
unreliable, undocumented realtime feed into data worth trusting. A few
examples (full writeups in [CLAUDE.md](CLAUDE.md)):

- **The feed has no `delay` field and no service date.** Only absolute
  timestamps, so lateness has to be computed by joining the static schedule,
  and the service day itself has to be *inferred* — by finding the calendar
  date whose scheduled time is nearest the observed one, which is what makes
  after-midnight trips (a bus scheduled "24:30:00") resolve correctly instead
  of silently breaking at midnight.
- **Detoured trips are published twice** — once as a planned reroute with no
  vehicle attached, once as a live vehicle update — and they disagree with
  each other by about a second. Naive dedup drops the wrong one; a precedence
  rule in the transform decides which copy is authoritative.
- **Predictions churn hard**: two polls 90 seconds apart shared ~5,000
  (trip, stop) pairs, and 27% of them had already changed. The schema stores
  one *collapsed* row per stop visit instead of appending every poll — which
  cuts ~2M rows/day down to the couple hundred thousand that actually
  matter — while still keeping churn stats (`change_count`,
  `min`/`max_predicted_arrival`) instead of throwing that signal away.
- **Two production incidents cost a day of raw archive** before the
  root causes (an append-mode file bug, and a shutdown routine that only woke
  one of three concurrent pollers) were found and fixed — both are now
  regression tests, not just fixes. See "Two bugs that destroyed the first
  day of archive" in CLAUDE.md.
- **The archive is the real database; Postgres is a cache.** Raw bytes are
  written before anything is decoded, so a decoding bug or schema mistake is
  a replay away, not a permanent hole — which is also what makes it safe to
  evict old Postgres partitions on a schedule instead of growing forever.

## Architecture

```
  Metro GTFS-RT ──► fetch (retry/backoff) ──► ARCHIVE (raw bytes, first)
                                                 │                  │
                                                 ▼                  ▼
                                           decode (pure)     hourly .ndjson.gz
                                                 │             local disk + Drive
                                                 ▼
                    ScheduleCache ────────► transform (pure)
                     (static GTFS)                │
                                                 ▼
                                    upsert (convergent, idempotent)
                                                 │
                                                 ▼
                                    stop_time_observations
                                     (weekly partitions, 400d local)
                                                 │
                                                 ▼
                                  rollup_daily ──► rollup_monthly
                                                 │
                                                 ▼
                                nightly export ──► static JSON ──► Cloudflare Pages
```

Three feeds are polled — TripUpdates and VehiclePositions every 30s, Alerts
every 5 minutes — and all three are archived raw, because none of them is
backfillable: "decode it later" would mean permanently missing every day in
between. Only TripUpdates is decoded into Postgres today.

The pure transform logic (`src/gtfsrt/decode.ts`, `src/gtfsrt/transform.ts`,
`src/util/time.ts`) is synchronous, has no network or database access, and is
the entire tested surface — 93 tests run against checked-in protobuf fixtures,
no network or DB in CI.

## Stack

- **Collector**: Node 22 (TypeScript, strict), `postgres` for SQL, `pino` for
  structured logs, `zod` for env validation. Runs as a systemd service on a
  small ARM VM (Oracle Cloud free tier), not serverless — sub-minute polling
  needs an always-on process.
- **Database**: self-hosted Postgres 17 on the same VM. Started on Supabase,
  fully migrated off it once local storage proved cheaper and higher-ceiling
  (see "Cutover" in CLAUDE.md) — a five-day parallel run comparing both
  databases row-for-row was the acceptance test before cutting over.
- **Site**: no framework — a Node export script queries Postgres and writes
  static JSON plus server-rendered HTML for the landing page; the client is
  vanilla JS with its own tiny client-side router. Deployed to Cloudflare
  Pages, which — unlike GitHub Pages — properly rewrites deep links like
  `/stop/1234` to the app shell.
- **Backups**: the raw archive is mirrored nightly to Google Drive via
  `rclone`, verified by MD5 (not size or existence — a same-size corrupt file
  is still corrupt), with a disaster-recovery restore actually tested end to
  end.
- **Monitoring**: healthchecks.io pings from every scheduled job (worker
  liveness, rollup, backup, partition maintenance), so a silent failure
  becomes an alert instead of a gap discovered weeks later.

## Repo layout

```
src/gtfsrt/       decode + transform — pure, synchronous, fully tested
src/db/           all SQL lives here
src/worker.ts     wires everything together, owns the poll loops
src/util/time.ts  service-date inference — the fragile part, read CLAUDE.md first
scripts/          rollup, partition maintenance, backups, site export, one-off ops tools
site/             the static site (public/) and its local dev server
test/             93 tests against checked-in GTFS-RT fixtures — no network, no DB
sql/              schema, with the reasoning for each decision inline
```

## Running it locally

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env     # set DATABASE_URL

pnpm load-static          # one-time: downloads Metro's schedule zip, ~603k rows
pnpm worker                # starts collecting
```

Migrations run automatically at worker startup and are idempotent, so a fresh
database needs no separate setup step.

```bash
pnpm test         # 93 tests, no network or DB required
pnpm typecheck
```

Maintenance, once a worker has been collecting for a while:

```bash
pnpm rollup                # daily rollup for yesterday
pnpm partitions             # create upcoming partitions
pnpm partitions --drop      # evict old partitions (refuses if not rolled up)
```

To run the site locally against a snapshot of real data:

```bash
node scripts/pull-site-data.mjs   # pulls a fresh export from the VM
pnpm site                          # serves site/public at localhost:8788
```

## Documentation

- [CLAUDE.md](CLAUDE.md) — the detailed engineering log: every schema
  decision and why, the production incidents and their fixes, the Supabase
  → self-hosted cutover, backup verification, and the reasoning behind each
  indexing and partitioning choice. Written for whoever touches this code
  next, including future me.
- `sql/` — schema, with reasoning inline.

## Data source

Madison Metro Transit GTFS and GTFS-RT feeds, used under Metro's Developer
License Agreement and Terms of Use. The feeds are open and require no API
key. This project is not affiliated with the City of Madison.
