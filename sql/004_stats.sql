-- ===========================================================================
-- 004: stop_route_hour_stats -- the serving tier.
--
-- rollup_daily answers "what happened on 2026-09-17"; the website asks "what
-- usually happens". Spanning weeks of daily buckets on every page view would
-- re-aggregate the same ~90 rows per cell repeatedly, so this precomputes the
-- answer over a trailing window: one row per
-- (stop_id, route_id, hour_of_day, day_type).
--
-- Size: 1,659 stops x ~3 routes x 24 hours x 3 day types is a theoretical
-- ~360k, but only combinations that actually run exist. Measured on two days
-- of data: 14,937 real cells. A full schedule cycle will be larger but stays
-- well inside a table that is trivially indexed and fully cacheable.
--
-- WHY THIS IS BUILDABLE WITHOUT TOUCHING RAW
-- n, sum_delay and sum_delay_sq are ALGEBRAIC: they sum across daily buckets,
-- so exact mean and variance for any window come from rollup_daily alone. That
-- is the entire reason sum_delay_sq is stored rather than a precomputed stddev
-- (which would not compose). Percentiles are holistic and cannot be summed, so
-- p50/p90 here are *approximated* from the daily values -- see the column
-- comments. The headline metric is a proportion, not a percentile, so this
-- costs nothing that the product actually needs.
-- ===========================================================================

create table if not exists stop_route_hour_stats (
  stop_id           text     not null,
  route_id          text     not null,
  hour_of_day       smallint not null,
  -- 0=weekday, 1=Saturday, 2=Sunday.
  day_type          smallint not null,

  -- ---- algebraic aggregates, exact -------------------------------------
  n                 int      not null,
  sum_delay         bigint   not null,
  sum_delay_sq      bigint   not null,
  min_delay         int      not null,
  max_delay         int      not null,

  -- ---- headline counts, exact ------------------------------------------
  n_late_240        int      not null,
  n_late_300        int      not null,
  n_early_60        int      not null,

  -- ---- derived, stored so the exporter does no arithmetic --------------
  mean_delay        real     not null,
  -- Population stddev from sum_delay_sq. Guarded against the tiny negative
  -- values floating point can produce when variance is ~0.
  stddev_delay      real     not null,
  pct_late_240      real     not null,

  -- ---- approximated ----------------------------------------------------
  -- Weighted mean of the daily p50/p90. A percentile of percentiles is NOT
  -- the true percentile, and with n<5 per day it can be well off. Kept
  -- because it is a useful shape hint, never as a headline number. The true
  -- value needs raw, which is evicted at 400 days.
  p50_delay_approx  int      not null,
  p90_delay_approx  int      not null,

  -- ---- provenance -------------------------------------------------------
  first_service_date date    not null,
  last_service_date  date    not null,
  service_days       smallint not null,
  computed_at       timestamptz not null default now(),

  primary key (stop_id, route_id, hour_of_day, day_type)
);

comment on table stop_route_hour_stats is
  'Serving tier for the website. Rebuilt nightly from rollup_daily over a trailing window. Never read by the collector.';

-- The PK already serves "one route at one stop" (exact match) and "all routes
-- at a stop" (leading prefix). Only the route-first query needs its own index.
create index if not exists srhs_route_hour_idx
  on stop_route_hour_stats (route_id, hour_of_day, day_type);

-- ---------------------------------------------------------------------------
-- Rebuild over a trailing window.
--
-- Idempotent: truncate-and-rebuild rather than upsert, because the window
-- slides and cells that age out must DISAPPEAR. An upsert would leave stale
-- rows for stops that no longer have recent data, and the site would show
-- numbers derived from a window it is not claiming.
--
-- p_window_days NULL means "all history", which is correct while the dataset
-- is young -- suppressing data we have in order to honour a 90-day window we
-- have not lived through yet would be silly.
-- ---------------------------------------------------------------------------
create or replace function build_stop_route_hour_stats(p_window_days int default null)
returns bigint
language plpgsql as $$
declare
  v_rows bigint;
  v_cutoff date := case when p_window_days is null then date '1900-01-01'
                        else current_date - p_window_days end;
