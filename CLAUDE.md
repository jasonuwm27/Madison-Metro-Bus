# CLAUDE.md

Context for future sessions on this repo. Read this before changing the schema
or the transform.

## What this is

A collector that archives Madison Metro's GTFS-RT feeds so that historical
on-time performance data exists. Nobody else archives these feeds. Every day the
collector is down is a day of history that cannot be recovered from any source.
That single fact drives most of the decisions below.

**Phase 1 (done): ingestion only.** No frontend, no analysis endpoints, no auth.
Do not scaffold a React app.

## Verified facts about the feeds

Verified against live payloads on 2026-09-15. Do not trust the GTFS-RT spec's
optional fields — verify against a real payload before relying on one.

| Feed | URL | Notes |
|---|---|---|
| TripUpdates | `https://metromap.cityofmadison.com/gtfsrt/trips` | ~132 KB, 233 entities |
| VehiclePositions | `https://metromap.cityofmadison.com/gtfsrt/vehicles` | ~5.6 KB, 96 entities |
| Alerts | `https://metromap.cityofmadison.com/gtfsrt/alerts` | ~1.3 KB, 4 entities |
| Static | `https://transitdata.cityofmadison.com/GTFS/mmt_gtfs.zip` | 7.3 MB |

**No API key.** All three RT feeds return HTTP 200 unauthenticated. The
`dev-account` key on Metro's developer page is for the separate Bus Tracker API,
not for GTFS. Use is governed by Metro's Developer License Agreement.

Five properties of the TripUpdates feed that the schema is built around:

1. **There is no `delay` field anywhere.** Not on `tripUpdate`, not on
   `stopTimeUpdate.arrival`. Only absolute epoch `arrival.time`. Every lateness
   number must come from joining static `stop_times`. This makes the static
   loader a hard dependency of the analysis, not an optional extra.
2. **There is no `trip.start_date`.** The service day must be inferred by
   matching observed times against the schedule. See "Service dates" below.
3. **The feed is heterogeneous.** The sample held 228 `tripUpdate`, 2 `shape`,
   1 `stop`, and 2 `tripModifications` entities. Code that assumes every entity
   is a tripUpdate will throw or silently drop data.
4. **Detoured trips are published twice.** Once as a planned modified itinerary
   (no `trip_id`, carries `modifiedTrip.affectedTripId`, all stops, no vehicle)
   and once as a live vehicle update (real `trip_id`, remaining stops only,
   vehicle attached). They overlap and disagree by about a second. In the
   sample, trips `3856020` and `4314020` each appeared this way, colliding on 46
   stop sequences. `is_modified` in the primary key does **not** separate them —
   `transformFeed` applies a precedence rule instead.
5. **Predictions churn hard.** Two polls 90 seconds apart shared 4,968
   (trip, stop) keys, of which 1,342 (27%) had a changed predicted arrival.
   282 keys vanished — those are buses that passed the stop.

`tripModifications` entities carry `replacementStops` with **only** `stopId` —
no `stop_sequence`, no travel times. Not a usable schedule source. There is a
`propagatedModificationDelay`, but it is one coarse value for the whole
modification. Do not build against it.

### Static feed

603,662 `stop_times`, 14,199 trips, 1,659 stops, 19 routes.
`feed_version S072_202608240858`, valid 2026-08-16 to **2026-12-05**.

3,827 `stop_times` rows have times past `24:00:00`. 82.8% of rows are
`timepoint=0`, meaning their scheduled time is *interpolated* between
timepoints — delay at those stops is measured against an estimate, and analysis
may want to weight or filter on it.

Daily volume, counted from the static feed: 171,795 stop events per weekday
(4,107 trips), 80,703 Saturday, 72,605 Sunday. **~1.01M rows/week,
~4.4M/month, ~970 MB/month with indexes.**

## Architecture

```
  Metro GTFS-RT ──► fetch (retry/backoff) ──► ARCHIVE (raw bytes, first)
                                                 │
                                                 ▼
                                           decode (pure)
                                                 │
                                                 ▼
                    ScheduleCache ────────► transform (pure)
                     (static GTFS)                │
                                                 ▼
                                    upsertObservations (convergent)
                                                 │
                                                 ▼
                                    stop_time_observations
                                     (weekly partitions, 45d)
                                                 │
                                                 ▼
                                  rollup_daily (90d) ──► rollup_monthly (∞)
```

