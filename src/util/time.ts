/**
 * Service-day arithmetic.
 *
 * This is the most failure-prone code in the project, for three reasons:
 *
 * 1. Madison's TripUpdates feed carries NO trip.start_date. Nothing in a
 *    realtime message says which service day a trip belongs to; it has to be
 *    inferred by matching against the static schedule.
 *
 * 2. GTFS service days are not calendar days. A trip departing at 25:10:00
 *    belongs to the PREVIOUS calendar date. The 2026-08-24 static feed has
 *    3,827 stop_times past 24:00:00, so this is a real population, not an edge
 *    case. Around midnight, the calendar date of an observation and its service
 *    date genuinely disagree.
 *
 * 3. DST. America/Chicago shifts twice a year. GTFS defines the service day as
 *    starting at noon-minus-12-hours precisely so that a day containing a DST
 *    transition still maps times correctly -- noon is never ambiguous, whereas
 *    midnight can be skipped or repeated. All conversions here go through noon.
 *
 * Everything in this file is pure and synchronous so it can be tested directly.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Offset of `tz` from UTC at a given instant, in milliseconds.
 * Positive west of UTC would be negative here: for America/Chicago in summer
 * this returns -18000000 (UTC-5).
 */
export function timeZoneOffsetMs(instantMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    if (p === undefined) throw new Error(`missing ${type} from Intl parts`);
    return Number(p.value);
  };
  // Intl renders hour 24 for midnight under hour12:false in some ICU versions.
  const hour = get("hour") % 24;
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return asIfUtc - instantMs;
}

/** "YYYY-MM-DD" for an instant, in the given zone. */
export function localDateString(instantMs: number, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA formats as YYYY-MM-DD.
  return dtf.format(new Date(instantMs));
}

/** Hour 0-23 of an instant, in the given zone. */
export function localHour(instantMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
  });
  const p = dtf.formatToParts(new Date(instantMs)).find((x) => x.type === "hour");
  if (p === undefined) throw new Error("missing hour from Intl parts");
  return Number(p.value) % 24;
}

/** Shift a "YYYY-MM-DD" by whole days, staying in the calendar domain. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`invalid date string: ${dateStr}`);
  }
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Start of the GTFS service day for `serviceDate`, as a UTC epoch in ms.
 *
 * Defined as local noon minus 12 hours, per the GTFS spec. Going through noon
 * is what makes this DST-safe: on a spring-forward date, local midnight may not
 * exist, but local noon always does, and the resulting service day is correctly
 * 23 hours long.
 */
export function serviceDayStartMs(serviceDate: string, tz: string): number {
  const [y, m, d] = serviceDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`invalid service date: ${serviceDate}`);
  }
  const noonWallClockAsUtc = Date.UTC(y, m - 1, d, 12, 0, 0);

  // Solve for the instant whose local wall clock reads noon. One refinement
  // suffices because the offset is constant in a wide band around noon --
  // US DST transitions occur at 02:00 local.
  let instant = noonWallClockAsUtc - timeZoneOffsetMs(noonWallClockAsUtc, tz);
  instant = noonWallClockAsUtc - timeZoneOffsetMs(instant, tz);

  return instant - 12 * 3_600_000;
}

/**
 * Absolute instant of a scheduled stop time.
 * `secondsIntoServiceDay` is the raw GTFS value, so 25:10:00 arrives as 90600
 * and lands on the following calendar date without special handling.
 */
export function scheduledInstantMs(
  serviceDate: string,
  secondsIntoServiceDay: number,
  tz: string,
): number {
  return serviceDayStartMs(serviceDate, tz) + secondsIntoServiceDay * 1000;
}

/** Parse "HH:MM:SS" (H may exceed 23) into seconds since service day start. */
export function parseGtfsTime(value: string): number {
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(value.trim());
  if (m === null) throw new Error(`invalid GTFS time: ${value}`);
  const [, h, min, s] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(s);
}

export const DayType = {
  Weekday: 0,
  Saturday: 1,
  Sunday: 2,
} as const;
export type DayTypeValue = (typeof DayType)[keyof typeof DayType];

/**
 * Weekday/Saturday/Sunday for a service date.
 *
 * Derived from the service date rather than the observation instant, which
 * matters for after-midnight trips: a 00:30 Saturday arrival on a Friday
 * service day is Weekday service, and counting it as Saturday would pollute
 * weekend reliability numbers with weekday rush-hour tails.
 */
export function dayTypeOf(serviceDate: string): DayTypeValue {
  const [y, m, d] = serviceDate.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`invalid service date: ${serviceDate}`);
  }
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 6) return DayType.Saturday;
  if (dow === 0) return DayType.Sunday;
  return DayType.Weekday;
}

/**
 * Pick the service date a trip belongs to.
 *
 * Strategy: consider the local date of the observation and its immediate
 * neighbours, keep only dates on which the trip actually runs, and choose the
 * one whose scheduled instant sits closest to what we observed.
 *
 * Choosing by minimum distance rather than by clock arithmetic is what makes
 * after-midnight trips work. At 00:30 local, a trip scheduled for 24:30:00 is
 * 0 seconds away on the previous service date and 24 hours away on the current
 * one, so the correct date wins by a wide margin -- and the same comparison
 * keeps working when the bus is an hour late.
 *
 * Returns null when the trip runs on none of the candidate dates, which is the
 * honest answer for an ADDED trip or a stale trip_id; the caller records the
 * observation with scheduled_source = unmatched rather than inventing a date.
 */
export function resolveServiceDate(args: {
  observedMs: number;
  scheduledSecondsIntoDay: number;
  tz: string;
  runsOn: (serviceDate: string) => boolean;
}): string | null {
  const { observedMs, scheduledSecondsIntoDay, tz, runsOn } = args;
  const centre = localDateString(observedMs, tz);
  const candidates = [addDays(centre, -1), centre, addDays(centre, 1)];

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (!runsOn(candidate)) continue;
    const scheduled = scheduledInstantMs(candidate, scheduledSecondsIntoDay, tz);
    const distance = Math.abs(scheduled - observedMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}
