-- ===========================================================================
-- 002: stop_time_observations -- the collapsed observation table.
--
-- ROW MODEL
-- Metro's TripUpdates feed re-reports every upcoming stop of every active trip
-- on every poll. Measured on 2026-09-15: 6,035 stopTimeUpdates per poll, of
-- which 27% carried a CHANGED predicted arrival 90 seconds later. Appending
-- each poll would cost ~2M rows/day; appending each *change* still costs
-- ~600k/day.
--
-- Instead one row represents one (service_date, trip, stop, is_modified)
-- event, upserted in place. observed_arrival always holds the most recent
-- prediction. When a bus passes a stop, the key stops being reported and the
-- final value stands -- that last value IS the observed arrival. (Metro keeps
-- reporting a stop briefly after passage with the actual time: 57 of 5,772
-- arrival times in the sample were already in the past.)
--
-- Churn is not discarded: first/min/max predicted arrival plus change_count
-- retain the magnitude of prediction drift without a history table. The full
-- history lives in the raw archive, from which this table is re-derivable.
--
-- IDEMPOTENCY
-- The primary key IS the idempotency key. A poll that re-reports an unchanged
-- prediction performs an UPDATE that leaves observed_arrival identical and
-- only bumps poll_count/last_seen_at. Re-running the worker, replaying an
-- archive shard, or double-polling therefore cannot create duplicates or
-- corrupt a value. Writes are convergent rather than merely guarded.
-- ===========================================================================

create table if not exists stop_time_observations (
  -- ---- key (immutable after insert) --------------------------------------
  service_date            date        not null,
  trip_id                 text        not null,
  stop_sequence           smallint    not null,
  -- Detour trips arrive with no trip_id, carrying modifiedTrip.affectedTripId
  -- instead. Two of the nine modified trips in the 2026-09-15 sample used an
  -- affectedTripId that ALSO appeared as a live trip_id in the same feed, so
  -- keying on the borrowed id alone would silently overwrite the unmodified
  -- trip's observations. This flag separates them.
  is_modified             boolean     not null default false,

  -- ---- dimensions (immutable after insert; safe to index) ----------------
  route_id                text        not null,
  stop_id                 text        not null,
  -- Hour of scheduled arrival in agency-local time, precomputed by the worker.
  -- It is NOT a generated column: converting timestamptz to a named zone is
  -- STABLE, not IMMUTABLE (the tz database can change), so Postgres rejects it
  -- in both generated columns and plain index expressions.
  scheduled_hour_local    smallint,
  -- Weekday=0, Saturday=1, Sunday=2. Precomputed for the same reason.
  day_type                smallint,

  -- ---- schedule join -----------------------------------------------------
  scheduled_arrival       timestamptz,
  -- Provenance of scheduled_arrival. Without this, an unmatched row and a
  -- perfectly on-time row become indistinguishable as soon as delay_seconds is
  -- null-coalesced downstream.
  --   0 = unmatched: no static stop_time row for this trip/sequence
  --   1 = static_exact: matched the schedule in effect on service_date
  --   2 = static_pre_modification: matched syntactically, but this is a detour
  --       trip, so the static row describes the PRE-detour routing and the
  --       comparison may be semantically wrong. Excludable by provenance.
  scheduled_source        smallint    not null default 0,
  feed_version_id         smallint    references gtfs_feed_versions(id),

  -- ---- observation (mutated every poll; deliberately NOT indexed) ---------
  observed_arrival        timestamptz not null,
  first_predicted_arrival timestamptz not null,
  min_predicted_arrival   timestamptz not null,
  max_predicted_arrival   timestamptz not null,
  change_count            smallint    not null default 0,
  poll_count              smallint    not null default 1,
  first_seen_at           timestamptz not null,
  last_seen_at            timestamptz not null,

  -- GTFS-RT StopTimeUpdate.ScheduleRelationship, native enum values:
  -- 0=SCHEDULED, 1=SKIPPED, 2=NO_DATA, 3=UNSCHEDULED.
  schedule_relationship   smallint    not null default 0,
  vehicle_id              text,

  -- ---- derived -----------------------------------------------------------
  -- Generated rather than written by the worker so it can never drift from its
  -- operands, and so it recomputes automatically if a scheduled_arrival is
  -- corrected. Null when the schedule did not match -- which is exactly why
  -- scheduled_source exists. timestamptz - timestamptz is IMMUTABLE (a pure
  -- duration, independent of timezone), which is what makes this legal here.
  delay_seconds int generated always as (
    (extract(epoch from (observed_arrival - scheduled_arrival)))::int
  ) stored,

  primary key (service_date, trip_id, stop_sequence, is_modified)
) partition by range (service_date);

