import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTripUpdatesFeed } from "../src/gtfsrt/decode.js";
import type { DecodedFeed } from "../src/gtfsrt/decode.js";
import {
  ScheduledSource,
  transformFeed,
} from "../src/gtfsrt/transform.js";
import type { ScheduleIndex, TripSchedule } from "../src/gtfsrt/transform.js";
import { parseGtfsTime, scheduledInstantMs } from "../src/util/time.js";

const TZ = "America/Chicago";

const PAYLOAD = readFileSync(
  fileURLToPath(
    new URL("./fixtures/trip-updates-2026-09-15T110606Z.pb", import.meta.url),
  ),
);

/** A schedule index that knows nothing -- every trip resolves as unmatched. */
const EMPTY_SCHEDULE: ScheduleIndex = { get: () => undefined };

function scheduleOf(entries: Record<string, TripSchedule>): ScheduleIndex {
  return { get: (tripId) => entries[tripId] };
}

function tripSchedule(
  stopTimes: Record<number, string>,
  activeDates: string[],
  feedVersionId = 1,
): TripSchedule {
  return {
    feedVersionId,
    activeDates: new Set(activeDates),
    arrivalSecondsByStopSequence: new Map(
      Object.entries(stopTimes).map(([seq, hhmmss]) => [
        Number(seq),
        parseGtfsTime(hhmmss),
      ]),
    ),
  };
}

function feedOf(
  tripUpdates: DecodedFeed["tripUpdates"],
  headerTimestampMs: number,
): DecodedFeed {
  return {
    headerTimestampMs,
    gtfsRealtimeVersion: "2.0",
    incrementality: "FULL_DATASET",
    tripUpdates,
    entityCounts: { tripUpdate: tripUpdates.length },
    entityTotal: tripUpdates.length,
    unidentifiableTrips: 0,
  };
}

