import type { DecodedFeed } from "./decode.js";
import { StopScheduleRelationship } from "./decode.js";
import {
  dayTypeOf,
  localDateString,
  localHour,
  resolveServiceDate,
  scheduledInstantMs,
} from "../util/time.js";

/**
 * Turns a decoded feed into observation rows.
 *
 * Pure and synchronous. The schedule it needs is passed in as an already-loaded
 * index rather than being fetched here, which keeps the whole transform
 * testable with an in-memory fake and keeps database round-trips out of the
 * hot path.
 */

/** Provenance of scheduled_arrival. Mirrors the column comment in 002. */
export const ScheduledSource = {
  /** No static stop_time matched. delay_seconds will be null. */
  Unmatched: 0,
  /** Matched the schedule in effect on the resolved service date. */
  StaticExact: 1,
  /**
   * Matched syntactically, but this is a detour trip, so the static row
   * describes the PRE-detour routing. The stop may not even be on the
   * modified route. Kept, but flagged, so analysis can exclude it by
   * provenance rather than by guesswork.
   */
  StaticPreModification: 2,
} as const;

export interface TripSchedule {
  feedVersionId: number;
  /** Service dates this trip actually runs, from calendar + calendar_dates. */
  activeDates: ReadonlySet<string>;
  /** stop_sequence -> seconds since service day start. */
  arrivalSecondsByStopSequence: ReadonlyMap<number, number>;
}

export interface ScheduleIndex {
  get(tripId: string): TripSchedule | undefined;
}

export interface ObservationRow {
  serviceDate: string;
  tripId: string;
  stopSequence: number;
  isModified: boolean;
  routeId: string;
  stopId: string;
  scheduledHourLocal: number | null;
  dayType: number | null;
  scheduledArrivalMs: number | null;
  scheduledSource: number;
  feedVersionId: number | null;
  observedArrivalMs: number;
  scheduleRelationship: number;
  vehicleId: string | null;
  /** Feed header time; becomes first_seen_at / last_seen_at. */
  observedAtMs: number;
}

export interface TransformStats {
  tripUpdates: number;
  modifiedTrips: number;
  stopUpdatesTotal: number;
  rowsEmitted: number;
  /** Had a departure but no arrival -- almost always a trip's origin stop. */
  skippedDepartureOnly: number;
  /** NO_DATA: the feed explicitly has no prediction for this stop. */
  skippedNoData: number;
  skippedNoTime: number;
  /** Trip id absent from the static schedule entirely. */
  unmatchedTrips: number;
  /** Trip matched, but this stop_sequence was not in its static stop_times. */
  unmatchedStops: number;
  /** In static, but the service date could not be anchored to the schedule. */
  unresolvedServiceDate: number;
  /** Duplicate primary keys collapsed within a single poll. */
  duplicateKeys: number;
}

export function transformFeed(
  feed: DecodedFeed,
  schedule: ScheduleIndex,
  tz: string,
): { rows: ObservationRow[]; stats: TransformStats } {
  const stats: TransformStats = {
    tripUpdates: feed.tripUpdates.length,
    modifiedTrips: 0,
    stopUpdatesTotal: 0,
    rowsEmitted: 0,
    skippedDepartureOnly: 0,
    skippedNoData: 0,
    skippedNoTime: 0,
    unmatchedTrips: 0,
    unmatchedStops: 0,
    unresolvedServiceDate: 0,
    duplicateKeys: 0,
  };

  // Keyed by the observation primary key. Postgres refuses an ON CONFLICT DO
  // UPDATE that touches the same row twice in one statement, so a duplicate
  // inside a single poll would abort the entire batch -- losing the whole
  // poll, not just the duplicate. Collapsing here makes that impossible.
  //
  // Duplicates are not hypothetical. Metro publishes a detoured trip as TWO
  // entities: a planned modified itinerary (no trip_id, every stop, no vehicle)
  // and a live vehicle update (real trip_id, remaining stops only, vehicle
  // attached). In the 2026-09-15 sample, trips 3856020 and 4314020 each
  // appeared this way, overlapping on 46 stop sequences and disagreeing by
  // about a second. Resolution is by `preferenceOf` below.
  const byKey = new Map<string, { row: ObservationRow; preference: number }>();

  for (const trip of feed.tripUpdates) {
    if (trip.isModified) stats.modifiedTrips += 1;

    const tripSchedule = schedule.get(trip.tripId);
    if (tripSchedule === undefined) stats.unmatchedTrips += 1;

    const resolution = resolveTripServiceDate(trip, tripSchedule, feed, tz);
    if (!resolution.anchored && tripSchedule !== undefined) {
      stats.unresolvedServiceDate += 1;
    }
    const serviceDate = resolution.serviceDate;
    const dayType = dayTypeOf(serviceDate);

    // Only trust the schedule when the service date was actually anchored
    // against it. Resolving to a fallback date and then looking up a scheduled
    // time on that date would manufacture a delay out of a guess.
    const usableSchedule = resolution.anchored ? tripSchedule : undefined;

    for (const stop of trip.stops) {
      stats.stopUpdatesTotal += 1;

      if (stop.scheduleRelationship === StopScheduleRelationship.NoData) {
        stats.skippedNoData += 1;
        continue;
      }

      // Arrival only, deliberately. 149 of 6,035 stop updates in the sample
      // carried a departure but no arrival, and they are trip origin stops.
      // Comparing a departure against a scheduled ARRIVAL would silently mix
      // two different quantities into one delay column. Those rows remain in
      // the raw archive if they are ever wanted.
      if (stop.arrivalMs === null) {
        if (stop.departureMs !== null) stats.skippedDepartureOnly += 1;
        else stats.skippedNoTime += 1;
        continue;
      }

      const scheduledSeconds =
        usableSchedule?.arrivalSecondsByStopSequence.get(stop.stopSequence);

      let scheduledArrivalMs: number | null = null;
      let scheduledSource: number = ScheduledSource.Unmatched;
      let feedVersionId: number | null = null;
      let scheduledHourLocal: number | null = null;

      if (usableSchedule !== undefined && scheduledSeconds !== undefined) {
        scheduledArrivalMs = scheduledInstantMs(serviceDate, scheduledSeconds, tz);
        scheduledHourLocal = localHour(scheduledArrivalMs, tz);
        feedVersionId = usableSchedule.feedVersionId;
        scheduledSource = trip.isModified
          ? ScheduledSource.StaticPreModification
          : ScheduledSource.StaticExact;
      } else if (usableSchedule !== undefined) {
        // The trip is scheduled, but this particular stop_sequence is not in
        // its static stop_times -- an added stop, or a sequence renumbering
        // between static feed versions.
        stats.unmatchedStops += 1;
      }

      const row: ObservationRow = {
        serviceDate,
        tripId: trip.tripId,
        stopSequence: stop.stopSequence,
        isModified: trip.isModified,
        routeId: trip.routeId,
        stopId: stop.stopId,
        scheduledHourLocal,
        dayType: scheduledArrivalMs === null ? null : dayType,
        scheduledArrivalMs,
        scheduledSource,
        feedVersionId,
        observedArrivalMs: stop.arrivalMs,
        scheduleRelationship: stop.scheduleRelationship,
        vehicleId: trip.vehicleId,
        observedAtMs: feed.headerTimestampMs,
      };

      const key = `${serviceDate}|${trip.tripId}|${stop.stopSequence}|${
        trip.isModified ? 1 : 0
      }`;
      const preference = preferenceOf(trip);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, { row, preference });
      } else {
        stats.duplicateKeys += 1;
        // >= so that, all else equal, the later entity in feed order wins.
        if (preference >= existing.preference) byKey.set(key, { row, preference });
      }
    }
  }

  const rows = [...byKey.values()].map((entry) => entry.row);
  stats.rowsEmitted = rows.length;
  return { rows, stats };
}