comment on table stop_time_observations is
  'One row per (service_date, trip, stop, is_modified). Upserted every poll; observed_arrival converges to the true arrival. Re-derivable in full from the raw archive.';

-- ---------------------------------------------------------------------------
-- INDEXES
--
-- Exactly two, and the restraint is the point. This table takes ~6,000 UPDATEs
-- per poll, ~17M per day. Postgres can apply an UPDATE as a HOT (heap-only
-- tuple) update -- touching no index at all -- but ONLY if no indexed column
-- changed. Every column that mutates on a poll (observed_arrival,
-- delay_seconds, change_count, poll_count, last_seen_at) is therefore left
-- unindexed, and every indexed column is fixed at insert time. That keeps the
-- steady-state write path free of index maintenance and index bloat.
--
-- Adding an index on delay_seconds or last_seen_at would look harmless and
-- would silently convert all ~17M daily updates into non-HOT updates, each
-- writing fresh entries into every index on the table.
-- ---------------------------------------------------------------------------

-- Serves the target query: "all observations for route R at stop S in hour H".
-- stop_id leads because it is the most selective (1,659 stops vs 19 routes)
-- and because its prefixes are independently useful: (stop_id) answers
-- "everything at this stop" and (stop_id, route_id) answers "this route at
-- this stop, all day" without needing a second index.
--
-- Tradeoff: a route-first query ("route 80 everywhere at 8am") cannot use this
-- index and falls back to a partition scan. Accepted -- the product is
-- stop-centric. Add (route_id, scheduled_hour_local) only if that query shows
-- up in practice, and weigh it against the write cost described above.
create index if not exists sto_stop_route_hour_idx
  on stop_time_observations (stop_id, route_id, scheduled_hour_local);

-- Supports the nightly rollup, which scans one service_date at a time, and
-- lets the retention job verify a partition is rolled up before dropping it.
create index if not exists sto_service_date_idx
  on stop_time_observations (service_date);

-- ---------------------------------------------------------------------------
-- PARTITIONING
--
-- Weekly range partitions on service_date. The reason is retention, not query
-- speed: at ~1.01M rows/week (measured from the static feed -- 171,795 stop
-- events per weekday, 80,703 Saturday, 72,605 Sunday) this table grows
-- ~970MB/month against a 500MB free tier, so old data must be evicted.
--
-- DROP TABLE on a partition is an instant catalog operation. The DELETE it
-- replaces would rewrite ~1M rows, leave dead tuples for VACUUM to reclaim,
-- and bloat both indexes -- all while competing with a worker writing ~200
-- rows/sec.
--
-- Eviction is lossless here, which is the only reason it is acceptable: the
-- raw archive is the record of record and this table is rebuildable from it.
-- Partitions are dropped at 45 days, and only AFTER the daily rollup has
-- consumed them.
--
-- Weekly rather than daily: daily would mean ~365 partitions/year, and planning
-- time grows with partition count. Weekly keeps it near 52 while still giving
-- eviction a useful granularity.
-- ---------------------------------------------------------------------------

-- Safety net. If the partition-creation job ever falls behind, inserts land
-- here instead of failing. A failed insert is unrecoverable data loss; a row
-- in the wrong partition is a chore. Monitored -- rows here mean the job broke.
create table if not exists stop_time_observations_default
  partition of stop_time_observations default;

-- ---------------------------------------------------------------------------
-- Per-poll operational record. Mirrors the structured log line so an overnight
-- failure can be diagnosed from SQL without shipping logs off the box, and so
-- the README's "current status" numbers come from data rather than memory.
-- Pruned at 30 days by scripts/partitions.ts.
-- ---------------------------------------------------------------------------
create table if not exists ingest_runs (
  id               bigserial   primary key,
  feed             text        not null,
  started_at       timestamptz not null,
  duration_ms      int         not null,
  ok               boolean     not null,
  http_status      smallint,
  -- Seconds between the feed header timestamp and our receipt of it.
  feed_age_s       int,
  feed_timestamp   timestamptz,
  payload_bytes    int,
  entities_total   int,
  entities_decoded int,
  rows_written     int,
  rows_changed     int,
  rows_skipped     int,
  attempts         smallint,
  error            text
);

create index if not exists ingest_runs_started_idx on ingest_runs (started_at desc);
create index if not exists ingest_runs_failures_idx on ingest_runs (started_at desc) where not ok;
