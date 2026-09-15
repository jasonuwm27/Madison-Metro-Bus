# Madison Metro reliability tracker

Archives Madison Metro's GTFS-RT feeds to build historical on-time performance
data for UW–Madison riders.

The eventual question this answers: *"Route 80 at Union South, 8:50am — how
often is it actually late?"* Nobody publishes that, and nobody archives the
feeds it would come from. This collects them.

**Status: phase 1 (ingestion) complete.** No frontend or analysis API yet.

## Why it has to run now

Madison Metro publishes realtime data but keeps no history. The feeds show what
is happening this minute and nothing about last Tuesday. Every day the collector
is not running is a day of history that cannot be reconstructed from any source,
at any price. That is the reason the ingestion worker was built before anything
anyone can look at.

## Architecture

```
  Metro GTFS-RT ──► fetch (retry/backoff) ──► ARCHIVE (raw bytes, first)
                                                 │                  │
                                                 ▼                  ▼
                                           decode (pure)     hourly .ndjson.gz
                                                 │            local disk / R2
                                                 ▼
                    ScheduleCache ────────► transform (pure)
                     (static GTFS)                │
                                                 ▼
                                    upsert (convergent, idempotent)
                                                 │
                                                 ▼
                                    stop_time_observations
                                     weekly partitions, 45d
                                                 │
                                                 ▼
                                  rollup_daily 90d ──► rollup_monthly ∞
```

Three feeds are polled: **TripUpdates** and **VehiclePositions** every 30s,
**Alerts** every 5 minutes. All three are archived raw. Only TripUpdates is
decoded and written to Postgres in phase 1 — but all three are archived now,
because none of them is backfillable and "add it later" means permanently
missing the days in between.

**The archive is the record of record; Postgres is a cache.** Raw bytes are
written before decoding, so a decoder bug or a schema change is a replay rather
than a permanent hole — and that is what makes evicting old partitions safe.

One row in `stop_time_observations` is one
`(service_date, trip_id, stop_sequence, is_modified)`, upserted on every poll.
Metro re-reports every upcoming stop of every active trip continuously — 6,035
stop updates per poll, 27% of them changed 90 seconds later — so the row is
collapsed rather than appended. `observed_arrival` holds the newest prediction;
when the bus passes, the stop drops out of the feed and the last value stands.
That last value is the arrival.

The primary key doubles as the idempotency key, so re-polling, restarting
mid-poll, and replaying an archive shard all converge on the same row.

The feed carries **no `delay` field and no `trip.start_date`**, so lateness comes
from joining the static schedule, and the service day is inferred by matching
observed times against it. Both are documented in detail in
[CLAUDE.md](CLAUDE.md).

## Current status

Update this section with real numbers as they come in.

| Metric | Value | As of |
|---|---|---|
| Collecting since | _not yet started_ | — |
| Observations stored | — | — |
| Service days covered | — | — |
| Archive shards / size | — | — |
| Worker uptime (7d) | — | — |
| Static feed version | `S072_202608240858` (expires 2026-12-05) | 2026-09-15 |

Queries for these numbers:

```sql
-- Observations, and the span they cover.
select count(*) as observations,
       min(service_date) as first_day,
       max(service_date) as last_day,
       count(distinct service_date) as days
from stop_time_observations;

-- Poll health over the last day, per feed.
select feed,
       count(*) as polls,
       count(*) filter (where not ok) as failures,
       round(avg(duration_ms)) as avg_ms,
       round(avg(feed_age_s)) as avg_feed_age_s,
       sum(rows_written) as rows_written
from ingest_runs
where started_at > now() - interval '1 day'
group by feed;

-- Sanity check: how much of the data actually has a usable schedule match?
select scheduled_source, count(*)
from stop_time_observations
group by scheduled_source;
```