**The archive is the record of record; Postgres is a cache.** Raw bytes are
written to the archive *before* decoding, so a decoder bug or a schema mistake
is a replay away rather than a permanent hole. This is what makes dropping
partitions at 45 days acceptable — eviction is not data loss.

Archive volume, measured on a real 131,904-byte payload: 54,307 B/poll as
gzipped base64 NDJSON, so **~5 GB/month** across all three feeds. R2's free tier
covers ~2 months; `ARCHIVE_COMPRESSION=brotli` brings it to ~3.7 GB/month with
an identical on-disk format.

### Layer boundaries

- `src/gtfsrt/decode.ts`, `src/gtfsrt/transform.ts`, `src/util/time.ts` are
  **pure and synchronous**. No network, no clock, no database. This is
  deliberate: it is the entire tested surface. Keep it that way — if the
  transform needs data, load it first and pass it in, as `ScheduleIndex` does.
- `src/db/*` owns all SQL. `src/worker.ts` wires things together and owns the
  poll loops and failure handling.
- Tests run against checked-in protobuf fixtures in `test/fixtures/`. **Never
  add a test that hits the network or a database** — CI has no secrets and must
  stay that way.

## Schema decisions

### Row model: collapsed, not append

One row per `(service_date, trip_id, stop_sequence, is_modified)`, upserted on
every poll. `observed_arrival` holds the newest prediction; when the bus passes,
the stop stops being reported and the last value stands — that value *is* the
observed arrival. Metro even keeps reporting a stop briefly after passage with
the actual time (57 of 5,772 arrival times in the sample were already past).

Appending every poll would cost ~2M rows/day; appending every *change* still
costs ~600k/day. Churn is not thrown away: `first_predicted_arrival`,
`min_predicted_arrival`, `max_predicted_arrival` and `change_count` retain its
magnitude, and the full history is in the archive.

### Idempotency

**The primary key is the idempotency key.** The upsert is convergent, not merely
guarded: re-polling, restarting mid-poll, or replaying an archive shard all
produce the same final row. Only `poll_count` and `last_seen_at` move on a
repeat, and they move monotonically.

The `ON CONFLICT` clause only ever *adds* information. `COALESCE` guards mean a
poll that cannot resolve a schedule can never blank out a match already
established — without them, one poll arriving before the static load finished
would wipe schedule data for the whole day.

Duplicates **within** a single poll are collapsed in `transformFeed` before the
write. This is not optional: Postgres rejects an `ON CONFLICT DO UPDATE` that
touches the same row twice in one statement, and that error aborts the entire
batch — losing the whole poll, not just the duplicate.

### Indexing: only immutable columns

The table takes ~6,000 UPDATEs per poll, ~17M/day. Postgres can apply these as
HOT (heap-only tuple) updates, touching no index at all — **but only if no
indexed column changed.**

So every column that mutates on a poll (`observed_arrival`, `delay_seconds`,
`change_count`, `poll_count`, `last_seen_at`) is left unindexed, and every
indexed column is fixed at insert. Partitions are created with `fillfactor = 85`
to leave in-page room for HOT updates.

**Adding an index on `delay_seconds` or `last_seen_at` would look harmless and
would silently convert all ~17M daily updates into non-HOT updates**, each
writing fresh entries into every index. Do not do it without measuring.

Two indexes exist:
- `(stop_id, route_id, scheduled_hour_local)` serves the target query. `stop_id`
  leads because it is most selective (1,659 stops vs 19 routes) and because its
  prefixes independently answer "everything at this stop" and "this route at
  this stop, all day". **Tradeoff:** a route-first query cannot use it and falls
  back to a partition scan. Accepted; the product is stop-centric.
- `(service_date)` for the rollup and the retention guard.

### Generated column

`delay_seconds` is `GENERATED ALWAYS ... STORED` over `observed_arrival -
scheduled_arrival`, so it cannot drift from its operands and recomputes if a
scheduled time is corrected. `timestamptz - timestamptz` is IMMUTABLE (a pure
duration), which is what makes it legal in a generated column.

`scheduled_hour_local` and `day_type` are **not** generated — converting a
timestamptz to a named zone is STABLE, not IMMUTABLE (the tz database can
change), so Postgres rejects it in generated columns and plain index
expressions. The worker computes them.

`scheduled_source` records provenance: `0` unmatched, `1` matched the schedule
in effect, `2` matched but this is a detour trip whose static row describes the
*pre*-detour routing. Without it, an unmatched row and a genuinely on-time row
are indistinguishable once `delay_seconds` is null-coalesced downstream.

### Partitioning

