-- ===========================================================================
-- 005: Data completeness -- coverage by service date, with known gaps
-- annotated.
--
-- WHY THIS EXISTS
-- Investigation on 2026-09-22/23 found that two of the first eight collected
-- days had severe coverage gaps: 2026-09-16 (VM rebooted mid-day, archive has
-- zero shards before 12:39pm CT) and 2026-09-17 (Metro's own feed carried no
-- TripUpdates for ~4 hours overnight, confirmed by direct protobuf decode of
-- the raw archive with zero decode errors). Averaged into a naive "coverage
-- by hour of day" view, these two incidents were indistinguishable from a
-- systemic collector problem -- they produced a smooth-looking "AM rush dip"
-- that was actually two catastrophic days smeared across four perfectly
-- healthy ones. That is the lesson this table encodes structurally: coverage
-- is fundamentally a per-day fact, and any aggregate that doesn't let a bad
-- day surface on its own will hide exactly this kind of incident.
--
-- COVERAGE DEFINITION
-- scheduled stop-events = distinct (trip_id, stop_sequence) pairs the static
-- schedule says should exist on that service_date, resolved via
-- calendar + calendar_dates exceptions for that date's ACTUAL weekday
-- (derived with to_char(date, 'FMDay'), never a hand-written weekday table --
-- this session produced two separate incorrect analyses from manual
-- day-of-week mapping before switching to this).
-- observed stop-events = rows in stop_time_observations for that service_date
-- matched to a scheduled (trip_id, stop_sequence) pair by exact identity, not
-- by a coarser date+hour aggregate (an earlier aggregate-based coverage
-- calculation over/under-counted by dropping the exact join key).
--
-- KNOWN GAPS ARE DATA, NOT GUESSES
-- known_gap_reason is set by an operator (this migration seeds the two
-- confirmed 2026-09 incidents; future gaps are added the same way once
-- investigated) rather than inferred from the coverage number alone -- a low
-- coverage day with no diagnosed cause should read as "investigate this",
-- not silently inherit whatever label the last incident used.
-- ===========================================================================

create table if not exists day_coverage (
  service_date         date     not null primary key,
  scheduled_stop_events bigint  not null,
  observed_stop_events  bigint  not null,
  coverage_pct          real    not null,
  -- NULL means no diagnosed cause. Never inferred from coverage_pct alone --
  -- a low-coverage day with an empty reason is a flag to investigate, not an
  -- assumed repeat of a past incident.
  known_gap_reason      text,
  computed_at           timestamptz not null default now()
);

comment on table day_coverage is
  'Per-day scheduled-vs-observed stop-event coverage, with confirmed collection gaps annotated. Rebuilt nightly. Read by the site export and the weekly summary alert.';

-- ---------------------------------------------------------------------------
-- Rebuild coverage for a single service_date. Idempotent: replaces that
-- date's row. Preserves known_gap_reason across a rebuild (a diagnosed
-- incident does not need re-diagnosing every night just because the
-- underlying coverage number is recomputed).
-- ---------------------------------------------------------------------------
create or replace function build_day_coverage(p_service_date date)
returns void
language plpgsql as $$
declare
  v_feed_id smallint;
  v_weekday text;
  v_scheduled bigint;
  v_observed bigint;
  v_existing_reason text;