describe("transformFeed against the live fixture", () => {
  const feed = decodeTripUpdatesFeed(PAYLOAD);
  const { rows, stats } = transformFeed(feed, EMPTY_SCHEDULE, TZ);

  it("emits one row per arrival-bearing stop, after collapsing duplicates", () => {
    expect(stats.stopUpdatesTotal).toBe(6035);
    expect(stats.skippedNoData).toBe(114);
    expect(stats.skippedDepartureOnly).toBe(149);
    // 46 stop sequences overlap between the doubled detour entities, but one
    // of them (trip 3856020, sequence 1) is departure-only in both copies and
    // is skipped before dedupe ever sees it.
    expect(stats.duplicateKeys).toBe(45);
    // 5,772 arrivals less the 45 collapsed duplicates.
    expect(stats.rowsEmitted).toBe(5727);
    expect(rows).toHaveLength(5727);
  });

  it("produces keys that Postgres will accept in one ON CONFLICT batch", () => {
    // The property that matters: a repeated key inside a single statement
    // aborts the whole batch, costing the entire poll rather than one row.
    const keys = rows.map(
      (r) => `${r.serviceDate}|${r.tripId}|${r.stopSequence}|${r.isModified}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("marks every row unmatched when no schedule is loaded", () => {
    // Crucially these rows are still KEPT. Without the static feed the worker
    // still collects; delay is simply null until a schedule exists.
    expect(rows.every((r) => r.scheduledSource === ScheduledSource.Unmatched)).toBe(
      true,
    );
    expect(rows.every((r) => r.scheduledArrivalMs === null)).toBe(true);
    expect(rows.every((r) => r.dayType === null)).toBe(true);
    expect(stats.unmatchedTrips).toBe(feed.tripUpdates.length);
  });

  it("falls back to the feed's local date when the trip is unknown", () => {
    // 1789488388 is 2026-09-15 11:06:28Z, which is 06:06 in Chicago.
    expect(new Set(rows.map((r) => r.serviceDate))).toEqual(
      new Set(["2026-09-15"]),
    );
  });

  it("prefers the vehicle-bearing entity where two entities overlap", () => {
    // Trip 4314020 is published twice: a planned itinerary covering sequences
    // 1-59 with no vehicle, and a live vehicle update covering 30-42.
    const trip = rows
      .filter((r) => r.tripId === "4314020")
      .sort((a, b) => a.stopSequence - b.stopSequence);

    const overlapping = trip.filter(
      (r) => r.stopSequence >= 30 && r.stopSequence <= 42,
    );
    expect(overlapping).toHaveLength(13);
    expect(overlapping.every((r) => r.vehicleId === "131")).toBe(true);

    // The planned entity still supplies the stops the vehicle entity dropped,
    // so the merge is a union rather than a replacement.
    const outside = trip.filter((r) => r.stopSequence < 30);
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((r) => r.vehicleId === null)).toBe(true);
    expect(trip.at(-1)?.stopSequence).toBe(59);
  });

  it("prefers the fresher entity when neither has a vehicle", () => {
    // Trip 3856020's two entities both lack a vehicle; entity 2 is one second
    // fresher than entity 70 and disagrees with it by a second at sequence 2.
    const seq2 = rows.find(
      (r) => r.tripId === "3856020" && r.stopSequence === 2,
    );
    expect(seq2?.observedArrivalMs).toBe(1_789_491_120_000);
  });

  it("flags detour trips as modified", () => {
    const modified = rows.filter((r) => r.isModified);
    expect(new Set(modified.map((r) => r.tripId)).size).toBe(9);
    expect(stats.modifiedTrips).toBe(11);
  });
});

describe("transformFeed schedule matching", () => {
  const scheduled = parseGtfsTime("08:50:00");
  const scheduledMs = scheduledInstantMs("2026-09-15", scheduled, TZ);

  const oneStop = (
    overrides: Partial<DecodedFeed["tripUpdates"][number]> = {},
    arrivalMs: number = scheduledMs,
  ): DecodedFeed["tripUpdates"] => [
    {
      entityId: "e1",
      tripId: "T1",
      isModified: false,
      modificationsId: null,
      routeId: "80",
      vehicleId: "1234",
      tripTimestampMs: scheduledMs,
      stops: [
        {
          stopSequence: 5,
          stopId: "S1",
          scheduleRelationship: 0,
          arrivalMs,
          departureMs: null,
        },
      ],
      ...overrides,
    },
  ];

  it("resolves an on-time arrival to an exact schedule match", () => {
    const { rows } = transformFeed(
      feedOf(oneStop(), scheduledMs),
      scheduleOf({ T1: tripSchedule({ 5: "08:50:00" }, ["2026-09-15"]) }),
      TZ,
    );
    const row = rows[0];
    expect(row?.scheduledSource).toBe(ScheduledSource.StaticExact);
    expect(row?.scheduledArrivalMs).toBe(scheduledMs);
    expect(row?.scheduledHourLocal).toBe(8);
    expect(row?.dayType).toBe(0);
    expect(row?.feedVersionId).toBe(1);
    expect(row?.serviceDate).toBe("2026-09-15");
  });

  it("keeps the raw observed time so delay stays derivable", () => {
    // delay_seconds is generated in Postgres from these two columns, so the
    // transform's job is to record both faithfully, not to subtract them.
    const late = scheduledMs + 260_000;
    const { rows } = transformFeed(
      feedOf(oneStop({}, late), late),
      scheduleOf({ T1: tripSchedule({ 5: "08:50:00" }, ["2026-09-15"]) }),
      TZ,
    );
    expect(rows[0]?.observedArrivalMs).toBe(late);
    expect(rows[0]?.scheduledArrivalMs).toBe(scheduledMs);
  });

  it("flags a detour trip's schedule as pre-modification", () => {
    // The static row describes the route before the detour, so the comparison
    // may be semantically wrong even though it matched by trip and sequence.
    const { rows } = transformFeed(
      feedOf(
        oneStop({ isModified: true, modificationsId: "trip_modifications_1" }),
        scheduledMs,
      ),
      scheduleOf({ T1: tripSchedule({ 5: "08:50:00" }, ["2026-09-15"]) }),
      TZ,
    );
    expect(rows[0]?.scheduledSource).toBe(
      ScheduledSource.StaticPreModification,
    );
    expect(rows[0]?.isModified).toBe(true);
    // Still has a scheduled time -- excludable by provenance, not discarded.
    expect(rows[0]?.scheduledArrivalMs).toBe(scheduledMs);
  });

  it("records an unscheduled stop as unmatched while keeping its neighbours", () => {
    // Sequence 5 anchors the trip's service date; sequence 6 is absent from
    // static, so only that row loses its schedule. A stop added mid-trip must
    // not poison the rest of the trip's observations.
    const trips = oneStop();
    trips[0]?.stops.push({
      stopSequence: 6,
      stopId: "S2",
      scheduleRelationship: 0,
      arrivalMs: scheduledMs + 60_000,
      departureMs: null,
    });
    const { rows, stats } = transformFeed(
      feedOf(trips, scheduledMs),
      scheduleOf({ T1: tripSchedule({ 5: "08:50:00" }, ["2026-09-15"]) }),
      TZ,
    );
    expect(stats.unmatchedStops).toBe(1);
    expect(rows).toHaveLength(2);

    const anchored = rows.find((r) => r.stopSequence === 5);
    const orphan = rows.find((r) => r.stopSequence === 6);
    expect(anchored?.scheduledSource).toBe(ScheduledSource.StaticExact);
    expect(orphan?.scheduledSource).toBe(ScheduledSource.Unmatched);
    expect(orphan?.scheduledArrivalMs).toBeNull();
    expect(orphan?.scheduledHourLocal).toBeNull();
    // Both still share the service date the anchoring stop established.
    expect(orphan?.serviceDate).toBe("2026-09-15");
  });

  it("keeps a trip that runs on none of the candidate dates, as unmatched", () => {
    // Never drop an observation for want of a service date -- the feed moment
    // is gone forever, whereas an unmatched row can be re-derived from the
    // archive once the static feed catches up. The schedule is withheld so the
    // row cannot report a delay measured against a guessed day.
    const { rows, stats } = transformFeed(
      feedOf(oneStop(), scheduledMs),
      scheduleOf({ T1: tripSchedule({ 5: "08:50:00" }, ["2025-01-01"]) }),
      TZ,
    );
    expect(stats.unresolvedServiceDate).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serviceDate).toBe("2026-09-15");
    expect(rows[0]?.scheduledSource).toBe(ScheduledSource.Unmatched);
    expect(rows[0]?.scheduledArrivalMs).toBeNull();
    expect(rows[0]?.observedArrivalMs).toBe(scheduledMs);
  });

  it("assigns a past-midnight trip to the previous service date", () => {
    // The end-to-end version of the service-day problem: the observation's
    // wall-clock date is the 16th, the trip belongs to the 15th.
    const lateNight = parseGtfsTime("25:10:00");
    const at = scheduledInstantMs("2026-09-15", lateNight, TZ);
    const { rows } = transformFeed(
      feedOf(oneStop({}, at), at),
      scheduleOf({ T1: tripSchedule({ 5: "25:10:00" }, ["2026-09-15"]) }),
      TZ,
    );
    expect(rows[0]?.serviceDate).toBe("2026-09-15");
    expect(rows[0]?.scheduledHourLocal).toBe(1);
    expect(rows[0]?.dayType).toBe(0);
  });

  it("skips NO_DATA and departure-only stops", () => {
    const trips: DecodedFeed["tripUpdates"] = [
      {
        entityId: "e1",
        tripId: "T1",
        isModified: false,
        modificationsId: null,
        routeId: "80",
        vehicleId: null,
        tripTimestampMs: scheduledMs,
        stops: [
          {
            stopSequence: 1,
            stopId: "S1",
            scheduleRelationship: 2,
            arrivalMs: null,
            departureMs: null,
          },
          {
            stopSequence: 2,
            stopId: "S2",
            scheduleRelationship: 0,
            arrivalMs: null,
            departureMs: scheduledMs,
          },
          {
            stopSequence: 3,
            stopId: "S3",
            scheduleRelationship: 0,
            arrivalMs: scheduledMs,
            departureMs: null,
          },
        ],
      },
    ];
    const { rows, stats } = transformFeed(
      feedOf(trips, scheduledMs),
      EMPTY_SCHEDULE,
      TZ,
    );
    expect(stats.skippedNoData).toBe(1);
    expect(stats.skippedDepartureOnly).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stopSequence).toBe(3);
  });
});