Weekly range partitions on `service_date`. The reason is **retention, not query
speed**. `DROP TABLE` on a partition is an instant catalog operation; the DELETE
it replaces would rewrite ~1M rows, leave dead tuples for VACUUM, and bloat both
indexes while competing with a worker writing ~200 rows/sec.

Weekly rather than daily because planning time grows with partition count —
weekly keeps it near 52/year instead of 365.

A **DEFAULT partition exists as a safety net.** If partition creation ever falls
behind, inserts land there instead of failing. A failed insert is unrecoverable
loss; a row in the wrong partition is a chore. `pnpm partitions` warns if the
default is non-empty.

### Rollups

`n`, `sum_delay`, `sum_delay_sq`, `min`, `max` are **algebraic** — they compose,
so exact mean and stddev for any date range come from the rollup without
touching raw. That is why `sum_delay_sq` is stored rather than a precomputed
stddev, which would not compose.

Percentiles are **holistic** — a monthly p50 is not derivable from thirty daily
p50s. So both levels compute percentiles from raw.

**Load-bearing ordering constraint:** the monthly rollup reads raw, so month M
must be rolled up before M's partitions pass the 45-day drop. A month is at most
31 days old when it closes, leaving 14 days of slack. `dropExpiredPartitions`
enforces this — it refuses to drop a partition whose days are not in
`rollup_daily`.

## Service dates — the fragile part

`src/util/time.ts`. Treat changes here with suspicion and keep the tests green.

The feed carries no `start_date`, so the service day is inferred: take the
observation's local date and its two neighbours, keep the dates on which the
trip actually runs per `calendar`/`calendar_dates`, and choose the one whose
scheduled instant is nearest the observed one. Distance-minimising rather than
clock arithmetic is what makes after-midnight trips work — at 00:30 local, a
trip scheduled 24:30:00 is 0 seconds from the previous service date and 24 hours
from the current one, and the same comparison still works when the bus is late.

A trip is anchored **once**, by the first stop with both a schedule entry and an
observed arrival, and all its stops share that date. A trip cannot straddle two
service days, and resolving per stop would let a late bus disagree with itself
across midnight.

**Nothing is ever dropped for want of a service date.** An unanchored trip is
recorded under the feed's local date with its schedule deliberately withheld, so
it reads as unmatched rather than carrying a delay computed against a guess.
Losing an observation is permanent; an unmatched row is fixable from the archive.

Service day start is local noon minus 12 hours, per GTFS. Going through noon is
what makes it DST-safe — local midnight can be skipped or repeated, noon never
is. A consequence worth knowing: the 23- and 25-hour service days land on the
date *before* each transition (2026-03-07 and 2026-10-31), because a service day
is derived from its own date's noon and Sunday's noon already carries the new
offset. There is a test pinning this.

## Conventions

- TypeScript strict throughout, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Both catch real bugs in this codebase; do not
  relax them.
- `.js` extensions on relative imports (ESM + `verbatimModuleSyntax`).
- Config via env, validated once at startup with zod. A bad env var should crash
  immediately, not surface at 3am.
- Structured logs via pino. Every poll emits one summary line.
- Comments explain *why*, especially where the code looks odd — most odd-looking
  code here is odd because the feed is.

## Operational invariants

- **The worker must never exit on a feed or database failure.** Every failure
  path degrades: retry next tick, log, keep running. Only startup errors exit.
- Archive writes happen before decode.
- A failed upload keeps the local shard. Never delete a shard that was not
  confirmed uploaded.
- Supabase free tier pauses after ~7 days of **database** inactivity. A worker
  upserting every 30s prevents this — but a dead worker means the project
  pauses on top of the outage, compounding it. Hence the healthcheck.

## Deployment (2026-09-16)

Production runs on an Oracle Cloud Always Free VM, not the laptop.

| | |
|---|---|
| Host | `163.192.9.150`, user `opc`, Oracle Linux 9.8 |
| Shape | `VM.Standard.A1.Flex`, **aarch64** Ampere, 2 OCPU / 12 GB, us-sanjose-1 |
| Repo | `/opt/bus/repo`, runs as `opc` |
| Archive | `/var/lib/bus-archive` (30 GB volume, ~20 GB free) |
| Runtime | Node 22 ARM64 + tsx (no build step; dist/ cannot go stale) |

**Architecture matters.** The box is aarch64; `esbuild` (via tsx/vitest) ships
per-arch binaries. Never copy `node_modules` from an x86 machine.