begin
  select id into v_feed_id from gtfs_feed_versions
  where load_completed_at is not null order by loaded_at desc limit 1;

  if v_feed_id is null then
    return; -- no usable static feed yet; nothing to compare against
  end if;

  v_weekday := trim(to_char(p_service_date, 'FMDay'));

  select v_existing_reason into v_existing_reason
  from day_coverage where service_date = p_service_date;

  -- Single CTE chain producing both counts, so "scheduled" and "observed"
  -- are matched by the exact same (trip_id, stop_sequence) join key -- an
  -- earlier ad hoc version of this analysis used a coarser date+hour
  -- aggregate on each side independently and produced numbers that
  -- disagreed by 20+ points with this exact-match approach.
  with active_services as (
    select c.service_id
    from static_calendar c
    where c.feed_version_id = v_feed_id
      and c.start_date <= p_service_date and c.end_date >= p_service_date
      and (
        (v_weekday = 'Monday'    and c.monday)    or
        (v_weekday = 'Tuesday'   and c.tuesday)   or
        (v_weekday = 'Wednesday' and c.wednesday) or
        (v_weekday = 'Thursday'  and c.thursday)  or
        (v_weekday = 'Friday'    and c.friday)    or
        (v_weekday = 'Saturday'  and c.saturday)  or
        (v_weekday = 'Sunday'    and c.sunday)
      )
      and not exists (
        select 1 from static_calendar_dates cd
        where cd.feed_version_id = v_feed_id and cd.service_id = c.service_id
          and cd.date = p_service_date and cd.exception_type = 2
      )
    union
    select cd.service_id
    from static_calendar_dates cd
    where cd.feed_version_id = v_feed_id and cd.date = p_service_date
      and cd.exception_type = 1
  ),
  scheduled as (
    select t.trip_id, st.stop_sequence
    from active_services a
    join static_trips t on t.feed_version_id = v_feed_id and t.service_id = a.service_id
    join static_stop_times st on st.feed_version_id = v_feed_id and st.trip_id = t.trip_id
  ),
  observed as (
    select trip_id, stop_sequence from stop_time_observations
    where service_date = p_service_date
  )
  select count(*), count(o.trip_id)
  into v_scheduled, v_observed
  from scheduled s
  left join observed o on o.trip_id = s.trip_id and o.stop_sequence = s.stop_sequence;

  insert into day_coverage (service_date, scheduled_stop_events, observed_stop_events, coverage_pct, known_gap_reason)
  values (
    p_service_date, v_scheduled, v_observed,
    case when v_scheduled = 0 then 0 else round(100.0 * v_observed / v_scheduled, 1) end,
    v_existing_reason
  )
  on conflict (service_date) do update set
    scheduled_stop_events = excluded.scheduled_stop_events,
    observed_stop_events = excluded.observed_stop_events,
    coverage_pct = excluded.coverage_pct,
    computed_at = now();
    -- known_gap_reason deliberately NOT overwritten by excluded here -- the
    -- existing value was already carried into excluded via v_existing_reason
    -- above, so a fresh diagnosis is never clobbered by a plain rebuild.
end;
$$;

-- ---------------------------------------------------------------------------
-- Rebuild coverage for every service_date with observations, skipping the
-- current (incomplete) day -- coverage for a day still in progress is not a
-- fact yet, and a partial day would show as a false gap.
-- ---------------------------------------------------------------------------
create or replace function build_day_coverage_all()
returns int
language plpgsql as $$
declare
  v_date date;
  v_count int := 0;
begin
  for v_date in
    select distinct service_date::date from stop_time_observations
    where service_date::date < current_date
    order by 1
  loop
    perform build_day_coverage(v_date);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Seed the two confirmed 2026-09 incidents. This only ever sets
-- known_gap_reason -- never scheduled/observed/coverage_pct, which are
-- owned exclusively by build_day_coverage and would otherwise be reset to
-- the 0-placeholder below on every migration replay if a rebuild had
-- already run first.
insert into day_coverage (service_date, scheduled_stop_events, observed_stop_events, coverage_pct, known_gap_reason)
values
  ('2026-09-15', 0, 0, 0, 'First day of collection; the worker started partway through the service day, not at midnight.'),
  ('2026-09-16', 0, 0, 0, 'VM rebooted; no archive shards exist before 12:39pm CT that day. Collector was not running, not malfunctioning.'),
  ('2026-09-17', 0, 0, 0, 'Metro''s TripUpdates feed carried zero trip entities for ~4 hours overnight (confirmed by direct protobuf decode of the raw archive, zero decode errors). Agency-side outage, not a collection failure.')
on conflict (service_date) do update set known_gap_reason = excluded.known_gap_reason
where day_coverage.known_gap_reason is null or day_coverage.known_gap_reason = excluded.known_gap_reason;
