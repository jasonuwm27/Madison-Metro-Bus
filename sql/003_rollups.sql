-- ===========================================================================
-- 003: Rollups.
--
-- Raw observations are evicted at 45 days. These two tables are what survives,
-- so they must carry enough to answer questions nobody has asked yet.
--
-- WHY sum_delay AND sum_delay_sq
-- n, sum, sum_sq, min and max are ALGEBRAIC aggregates: the value for a range
-- can be computed from the values of its parts. Given those five columns, any
-- arbitrary date range yields an exact mean and an exact standard deviation
-- without touching raw data:
--     mean  = sum_delay / n
--     var   = sum_delay_sq / n - mean^2
-- That is the whole reason sum_delay_sq is stored rather than a precomputed
-- stddev, which would not compose.
--
-- Percentiles are HOLISTIC: p50 over a month is NOT derivable from thirty
-- daily p50s. They are therefore computed directly from raw at each level.
--
-- ORDERING CONSTRAINT (load-bearing)
-- Monthly percentiles must be computed from RAW observations, so the monthly
-- rollup for month M must run before M's partitions age past the 45-day drop.
-- A month is at most 31 days old when it closes, which leaves 14 days of slack.
-- scripts/partitions.ts refuses to drop a partition whose month has not been
-- rolled up, so the constraint is enforced rather than merely documented.
--
-- The pct_late_* columns are stored despite being derivable because "late by
-- 4+ minutes X% of the time" is the product's headline number, and recomputing
-- it from raw after eviction would be impossible.
-- ===========================================================================

create table if not exists rollup_daily (
  service_date     date     not null,
  route_id         text     not null,
  stop_id          text     not null,
  hour_of_day      smallint not null,
  -- Weekday=0, Saturday=1, Sunday=2. Functionally determined by service_date
  -- and so redundant in this key, but kept in the key to give rollup_daily and
  -- rollup_monthly identical shapes -- which lets a single query UNION ALL
  -- across the 90-day boundary without a column list per side.
  day_type         smallint not null,

  n                int      not null,
  sum_delay        bigint   not null,
  -- Max plausible |delay| is ~2h => 5.2e7 per row; bigint overflows only past
  -- ~1.8e11 rows in one bucket. Safe, and 8 bytes against numeric's variable
  -- width plus arithmetic cost.
  sum_delay_sq     bigint   not null,
  min_delay        int      not null,
  max_delay        int      not null,
  p50_delay        int      not null,
  p90_delay        int      not null,
  -- Headline reliability numbers, computed while raw is still available.
  n_late_240       int      not null,
  n_late_300       int      not null,
  n_early_60       int      not null,

  computed_at      timestamptz not null default now(),
  primary key (service_date, route_id, stop_id, hour_of_day, day_type)
);

create index if not exists rollup_daily_stop_route_hour_idx
  on rollup_daily (stop_id, route_id, hour_of_day);

-- Permanent. Same shape, first-of-month as the period key.
create table if not exists rollup_monthly (
  month            date     not null,
  route_id         text     not null,
  stop_id          text     not null,
  hour_of_day      smallint not null,
  day_type         smallint not null,

  n                int      not null,
  sum_delay        bigint   not null,
  sum_delay_sq     bigint   not null,
  min_delay        int      not null,
  max_delay        int      not null,
  p50_delay        int      not null,
  p90_delay        int      not null,
  n_late_240       int      not null,
  n_late_300       int      not null,
  n_early_60       int      not null,

  computed_at      timestamptz not null default now(),
  primary key (month, route_id, stop_id, hour_of_day, day_type)
);

create index if not exists rollup_monthly_stop_route_hour_idx
  on rollup_monthly (stop_id, route_id, hour_of_day);

