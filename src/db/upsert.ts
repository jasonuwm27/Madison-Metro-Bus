import type { ObservationRow } from "../gtfsrt/transform.js";
import type { Sql } from "./client.js";

/**
 * Batch upsert of observations.
 *
 * IDEMPOTENCY
 * The primary key (service_date, trip_id, stop_sequence, is_modified) is the
 * idempotency key, so this is not "insert and hope" -- it is a convergent
 * write. Re-polling the same prediction, restarting the worker mid-poll, or
 * replaying an archive shard all produce the same final row. The only fields
 * that move on a repeat are the bookkeeping ones (poll_count, last_seen_at),
 * and they move monotonically.
 *
 * The update clause is written so that information is only ever ADDED:
 *   - observed_arrival takes the newest prediction, because the newest
 *     prediction is the best estimate of the true arrival, and the last one
 *     before the stop disappears from the feed is the arrival.
 *   - min/max widen but never narrow.
 *   - a schedule match can fill in a previously unmatched row, but an
 *     unmatched poll can never erase a match that was already established.
 *     Without the COALESCE guards, one poll arriving before the static loader
 *     finished would blank out schedule data for the whole day.
 *   - vehicle_id is filled in but never cleared, because Metro's planned-trip
 *     entities carry no vehicle while the live ones do.
 *
 * SHAPE
 * The rows are passed as parallel arrays and expanded with UNNEST rather than
 * as a multi-row VALUES list. A poll carries ~5,700 rows across 14 columns,
 * which as bind parameters would be ~80,000 -- well past Postgres's 65,535
 * parameter ceiling, so a VALUES form would have to be chunked and would fail
 * abruptly the first time a busy afternoon pushed it over the line. UNNEST
 * sends 14 parameters regardless of row count.
 */
export interface UpsertResult {
  rowsWritten: number;
  rowsChanged: number;
}

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

export async function upsertObservations(
  sql: Sql,
  rows: readonly ObservationRow[],
): Promise<UpsertResult> {
  if (rows.length === 0) return { rowsWritten: 0, rowsChanged: 0 };

  const serviceDate: string[] = [];
  const tripId: string[] = [];
  const stopSequence: number[] = [];
  const isModified: boolean[] = [];
  const routeId: string[] = [];
  const stopId: string[] = [];
  const scheduledHour: (number | null)[] = [];
  const dayType: (number | null)[] = [];
  const scheduledArrival: (string | null)[] = [];
  const scheduledSource: number[] = [];
  const feedVersionId: (number | null)[] = [];
  const observedArrival: string[] = [];
  const scheduleRelationship: number[] = [];
  const vehicleId: (string | null)[] = [];
  const observedAt: string[] = [];

  for (const row of rows) {
    serviceDate.push(row.serviceDate);
    tripId.push(row.tripId);
    stopSequence.push(row.stopSequence);
    isModified.push(row.isModified);
    routeId.push(row.routeId);
    stopId.push(row.stopId);
    scheduledHour.push(row.scheduledHourLocal);
    dayType.push(row.dayType);
    scheduledArrival.push(iso(row.scheduledArrivalMs));
    scheduledSource.push(row.scheduledSource);
    feedVersionId.push(row.feedVersionId);
    observedArrival.push(new Date(row.observedArrivalMs).toISOString());
    scheduleRelationship.push(row.scheduleRelationship);
    vehicleId.push(row.vehicleId);
    observedAt.push(new Date(row.observedAtMs).toISOString());
  }

  const result = await sql<{ inserted: boolean; changed: boolean }[]>`
    insert into stop_time_observations (
      service_date, trip_id, stop_sequence, is_modified,
      route_id, stop_id, scheduled_hour_local, day_type,
      scheduled_arrival, scheduled_source, feed_version_id,
      observed_arrival, first_predicted_arrival,
      min_predicted_arrival, max_predicted_arrival,
      change_count, poll_count, first_seen_at, last_seen_at,
      schedule_relationship, vehicle_id
    )
    select
      s.service_date, s.trip_id, s.stop_sequence, s.is_modified,
      s.route_id, s.stop_id, s.scheduled_hour_local, s.day_type,
      s.scheduled_arrival, s.scheduled_source, s.feed_version_id,
      s.observed_arrival, s.observed_arrival,
      s.observed_arrival, s.observed_arrival,
      0, 1, s.observed_at, s.observed_at,
      s.schedule_relationship, s.vehicle_id
    from unnest(
      ${serviceDate}::date[],
      ${tripId}::text[],
      ${stopSequence}::smallint[],
      ${isModified}::boolean[],
      ${routeId}::text[],
      ${stopId}::text[],
      ${scheduledHour}::smallint[],
      ${dayType}::smallint[],
      ${scheduledArrival}::timestamptz[],
      ${scheduledSource}::smallint[],
      ${feedVersionId}::smallint[],
      ${observedArrival}::timestamptz[],
      ${scheduleRelationship}::smallint[],
      ${vehicleId}::text[],
      ${observedAt}::timestamptz[]
    ) as s(
      service_date, trip_id, stop_sequence, is_modified,
      route_id, stop_id, scheduled_hour_local, day_type,
      scheduled_arrival, scheduled_source, feed_version_id,
      observed_arrival, schedule_relationship, vehicle_id, observed_at
    )
    on conflict (service_date, trip_id, stop_sequence, is_modified) do update set
      observed_arrival      = excluded.observed_arrival,
      min_predicted_arrival = least(
        stop_time_observations.min_predicted_arrival, excluded.observed_arrival),
      max_predicted_arrival = greatest(
        stop_time_observations.max_predicted_arrival, excluded.observed_arrival),
      change_count = stop_time_observations.change_count + (
        case
          when stop_time_observations.observed_arrival
               is distinct from excluded.observed_arrival then 1
          else 0
        end),
      poll_count   = stop_time_observations.poll_count + 1,
      last_seen_at = greatest(
        stop_time_observations.last_seen_at, excluded.last_seen_at),
      schedule_relationship = excluded.schedule_relationship,
      vehicle_id   = coalesce(excluded.vehicle_id, stop_time_observations.vehicle_id),
      scheduled_arrival = coalesce(
        excluded.scheduled_arrival, stop_time_observations.scheduled_arrival),
      scheduled_hour_local = coalesce(
        excluded.scheduled_hour_local, stop_time_observations.scheduled_hour_local),
      day_type = coalesce(excluded.day_type, stop_time_observations.day_type),
      feed_version_id = coalesce(
        excluded.feed_version_id, stop_time_observations.feed_version_id),
      scheduled_source = case
        when excluded.scheduled_arrival is not null then excluded.scheduled_source
        else stop_time_observations.scheduled_source
      end
    returning
      (xmax = 0) as inserted,
      (stop_time_observations.change_count > 0) as changed
  `;

  return {
    rowsWritten: result.length,
    // xmax = 0 identifies a genuine INSERT, so this counts how many of the
    // batch were newly observed rather than re-reported.
    rowsChanged: result.filter((r) => r.inserted).length,
  };
}