Units: `bus-worker.service` (Restart=always, RestartSec=10,
StartLimitIntervalSec=0 so it never gives up), plus timers `bus-rollup`
(daily 03:15 CT), `bus-partitions` (Mon 02:30 CT), `bus-drop`
(daily 06:15 CT, 15-day retention). `bus-drop.service` declares
`Requires=`/`After=bus-rollup.service`, so eviction cannot run without a
successful rollup — belt and braces with the in-code guard in
`dropExpiredPartitions`.

journald is capped at `SystemMaxUse=500M` / `SystemKeepFree=2G` /
`MaxRetentionSec=30day`.

Oracle's restrictive default iptables is NOT present on this image — INPUT is
empty with policy ACCEPT, and Metro, Supabase and GitHub were all reachable
without touching firewall rules.

## Two bugs that destroyed the first day of archive

Both found by deploying, not by testing. Worth understanding before touching
the archive or the worker's lifecycle.

**Append-mode shard writes.** Shards were opened `flags:"a"`. A worker
restarting inside the same UTC hour piped a second gzip stream onto an
unfinalised first one. Concatenated gzip members are legal; a *truncated*
member followed by another is not. Every shard from 2026-09-15 is unreadable
("invalid block type", "invalid distance code"). Now `flags:"wx"` with
rotate-aside on collision. Regression test in `test/archive.test.ts`.

**Shutdown woke only one sleeper.** `Shutdown` held a single resolver handle
shared by three concurrently-sleeping poll loops, so each `sleep()` clobbered
the last. On SIGTERM only the newest woke; the alerts loop sat out its full
300s interval, exceeded systemd's `TimeoutStopSec=60`, and got SIGKILLed
mid-write. Now a `Set` of waiters. Tests in `test/shutdown.test.ts`.

These compounded: SIGKILL left a `.partial` behind, and the next start appended
to it. The Postgres rows survived both; only raw bytes were lost.

**Lesson worth keeping:** the archive is the thing that cannot be re-collected,
so its integrity deserves verification, not assumption. `node /tmp/chk.js` on
the VM decompresses every shard and reports record counts — run it after any
change to the archive path.

## Archive backup: Google Drive via rclone (2026-09-16)

Drive is the permanent, authoritative copy. Local disk is a 90-day hot cache.

| | |
|---|---|
| Remote | `gdrive:BusProject/archive` (pinned; copy cannot write above it) |
| Layout | `feed/YYYY/MM/DD/HH.ndjson.gz` |
| Account | 5 TiB total, 4.999 TiB free |
| Scope | `drive.file` -- rclone only sees files it created |
| Unit | `bus-archive-sync.timer`, daily 04:30 CT |

`rclone copy`/`copyto`, **never `rclone sync`**. sync mirrors the destination to
the source, so paired with the local pruner it would propagate every prune into
the only backup and eat the archive from the oldest end forward.

**Pruning is gated on MD5, never on existence or age.** A remote file can exist
at the right *size* and still be corrupt; only the hash catches that. Verified
by deliberately corrupting a remote shard to the same byte count -- the prune
withheld it (`pruned: 2, withheld: 1`) while a size check would have deleted
the last good copy.

Upload selection is also by MD5. Selecting by size left a same-size corrupt
remote permanently un-repaired: excluded as "already present", failed hash
confirmation, excluded again next run, logging "will re-upload" forever.

Order is enforced *inside one process*, not across two units: the prune can only
act on shards that same invocation just confirmed. There is no window where a
failed upload is followed by a prune that trusts it.

Timer ordering: rollup 03:15 -> archive-sync 04:30 -> partition drop 06:15 CT.

### Verified, not assumed

`--verify` downloads a shard, decompresses it, and compares decoded protobuf
payloads. An independent check (`/tmp/rt.js` on the VM) additionally re-decodes
every Drive copy with the real GTFS-RT decoder: 4,482,089 bytes across 25
records, 7,511 entities, byte-identical. Local shards were also fully restored
*from Drive* after the prune test -- a live disaster-recovery proof.

### KNOWN EXPIRY -- rclone's shared client_id