-- ---------------------------------------------------------------------------
-- WHICH ROWS COUNT
--
-- A row enters a rollup only if all of the following hold. The filter lives in
-- one place so daily and monthly can never disagree about what "an
-- observation" means.
--
--   scheduled_source = 1     -- matched the schedule actually in effect.
--                               Excludes unmatched rows (which would otherwise
--                               read as delay 0) and detour trips, whose static
--                               schedule describes the pre-detour routing.
--   schedule_relationship = 0 -- SCHEDULED only. A SKIPPED stop has no arrival
--                               to be late for; NO_DATA has no prediction.
--   delay_seconds is not null
--   abs(delay_seconds) < 7200 -- guards against a mis-derived service_date
--                                producing a 24-hour "delay". A genuine 2-hour
--                                bus delay is rarer than a date bug.
-- ---------------------------------------------------------------------------
create or replace function observation_is_countable(
  p_scheduled_source smallint,
  p_schedule_relationship smallint,
  p_delay_seconds int
) returns boolean
language sql immutable parallel safe as $$
  select p_scheduled_source = 1
     and p_schedule_relationship = 0
     and p_delay_seconds is not null
     and abs(p_delay_seconds) < 7200
$$;

-- ---------------------------------------------------------------------------
-- Daily rollup. Idempotent: re-running for a date replaces that date's rows.
-- ---------------------------------------------------------------------------
create or replace function build_rollup_daily(p_service_date date)
returns bigint
language plpgsql as $$
declare
  v_rows bigint;
begin
  delete from rollup_daily where service_date = p_service_date;

  insert into rollup_daily (
    service_date, route_id, stop_id, hour_of_day, day_type,
    n, sum_delay, sum_delay_sq, min_delay, max_delay,
    p50_delay, p90_delay, n_late_240, n_late_300, n_early_60
  )
  select
    o.service_date,
    o.route_id,
    o.stop_id,
    o.scheduled_hour_local,
    o.day_type,
    count(*),
    sum(o.delay_seconds::bigint),
    sum(o.delay_seconds::bigint * o.delay_seconds::bigint),
    min(o.delay_seconds),
    max(o.delay_seconds),
    (percentile_cont(0.5) within group (order by o.delay_seconds))::int,
    (percentile_cont(0.9) within group (order by o.delay_seconds))::int,
    count(*) filter (where o.delay_seconds >= 240),
    count(*) filter (where o.delay_seconds >= 300),
    count(*) filter (where o.delay_seconds <= -60)
  from stop_time_observations o
  where o.service_date = p_service_date
    and o.scheduled_hour_local is not null
    and o.day_type is not null
    and observation_is_countable(
          o.scheduled_source, o.schedule_relationship, o.delay_seconds)
  group by o.service_date, o.route_id, o.stop_id,
           o.scheduled_hour_local, o.day_type;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- Monthly rollup, computed from RAW so percentiles are exact. p_month is any
-- date within the target month. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function build_rollup_monthly(p_month date)
returns bigint
language plpgsql as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_rows  bigint;
begin
  delete from rollup_monthly where month = v_start;

  insert into rollup_monthly (
    month, route_id, stop_id, hour_of_day, day_type,
    n, sum_delay, sum_delay_sq, min_delay, max_delay,
    p50_delay, p90_delay, n_late_240, n_late_300, n_early_60
  )
  select
    v_start,
    o.route_id,
    o.stop_id,
    o.scheduled_hour_local,
    o.day_type,
    count(*),
    sum(o.delay_seconds::bigint),
    sum(o.delay_seconds::bigint * o.delay_seconds::bigint),
    min(o.delay_seconds),
    max(o.delay_seconds),
    (percentile_cont(0.5) within group (order by o.delay_seconds))::int,
    (percentile_cont(0.9) within group (order by o.delay_seconds))::int,
    count(*) filter (where o.delay_seconds >= 240),
    count(*) filter (where o.delay_seconds >= 300),
    count(*) filter (where o.delay_seconds <= -60)
  from stop_time_observations o
  where o.service_date >= v_start
    and o.service_date <  v_end
    and o.scheduled_hour_local is not null
    and o.day_type is not null
    and observation_is_countable(
          o.scheduled_source, o.schedule_relationship, o.delay_seconds)
  group by o.route_id, o.stop_id, o.scheduled_hour_local, o.day_type;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
