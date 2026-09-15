import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime: transit } = GtfsRealtimeBindings;

/**
 * Protobuf decoding for Madison Metro's TripUpdates feed.
 *
 * Pure: takes bytes, returns plain data. No network, no clock, no database, so
 * the whole thing is testable against a checked-in fixture.
 *
 * Shaped around what the feed actually contains, verified against a live
 * payload on 2026-09-15 rather than against the spec's optional fields:
 *
 *   - There is NO `delay` field, on the trip or on any stop_time_update. Only
 *     absolute epoch arrival times. Lateness must come from a schedule join.
 *   - There is NO `trip.start_date`. The service day has to be inferred.
 *   - The feed mixes entity types. That sample held 228 tripUpdate, 2 shape,
 *     1 stop and 2 tripModifications entities, so a decoder that assumes every
 *     entity is a tripUpdate will throw or silently drop data.
 *   - 9 of 228 tripUpdates had no trip_id at all, carrying
 *     modifiedTrip.affectedTripId instead.
 */

/** GTFS-RT StopTimeUpdate.ScheduleRelationship, native enum values. */
export const StopScheduleRelationship = {
  Scheduled: 0,
  Skipped: 1,
  NoData: 2,
  Unscheduled: 3,
} as const;

export interface DecodedStopUpdate {
  stopSequence: number;
  stopId: string;
  scheduleRelationship: number;
  /** Epoch ms, or null when the feed gave no arrival for this stop. */
  arrivalMs: number | null;
  departureMs: number | null;
}

export interface DecodedTripUpdate {
  entityId: string;
  /**
   * The trip this update is for. For a modified (detour) trip this is the
   * borrowed affectedTripId, and `isModified` is true -- the pair is what
   * disambiguates it from the unmodified trip of the same id, which can be
   * live in the same feed.
   */
  tripId: string;
  isModified: boolean;
  modificationsId: string | null;
  routeId: string;
  vehicleId: string | null;
  tripTimestampMs: number | null;
  stops: DecodedStopUpdate[];
}

export interface DecodedFeed {
  headerTimestampMs: number;
  gtfsRealtimeVersion: string;
  incrementality: string;
  tripUpdates: DecodedTripUpdate[];
  /** Census of every entity kind seen, including the ones we do not ingest. */
  entityCounts: Record<string, number>;
  entityTotal: number;
  /** tripUpdates that carried neither a trip_id nor an affectedTripId. */
  unidentifiableTrips: number;
}

export class FeedDecodeError extends Error {
  override readonly name = "FeedDecodeError";
}

const toMs = (seconds: number | null | undefined): number | null =>
  seconds === null || seconds === undefined ? null : seconds * 1000;

/**
 * Decode a GTFS-RT FeedMessage.
 *
 * @throws FeedDecodeError when the payload is not a parseable FeedMessage.
 *   Callers treat this like a network failure: log it, keep the raw bytes in
 *   the archive, and try again on the next poll. A malformed payload must never
 *   take the worker down.
 */
export function decodeTripUpdatesFeed(payload: Uint8Array): DecodedFeed {
  let message: unknown;
  try {
    message = transit.FeedMessage.toObject(
      transit.FeedMessage.decode(payload),
      { longs: Number, enums: String, defaults: false },
    );
  } catch (cause) {
    throw new FeedDecodeError(
      `could not decode FeedMessage (${payload.byteLength} bytes): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  const feed = message as {
    header?: {
      timestamp?: number;
      gtfsRealtimeVersion?: string;
      incrementality?: string;
    };
    entity?: unknown[];
  };

  const headerTimestamp = feed.header?.timestamp;
  if (typeof headerTimestamp !== "number") {
    throw new FeedDecodeError("feed header is missing a timestamp");
  }

  const entities = Array.isArray(feed.entity) ? feed.entity : [];
  const entityCounts: Record<string, number> = {};
  const tripUpdates: DecodedTripUpdate[] = [];
  let unidentifiableTrips = 0;

  for (const raw of entities) {
    const entity = raw as Record<string, unknown> & { id?: string };

    // Census by payload kind rather than by assuming tripUpdate. `shape`,
    // `stop` and `tripModifications` all appear in this feed.
    for (const key of Object.keys(entity)) {
      if (key === "id" || key === "isDeleted") continue;
      entityCounts[key] = (entityCounts[key] ?? 0) + 1;
    }

    const tripUpdate = entity["tripUpdate"] as
      | {
          trip?: {
            tripId?: string;
            routeId?: string;
            modifiedTrip?: { modificationsId?: string; affectedTripId?: string };
          };
          vehicle?: { id?: string };
          timestamp?: number;
          stopTimeUpdate?: unknown[];
        }
      | undefined;
    if (tripUpdate === undefined) continue;

    const trip = tripUpdate.trip ?? {};
    const modified = trip.modifiedTrip;
    const isModified = modified !== undefined;
    const tripId = trip.tripId ?? modified?.affectedTripId;

    if (tripId === undefined || tripId === "") {
      // Nothing to key on. Counted so the per-poll summary shows it rather
      // than losing rows silently; the raw bytes remain in the archive.
      unidentifiableTrips += 1;
      continue;
    }

    const stops: DecodedStopUpdate[] = [];
    for (const rawStop of tripUpdate.stopTimeUpdate ?? []) {
      const stop = rawStop as {
        stopSequence?: number;
        stopId?: string;
        scheduleRelationship?: string | number;
        arrival?: { time?: number };
        departure?: { time?: number };
      };
      if (typeof stop.stopSequence !== "number" || stop.stopId === undefined) {
        continue;
      }
      stops.push({
        stopSequence: stop.stopSequence,
        stopId: stop.stopId,
        scheduleRelationship: normaliseStopRelationship(stop.scheduleRelationship),
        arrivalMs: toMs(stop.arrival?.time),
        departureMs: toMs(stop.departure?.time),
      });
    }

    tripUpdates.push({
      entityId: entity.id ?? "",
      tripId,
      isModified,
      modificationsId: modified?.modificationsId ?? null,
      routeId: trip.routeId ?? "",
      vehicleId: tripUpdate.vehicle?.id ?? null,
      tripTimestampMs: toMs(tripUpdate.timestamp),
      stops,
    });
  }

  return {
    headerTimestampMs: headerTimestamp * 1000,
    gtfsRealtimeVersion: feed.header?.gtfsRealtimeVersion ?? "unknown",
    incrementality: feed.header?.incrementality ?? "FULL_DATASET",
    tripUpdates,
    entityCounts,
    entityTotal: entities.length,
    unidentifiableTrips,
  };
}

/**
 * The bindings emit enum names when decoded with `enums: String`, but older
 * payloads and hand-built fixtures can carry raw numbers. Accept both.
 */
function normaliseStopRelationship(value: string | number | undefined): number {
  if (value === undefined) return StopScheduleRelationship.Scheduled;
  if (typeof value === "number") return value;
  switch (value) {
    case "SCHEDULED":
      return StopScheduleRelationship.Scheduled;
    case "SKIPPED":
      return StopScheduleRelationship.Skipped;
    case "NO_DATA":
      return StopScheduleRelationship.NoData;
    case "UNSCHEDULED":
      return StopScheduleRelationship.Unscheduled;
    default:
      return StopScheduleRelationship.Scheduled;
  }
}