begin
  -- Build into a temp table first so the serving table is never empty mid-run.
  -- A page view landing during the rebuild must see the old data, not nothing.
  create temp table _srhs_new on commit drop as
  select
    r.stop_id,
    r.route_id,
    r.hour_of_day,
    r.day_type,
    sum(r.n)::int                                    as n,
    sum(r.sum_delay)::bigint                         as sum_delay,
    sum(r.sum_delay_sq)::bigint                      as sum_delay_sq,
    min(r.min_delay)::int                            as min_delay,
    max(r.max_delay)::int                            as max_delay,
    sum(r.n_late_240)::int                           as n_late_240,
    sum(r.n_late_300)::int                           as n_late_300,
    sum(r.n_early_60)::int                           as n_early_60,
    (sum(r.sum_delay)::numeric / nullif(sum(r.n),0))::real as mean_delay,
    -- var = E[x^2] - E[x]^2, clamped at 0: floating point can make a
    -- genuinely-zero variance come out slightly negative, and sqrt would
    -- then produce NaN and poison the JSON export.
    sqrt(greatest(
      0,
      sum(r.sum_delay_sq)::numeric / nullif(sum(r.n),0)
        - power(sum(r.sum_delay)::numeric / nullif(sum(r.n),0), 2)
    ))::real                                         as stddev_delay,
    (100.0 * sum(r.n_late_240) / nullif(sum(r.n),0))::real as pct_late_240,
    -- n-weighted so a day with 8 observations counts more than one with 1.
    (sum(r.p50_delay::numeric * r.n) / nullif(sum(r.n),0))::int as p50_delay_approx,
    (sum(r.p90_delay::numeric * r.n) / nullif(sum(r.n),0))::int as p90_delay_approx,
    min(r.service_date)                              as first_service_date,
    max(r.service_date)                              as last_service_date,
    count(distinct r.service_date)::smallint         as service_days
  from rollup_daily r
  where r.service_date >= v_cutoff
    -- Excludes days with a diagnosed collection gap (VM reboot, agency feed
    -- outage) from the reliability figures. Those days measure how well the
    -- COLLECTOR worked, not how well the BUSES ran, and mixing the two would
    -- let a bad-collection day masquerade as bad service.
    and not exists (
      select 1 from day_coverage dc
      where dc.service_date = r.service_date and dc.known_gap_reason is not null
    )
  group by r.stop_id, r.route_id, r.hour_of_day, r.day_type;

  delete from stop_route_hour_stats;
  insert into stop_route_hour_stats (
    stop_id, route_id, hour_of_day, day_type,
    n, sum_delay, sum_delay_sq, min_delay, max_delay,
    n_late_240, n_late_300, n_early_60,
    mean_delay, stddev_delay, pct_late_240,
    p50_delay_approx, p90_delay_approx,
    first_service_date, last_service_date, service_days
  )
  select stop_id, route_id, hour_of_day, day_type,
         n, sum_delay, sum_delay_sq, min_delay, max_delay,
         n_late_240, n_late_300, n_early_60,
         mean_delay, stddev_delay, pct_late_240,
         p50_delay_approx, p90_delay_approx,
         first_service_date, last_service_date, service_days
  from _srhs_new;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dataset-wide facts for the site's header and empty state.
--
-- A single row. The site leads with these rather than with a grid of
-- suppressed cells: while the dataset is young, "collecting since X, N
-- observations" is the honest headline and a page of "insufficient data" is
-- not.
-- ---------------------------------------------------------------------------
create or replace view dataset_summary as
select
  (select min(service_date) from rollup_daily)                  as first_service_date,
  (select max(service_date) from rollup_daily)                  as last_service_date,
  (select count(distinct service_date) from rollup_daily)       as service_days,
  (select coalesce(sum(n),0) from rollup_daily)                 as total_observations,
  (select count(distinct stop_id) from rollup_daily)            as stops_with_data,
  (select count(distinct route_id) from rollup_daily)           as routes_with_data,
  (select count(*) from stop_route_hour_stats where n >= 20)    as cells_confident,
  (select count(*) from stop_route_hour_stats where n >= 5 and n < 20) as cells_provisional,
  (select count(*) from stop_route_hour_stats where n < 5)      as cells_sparse,
  (select count(*) from stop_route_hour_stats)                  as cells_total;
