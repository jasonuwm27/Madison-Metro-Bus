import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeTripUpdatesFeed, FeedDecodeError } from "../src/gtfsrt/decode.js";

/**
 * Decoded against a real Madison Metro payload captured 2026-09-15 11:06:06Z.
 *
 * These assertions intentionally pin the quirks that drove the schema. If Metro
 * changes their feed, these tests should fail -- that failure is the signal
 * that the schema's assumptions need revisiting, not a nuisance to be relaxed.
 */

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

const PAYLOAD = fixture("trip-updates-2026-09-15T110606Z.pb");
const PAYLOAD_LATER = fixture("trip-updates-2026-09-15T110738Z.pb");

describe("decodeTripUpdatesFeed", () => {
  const feed = decodeTripUpdatesFeed(PAYLOAD);

  it("reads the feed header", () => {
    expect(feed.gtfsRealtimeVersion).toBe("2.0");
    expect(feed.incrementality).toBe("FULL_DATASET");
    expect(feed.headerTimestampMs).toBe(1_789_488_388_000);
  });

  it("decodes every tripUpdate that carries an identifier", () => {
    // 228 tripUpdate entities; all 228 are identifiable (219 by trip_id,
    // 9 by modifiedTrip.affectedTripId).
    expect(feed.tripUpdates).toHaveLength(228);
    expect(feed.unidentifiableTrips).toBe(0);
  });

  it("counts non-tripUpdate entities instead of choking on them", () => {
    // The feed is not homogeneous. A decoder assuming every entity is a
    // tripUpdate would throw here or drop data silently.
    expect(feed.entityTotal).toBe(233);
    expect(feed.entityCounts).toMatchObject({
      tripUpdate: 228,
      shape: 2,
      stop: 1,
      tripModifications: 2,
    });
  });

  it("identifies modified trips, including those that also carry a trip_id", () => {
    const modified = feed.tripUpdates.filter((t) => t.isModified);
    // 11 entities carry modifiedTrip: 9 have no trip_id and are keyed by
    // affectedTripId, and 2 carry BOTH a real trip_id and modifiedTrip.
    expect(modified).toHaveLength(11);
    expect(modified.filter((t) => t.modificationsId !== null)).toHaveLength(11);
    for (const trip of modified) {
      expect(trip.tripId).not.toBe("");
      expect(trip.modificationsId).toMatch(/^trip_modifications_/);
    }
  });

  it("does not let a detour trip borrow a different trip's identity", () => {
    // Worth pinning explicitly: no modified trip's id belongs to a separate,
    // unmodified trip in the same feed. If that ever starts happening,
    // is_modified in the primary key is what keeps the two rows apart.
    const unmodified = new Set(
      feed.tripUpdates.filter((t) => !t.isModified).map((t) => t.tripId),
    );
    const collisions = feed.tripUpdates
      .filter((t) => t.isModified && unmodified.has(t.tripId))
      .map((t) => t.tripId);
    expect(collisions).toEqual([]);
  });

  it("publishes a detoured trip as two overlapping entities", () => {
    // The real duplicate-key hazard. Metro emits a planned modified itinerary
    // (no trip_id, all stops, no vehicle) alongside a live vehicle update
    // (real trip_id, remaining stops, vehicle attached) for the same trip.
    // Both are is_modified, so the primary key alone cannot separate them and
    // the transform must apply a precedence rule.
    const byTrip = new Map<string, typeof feed.tripUpdates>();
    for (const t of feed.tripUpdates.filter((x) => x.isModified)) {
      byTrip.set(t.tripId, [...(byTrip.get(t.tripId) ?? []), t]);
    }
    const doubled = [...byTrip.entries()]
      .filter(([, entities]) => entities.length > 1)
      .map(([tripId]) => tripId)
      .sort();
    expect(doubled).toEqual(["3856020", "4314020"]);

    const live = byTrip.get("4314020")?.find((t) => t.vehicleId !== null);
    const planned = byTrip.get("4314020")?.find((t) => t.vehicleId === null);
    expect(live?.vehicleId).toBe("131");
    expect(live?.stops).toHaveLength(13);
    expect(planned?.stops).toHaveLength(59);
    // They overlap, so a naive merge would write the same key twice.
    expect(live?.stops[0]?.stopSequence).toBe(30);
  });

  it("exposes no delay field, only absolute arrival times", () => {
    // The whole schedule-join design exists because of this. If Metro ever
    // starts publishing delay, this test fails and the design can be revisited.
    const stops = feed.tripUpdates.flatMap((t) => t.stops);
    expect(stops).toHaveLength(6035);
    expect(stops.filter((s) => s.arrivalMs !== null)).toHaveLength(5772);
    expect(stops.filter((s) => s.departureMs !== null)).toHaveLength(149);

    const raw = JSON.parse(JSON.stringify(feed.tripUpdates)) as unknown;
    expect(JSON.stringify(raw)).not.toContain('"delay"');
  });

  it("records the NO_DATA stops that carry no prediction at all", () => {
    const noData = feed.tripUpdates
      .flatMap((t) => t.stops)
      .filter((s) => s.scheduleRelationship === 2);
    expect(noData).toHaveLength(114);
    for (const stop of noData) {
      expect(stop.arrivalMs).toBeNull();
      expect(stop.departureMs).toBeNull();
    }
  });

  it("keeps stop keys unique per entity, but not across the feed", () => {
    // Within a single trip entity no stop_sequence repeats, so no route loops
    // back on itself and (trip_id, stop_sequence) is a sound key component.
    for (const trip of feed.tripUpdates) {
      const sequences = trip.stops.map((s) => s.stopSequence);
      expect(new Set(sequences).size).toBe(sequences.length);
    }

    // Across the feed, however, the doubled detour trips collide on exactly 46
    // keys. This is what the transform's dedupe has to absorb; left alone,
    // Postgres would reject the entire ON CONFLICT batch.
    const keys = feed.tripUpdates.flatMap((t) =>
      t.stops.map((s) => `${t.tripId}|${t.isModified}|${s.stopSequence}`),
    );
    expect(keys.length - new Set(keys).size).toBe(46);
  });

  it("decodes a second capture, showing predictions actually move", () => {
    // Guards the collapsed row model: if predictions never changed, an append
    // model would cost nothing and the upsert would be pointless complexity.
    const later = decodeTripUpdatesFeed(PAYLOAD_LATER);
    expect(later.headerTimestampMs - feed.headerTimestampMs).toBe(90_000);

    const first = new Map<string, number>();
    for (const t of feed.tripUpdates) {
      for (const s of t.stops) {
        if (s.arrivalMs !== null) first.set(`${t.tripId}|${s.stopSequence}`, s.arrivalMs);
      }
    }
    let shared = 0;
    let changed = 0;
    for (const t of later.tripUpdates) {
      for (const s of t.stops) {
        const previous = first.get(`${t.tripId}|${s.stopSequence}`);
        if (previous === undefined || s.arrivalMs === null) continue;
        shared += 1;
        if (s.arrivalMs !== previous) changed += 1;
      }
    }
    expect(shared).toBeGreaterThan(4000);
    expect(changed / shared).toBeGreaterThan(0.2);
  });

  it("throws a typed error on malformed input rather than crashing", () => {
    // The worker treats this like a network failure and keeps running.
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0a, 0x0b, 0x0c]);
    expect(() => decodeTripUpdatesFeed(garbage)).toThrow(FeedDecodeError);
  });

  it("rejects a well-formed message that has no header timestamp", () => {
    expect(() => decodeTripUpdatesFeed(new Uint8Array())).toThrow(FeedDecodeError);
  });
});
