-- ===========================================================================
-- 001: GTFS static schedule.
--
-- Everything here is versioned by feed_version_id. Madison Metro republishes
-- mmt_gtfs.zip periodically (the copy loaded 2026-09-15 declares feed_version
-- S072_202608240858, valid 20260816-20261205). An observation must be compared
-- against the schedule that was actually in effect on its service_date, so we
-- never overwrite a static feed in place — we load a new version alongside.
-- ===========================================================================

create table if not exists gtfs_feed_versions (
  id                 smallserial primary key,
  feed_version       text        not null unique,
  feed_start_date    date        not null,
  feed_end_date      date        not null,
  source_url         text        not null,
  source_etag        text,
  source_last_modified text,
  sha256             text        not null,
  loaded_at          timestamptz not null default now(),
  -- Set once the load finishes. Partial loads must never be joined against.
  load_completed_at  timestamptz
);

comment on table gtfs_feed_versions is
  'One row per static GTFS zip ingested. load_completed_at is null until the load finishes; the schedule resolver ignores incomplete versions.';

create table if not exists static_routes (
  feed_version_id  smallint not null references gtfs_feed_versions(id) on delete cascade,
  route_id         text     not null,
  route_short_name text,
  route_long_name  text,
  route_type       smallint,
  route_color      text,
  primary key (feed_version_id, route_id)
);

create table if not exists static_stops (
  feed_version_id smallint not null references gtfs_feed_versions(id) on delete cascade,
  stop_id         text     not null,
  stop_code       text,
  stop_name       text,
  stop_lat        double precision,
  stop_lon        double precision,
  primary key (feed_version_id, stop_id)
);

create table if not exists static_trips (
  feed_version_id smallint not null references gtfs_feed_versions(id) on delete cascade,
  trip_id         text     not null,
  route_id        text     not null,
  service_id      text     not null,
  trip_headsign   text,
  direction_id    smallint,
  block_id        text,
  shape_id        text,
  primary key (feed_version_id, trip_id)
);

create index if not exists static_trips_service_idx
  on static_trips (feed_version_id, service_id);

-- 603,662 rows in the 2026-08-24 feed. This is the table the schedule
-- resolver hits on every observation, so it is loaded via COPY and its
-- primary key is exactly the resolver's lookup key.
create table if not exists static_stop_times (
  feed_version_id smallint not null references gtfs_feed_versions(id) on delete cascade,
  trip_id         text     not null,
  stop_sequence   smallint not null,
  stop_id         text     not null,
  -- Seconds since the start of the service day, NOT a clock time.
  -- GTFS permits times past 24:00:00 for trips that run past midnight; the
  -- 2026-08-24 feed has 3,827 such rows. Storing an int sidesteps the whole
  -- problem: 25:10:00 is simply 90600.
  arrival_s       int      not null,
  departure_s     int      not null,
  -- timepoint=0 means the scheduled time is INTERPOLATED between timepoints.
  -- 82.8% of rows are interpolated, so delay at those stops is measured
  -- against an estimate. Kept so analysis can weight or filter by it.
  timepoint       boolean  not null default false,
  pickup_type     smallint,
  drop_off_type   smallint,
  primary key (feed_version_id, trip_id, stop_sequence)
);

create table if not exists static_calendar (
  feed_version_id smallint not null references gtfs_feed_versions(id) on delete cascade,
  service_id      text     not null,
  monday          boolean  not null,
  tuesday         boolean  not null,
  wednesday       boolean  not null,
  thursday        boolean  not null,
  friday          boolean  not null,
  saturday        boolean  not null,
  sunday          boolean  not null,
  start_date      date     not null,
  end_date        date     not null,
  primary key (feed_version_id, service_id)
);

create table if not exists static_calendar_dates (
  feed_version_id smallint not null references gtfs_feed_versions(id) on delete cascade,
  service_id      text     not null,
  date            date     not null,
  -- 1 = service added on this date, 2 = service removed on this date.
  exception_type  smallint not null,
  primary key (feed_version_id, service_id, date)
);

create index if not exists static_calendar_dates_date_idx
  on static_calendar_dates (feed_version_id, date);