/**
 * Precedence when two entities describe the same (trip, stop).
 *
 * A vehicle-bearing update outranks everything else: it is a real bus
 * reporting its own progress, whereas a vehicle-less entity is a planned
 * itinerary for a trip that may not have started. Failing that, the fresher
 * trip timestamp wins.
 *
 * Because precedence is applied per stop rather than per entity, the merge
 * takes the best of both: for trip 4314020 the live vehicle entity supplies
 * stop sequences 30-42, while the planned entity still supplies 1-29 and
 * 43-59, which the vehicle entity had already dropped.
 */
function preferenceOf(trip: DecodedFeed["tripUpdates"][number]): number {
  const hasVehicle = trip.vehicleId !== null ? 1 : 0;
  // Seconds keep this comfortably inside a safe integer.
  const freshness = Math.floor((trip.tripTimestampMs ?? 0) / 1000);
  return hasVehicle * 1e12 + freshness;
}

/**
 * Decide which service day a trip update belongs to.
 *
 * The feed gives no start_date, so this matches the trip's observed times
 * against its scheduled times across candidate dates. The first stop with both
 * a static schedule entry and an observed arrival anchors the whole trip, and
 * every stop then shares that result -- a trip cannot straddle two service
 * days, and resolving per-stop would let a late bus disagree with itself
 * across midnight.
 *
 * `anchored` reports whether the date was established against the schedule or
 * merely assumed from the feed clock. Nothing is ever dropped for want of a
 * service date: an unanchored trip is still recorded under the feed's local
 * date, with its schedule deliberately withheld so the row reads as unmatched
 * instead of carrying a delay computed against a guessed day. Losing an
 * observation is permanent; an unmatched row can be re-derived from the
 * archive once the static feed catches up.
 */
function resolveTripServiceDate(
  trip: DecodedFeed["tripUpdates"][number],
  tripSchedule: TripSchedule | undefined,
  feed: DecodedFeed,
  tz: string,
): { serviceDate: string; anchored: boolean } {
  const fallback = {
    serviceDate: localDateString(feed.headerTimestampMs, tz),
    anchored: false,
  };
  if (tripSchedule === undefined) return fallback;

  for (const stop of trip.stops) {
    if (stop.arrivalMs === null) continue;
    const scheduledSeconds = tripSchedule.arrivalSecondsByStopSequence.get(
      stop.stopSequence,
    );
    if (scheduledSeconds === undefined) continue;

    const resolved = resolveServiceDate({
      observedMs: stop.arrivalMs,
      scheduledSecondsIntoDay: scheduledSeconds,
      tz,
      runsOn: (date) => tripSchedule.activeDates.has(date),
    });
    if (resolved !== null) return { serviceDate: resolved, anchored: true };
  }

  // Either no reported stop appears in the static schedule, or the trip runs
  // on none of the candidate dates -- a stale trip_id, or a date outside the
  // loaded feed's validity window.
  return fallback;
}
