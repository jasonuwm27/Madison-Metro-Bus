import type { ScheduleIndex, TripSchedule } from "../gtfsrt/transform.js";
import type { Logger } from "../logger.js";
import { addDays } from "../util/time.js";
import type { Sql } from "./client.js";

/**
 * Lazily-loaded static schedule, keyed by trip.
 *
 * Holding all 603,662 stop_times in memory would cost a few hundred megabytes
 * on a box that is meant to be the cheapest always-on VPS available. But a poll
 * only ever references the trips currently in service -- 228 in the sample --
 * so schedules are fetched per trip on first sight and kept for the day. That
 * is roughly 4,100 trips over a full service day, loaded a few hundred at a
 * time, which is a handful of queries per day rather than per poll.
 *
 * Service dates are precomputed per service_id from calendar and
 * calendar_dates across the feed's whole validity window. That is about 1,300
 * entries, so it is cheaper to compute once than to query per trip.
 */

interface CalendarRow {
  service_id: string;
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
  start_date: Date;
  end_date: Date;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export class ScheduleCache {
  readonly #sql: Sql;
  readonly #log: Logger;
  #feedVersionId: number | null = null;
  #activeDatesByService = new Map<string, Set<string>>();
  #trips = new Map<string, TripSchedule | null>();

  constructor(sql: Sql, logger: Logger) {
    this.#sql = sql;
    this.#log = logger;
  }

  get feedVersionId(): number | null {
    return this.#feedVersionId;
  }

  get cachedTripCount(): number {
    return this.#trips.size;
  }

  /**
   * Bind to the static feed version in effect on `onDate`.
   *
   * Falls back to the most recently loaded version when none covers the date,
   * because a worker collecting against a slightly stale schedule is far better
   * than a worker collecting nothing. Metro's current feed expires 2026-12-05,
   * and that expiry must not stop ingestion.
   */
  async initialise(onDate: string): Promise<void> {
    const [covering] = await this.#sql<{ id: number; feed_version: string }[]>`
      select id, feed_version
      from gtfs_feed_versions
      where load_completed_at is not null
        and feed_start_date <= ${onDate}::date
        and feed_end_date   >= ${onDate}::date
      order by loaded_at desc
      limit 1
    `;

    let chosen = covering;
    if (chosen === undefined) {
      const [latest] = await this.#sql<{ id: number; feed_version: string }[]>`
        select id, feed_version
        from gtfs_feed_versions
        where load_completed_at is not null
        order by loaded_at desc
        limit 1
      `;
      chosen = latest;
      if (chosen !== undefined) {
        this.#log.warn(
          { feedVersion: chosen.feed_version, onDate },
          "no static feed covers this date; using the most recent one. " +
            "Re-run `pnpm load-static` to pick up a newer publication.",
        );
      }
    }

    if (chosen === undefined) {
      this.#log.warn(
        "no static GTFS loaded; observations will be recorded as unmatched " +
          "until `pnpm load-static` has run. No data is lost -- delay can be " +
          "backfilled from the archive afterwards.",
      );
      this.#feedVersionId = null;
      return;
    }

    this.#feedVersionId = chosen.id;
    this.#trips.clear();
    await this.#loadCalendar(chosen.id);
    this.#log.info(
      {
        feedVersion: chosen.feed_version,
        feedVersionId: chosen.id,
        serviceIds: this.#activeDatesByService.size,
      },
      "static schedule bound",
    );
  }

  async #loadCalendar(feedVersionId: number): Promise<void> {
    const calendar = await this.#sql<CalendarRow[]>`
      select service_id, monday, tuesday, wednesday, thursday, friday,
             saturday, sunday, start_date, end_date
      from static_calendar
      where feed_version_id = ${feedVersionId}
    `;

    const active = new Map<string, Set<string>>();
    for (const row of calendar) {
      const weekdays = [
        row.sunday,
        row.monday,
        row.tuesday,
        row.wednesday,
        row.thursday,
        row.friday,
        row.saturday,
      ];
      const dates = new Set<string>();
      let date = ymd(row.start_date);
      const end = ymd(row.end_date);
      // Bounded by the feed's own validity window, so this cannot run away.
      while (date <= end) {
        const [y, m, d] = date.split("-").map(Number);
        const dow = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
        if (weekdays[dow] === true) dates.add(date);
        date = addDays(date, 1);
      }
      active.set(row.service_id, dates);
    }

    // calendar_dates overrides calendar: 1 adds service, 2 removes it.
    const exceptions = await this.#sql<
      { service_id: string; date: Date; exception_type: number }[]
    >`
      select service_id, date, exception_type
      from static_calendar_dates
      where feed_version_id = ${feedVersionId}
    `;
    for (const row of exceptions) {
      const dates = active.get(row.service_id) ?? new Set<string>();
      if (row.exception_type === 1) dates.add(ymd(row.date));
      else dates.delete(ymd(row.date));
      active.set(row.service_id, dates);
    }

    this.#activeDatesByService = active;
  }

  /**
   * Return an index covering `tripIds`, loading any that are not yet cached.
   * Trips genuinely absent from static are cached as a negative result so a
   * feed full of unknown trip ids cannot re-query the database every poll.
   */
  async indexFor(tripIds: readonly string[]): Promise<ScheduleIndex> {
    const feedVersionId = this.#feedVersionId;
    if (feedVersionId === null) return { get: () => undefined };

    const missing = [...new Set(tripIds)].filter((id) => !this.#trips.has(id));
    if (missing.length > 0) await this.#loadTrips(feedVersionId, missing);

    const trips = this.#trips;
    return { get: (tripId) => trips.get(tripId) ?? undefined };
  }

  async #loadTrips(feedVersionId: number, tripIds: string[]): Promise<void> {
    const serviceByTrip = await this.#sql<
      { trip_id: string; service_id: string }[]
    >`
      select trip_id, service_id
      from static_trips
      where feed_version_id = ${feedVersionId}
        and trip_id = any(${tripIds}::text[])
    `;

    const stopTimes = await this.#sql<
      { trip_id: string; stop_sequence: number; arrival_s: number }[]
    >`
      select trip_id, stop_sequence, arrival_s
      from static_stop_times
      where feed_version_id = ${feedVersionId}
        and trip_id = any(${tripIds}::text[])
      order by trip_id, stop_sequence
    `;

    const byTrip = new Map<string, Map<number, number>>();
    for (const row of stopTimes) {
      let stops = byTrip.get(row.trip_id);
      if (stops === undefined) {
        stops = new Map<number, number>();
        byTrip.set(row.trip_id, stops);
      }
      stops.set(row.stop_sequence, row.arrival_s);
    }

    const serviceIds = new Map(
      serviceByTrip.map((r) => [r.trip_id, r.service_id]),
    );

    for (const tripId of tripIds) {
      const serviceId = serviceIds.get(tripId);
      const stops = byTrip.get(tripId);
      if (serviceId === undefined || stops === undefined) {
        this.#trips.set(tripId, null);
        continue;
      }
      this.#trips.set(tripId, {
        feedVersionId,
        activeDates: this.#activeDatesByService.get(serviceId) ?? new Set(),
        arrivalSecondsByStopSequence: stops,
      });
    }
  }

  /**
   * Drop cached trips. Called on service-day rollover so a long-running worker
   * does not accumulate every trip id the agency has ever published.
   */
  clearTrips(): void {
    this.#trips.clear();
  }
}