`rclone about` warns: rclone's shared Google client_id **is being retired and
will stop working during 2026**. Backups will silently start failing when that
happens. Fix is to create a personal OAuth client ID
(https://rclone.org/drive/#making-your-own-client-id) and add `client_id` /
`client_secret` to `~/.config/rclone/rclone.conf`. Not urgent, but it is a
dated failure, not a hypothetical one.

## MEASURED storage cost (2026-09-16) -- supersedes earlier estimates

Measured against a real partitioned table, not estimated:

| | |
|---|---|
| Bytes/row incl. indexes | **307** (earlier estimate: ~220) |
| Growth | **53 MB/day**, ~370 MB/week |
| Supabase 500MB cap | reached in **~8 days** from 2026-09-16 |
| 15-day eviction steady state | **792 MB** of observations + 62 MB static |

**15-day eviction does NOT fit inside Supabase's free tier.** The retention
figure was chosen against the lower estimate. On Supabase the ceiling is
roughly 7 days of observations; only the move to the VM makes long retention
possible. This makes the Postgres migration time-critical, not optional.

static_stop_times is 62.1 MB per feed version and does not grow with
collection, but a new Metro feed version adds another copy.

## Local Postgres + parallel run (2026-09-17)

Postgres 17.11 on a dedicated 50GB block volume; both workers collecting.

| | |
|---|---|
| Volume | `/mnt/pgdata`, UUID `d94a6856-d7f3-499a-8988-ff5e51d6d7e6` |
| PGDATA | `/mnt/pgdata/17/data` (data checksums on) |
| Split | Postgres 35GB / archive 12GB / 3GB headroom |
| Workers | `bus-worker` -> Supabase, `bus-worker-local` -> localhost |
| Retention | Supabase 10d (`bus-drop`), local 400d (`bus-drop-local`) |

**Device names are NOT stable.** Across one reboot the volume moved
`sdb` -> `sda` and the boot disk the other way, and `/dev/oracleoci/oraclevd*`
symlinks vanished. Only the UUID is trustworthy.

**`RequiresMountsFor` is not a guard.** systemd auto-mounts the path to satisfy
it, and the packaged unit runs `initdb` on an empty PGDATA -- a failed mount
would create a fresh cluster on the boot disk and serve it while root filled.
`/usr/local/bin/check-pgdata-volume.sh` (ExecStartPre) asserts mountpoint,
UUID, marker file and PG_VERSION. Verified: volume unmounted + mount unit
masked -> Postgres refused to start, zero bytes on the boot disk.

Measured sizing: **294 bytes/row**, 1.29 GB/month observations, ~1 GB/year
rollups, and the **archive cache is 6.9 GB/month** -- five times hungrier than
Postgres, which is why the split favours the database.

## Healthchecks (2026-09-17)

`/etc/bus-healthchecks.env`, `root:bushc` 0640; `opc` reads it via the `bushc`
group. Not world-readable, because a ping URL is a capability -- anyone holding
it can send "ok" and silence the alert.

`EnvironmentFile=` does NOT work for this: systemd reads it as the service user,
which cannot read a root-only file, and `Environment=X=${Y}` is stored
literally rather than expanded. The wrapper sources the file itself.

| Unit | Check |
|---|---|
| `bus-archive-sync` | `HC_ARCHIVE` |
| `bus-backup` | `HC_BACKUP` |
| `bus-rollup`, `bus-rollup-local` | `HC_ROLLUP` |
| `bus-partitions` | `HC_PARTITIONS` |
| weekly summary | `HC_SUMMARY` |
| **`bus-drop`, `bus-drop-local`** | **UNMONITORED -- `HC_DROP` not created** |
| **`bus-worker-local`** | **UNMONITORED -- `HC_WORKERLOCAL` not created** |

`bus-drop` silence means Supabase fills without warning. Create those two
checks and fill the placeholders in the env file.

## Known gaps / next steps

- **Departure-only stops are skipped.** 149 of 6,035 in the sample — trip origin
  stops, where arrival is meaningless. If a stop of interest turns out to be a
  trip origin, revisit. The archive retains them.
- VehiclePositions and Alerts are archived but not decoded. VehiclePositions is
  the only independent check on the final-prediction-as-arrival assumption, so
  decoding it is the natural phase 2.
- No backfill tool yet for replaying archive shards into Postgres. The archive
  format is designed for it (one JSON line per poll, `payload_b64`), but the
  replayer is unwritten.
- `scripts/upload-archive.ts` pushes local shards to R2 (idempotent, keyed by
  feed/date/hour, never deletes). R2 credentials are not yet configured, so the
  VM archive is currently single-copy on local disk.
- 2026-09-15 raw archive is permanently lost (see above). Postgres rows for
  that day are intact.
- `rollup_daily`/`rollup_monthly` tables and functions exist; no scheduler is
  wired up. Run `pnpm rollup` daily and `pnpm partitions --drop` weekly.