## Setup

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.example .env     # then set DATABASE_URL
```

Load the static schedule first — without it observations are still collected,
but they record no delay until it exists:

```bash
pnpm load-static          # downloads the zip, ~603k stop_times, one-time
pnpm worker               # starts collecting
```

Migrations run automatically at worker startup; every statement is idempotent,
so a fresh database needs no separate setup step.

Maintenance, once collection is running:

```bash
pnpm rollup                      # daily rollup for yesterday — run daily
pnpm rollup --monthly            # rebuild the current month
pnpm partitions                  # create upcoming partitions — safe any time
pnpm partitions --drop           # evict past 45 days (refuses if not rolled up)
```

Other commands:

```bash
pnpm test        # 53 tests, all against checked-in fixtures — no network, no DB
pnpm typecheck
```

## Deployment

The worker is a single long-running Node process. It needs to be always-on with
sub-minute polling, which rules out serverless — Vercel Hobby cron runs once a
day, and 30-second polling means 2,880 invocations per feed per day regardless.

**Recommendation: a small VPS, paid for with student credits.**

| Option | Cost | Trade-off |
|---|---|---|
| **Heroku Eco dyno via GitHub Student Pack** | **$13/mo credit for 24 months — effectively free** | Best value if you are eligible. The Student Pack credit covers a $5–7/mo dyno for two years. Eco dynos sleep on inactivity, so use Basic; no SSH, and the filesystem is ephemeral, so **archive to R2, not local disk** |
| **Hetzner CX22** | ~$5/mo | 2 vCPU, 4 GB, 40 GB disk. Best raw value. Local disk holds ~18 months of archive, and you could move Postgres onto the same box later if Supabase's ceiling becomes a problem. You own updates and backups |
| **Fly.io** | ~$2–5/mo | Smallest machine is cheap and it restarts on crash. Pure pay-as-you-go with no base fee. Billing is per-second and can surprise you |
| **Render background worker** | $7/mo | Simplest deploy story. Their free tier does not cover workers, only web services, and those sleep |
| **Azure via Student Pack** | $100 credit | Worth it only if you already know Azure; the credit expires and the VM sizing is fiddly |

**Start with Heroku if you qualify for the Student Pack** — two years of free
hosting is hard to argue with, and the ephemeral filesystem is a non-issue once
`ARCHIVE_SINK=r2` is set. Otherwise Hetzner, which is the best value per dollar
and leaves the most room to grow.

Whatever you pick, set `HEALTHCHECK_URL`. A free healthchecks.io check with a
20-minute alert threshold is the difference between losing an evening of data
and losing a fortnight — and because Supabase pauses a free project after 7 days
of database inactivity, an unnoticed worker death compounds into a paused
project on top of the outage.

Run under a supervisor that restarts on exit (systemd, or the platform's own).
The worker is built never to exit on feed or database failures, but a restart
policy costs nothing and covers the cases nobody predicted.

### Storage budget

At ~4.4M rows/month and ~970 MB/month with indexes, Supabase's 500 MB free tier
holds roughly two weeks of raw observations — which is why partitions are
evicted at 45 days and why the archive exists. The rollups are permanent and
small. The archive runs **~5 GB/month** gzipped (measured, not estimated: a real
131,904-byte TripUpdates payload compresses to 54,307 bytes as base64 NDJSON).
That fills Cloudflare R2's 10 GB free tier in about two months, after which R2
charges $0.015/GB/month — roughly $0.90/month once a year of history has
accumulated. Setting `ARCHIVE_COMPRESSION=brotli` cuts it to ~3.7 GB/month with
no change to the format.

If you want full raw history hot in Postgres, self-hosting on the VPS is the
cheaper answer than Supabase Pro: 40 GB of Hetzner disk is ~3.5 years of raw
observations for the price you are already paying for the worker.

## Documentation

- [CLAUDE.md](CLAUDE.md) — architecture decisions, feed quirks, schema
  rationale, and the reasoning behind the indexing and partitioning choices.
- `sql/` — schema, with the reasoning inline.

## Data source

Madison Metro Transit GTFS and GTFS-RT feeds, used under Metro's Developer
License Agreement and Terms of Use. The feeds are open and require no API key.
This project is not affiliated with the City of Madison.
