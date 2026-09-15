import { describe, expect, it } from "vitest";
import {
  addDays,
  DayType,
  dayTypeOf,
  localDateString,
  localHour,
  parseGtfsTime,
  resolveServiceDate,
  scheduledInstantMs,
  serviceDayStartMs,
} from "../src/util/time.js";

const TZ = "America/Chicago";
const HOUR = 3_600_000;

describe("GTFS time parsing", () => {
  it("parses ordinary times", () => {
    expect(parseGtfsTime("08:50:00")).toBe(31_800);
    expect(parseGtfsTime("00:00:00")).toBe(0);
  });

  it("parses times past midnight without wrapping", () => {
    // 3,827 rows in the 2026-08-24 feed look like this. Wrapping them to
    // 01:10:00 would silently move a trip 24 hours.
    expect(parseGtfsTime("25:10:00")).toBe(90_600);
    expect(parseGtfsTime("27:45:30")).toBe(99_930);
  });

  it("rejects malformed values rather than guessing", () => {
    expect(() => parseGtfsTime("8:5:0")).toThrow();
    expect(() => parseGtfsTime("08:60:00")).toThrow();
    expect(() => parseGtfsTime("")).toThrow();
  });
});

describe("service day arithmetic", () => {
  it("places a scheduled time at the right local clock time", () => {
    const at = scheduledInstantMs("2026-09-15", parseGtfsTime("08:50:00"), TZ);
    expect(localDateString(at, TZ)).toBe("2026-09-15");
    expect(localHour(at, TZ)).toBe(8);
  });

  it("rolls a past-midnight time onto the next calendar date", () => {
    // The service date stays 2026-09-15; the wall clock is the 16th.
    const at = scheduledInstantMs("2026-09-15", parseGtfsTime("25:10:00"), TZ);
    expect(localDateString(at, TZ)).toBe("2026-09-16");
    expect(localHour(at, TZ)).toBe(1);
  });

  it("keeps noon at noon on every day of the year, DST included", () => {
    // The property that makes the noon-minus-12h definition worth using.
    let date = "2026-01-01";
    for (let i = 0; i < 365; i += 1) {
      const at = scheduledInstantMs(date, 12 * 3600, TZ);
      expect(localHour(at, TZ), `noon drifted on ${date}`).toBe(12);
      expect(localDateString(at, TZ), `date drifted on ${date}`).toBe(date);
      date = addDays(date, 1);
    }
  });

  // The clocks change on Sunday 2026-03-08 (02:00 CST -> 03:00 CDT) and
  // Sunday 2026-11-01 (02:00 CDT -> 01:00 CST), but the irregular service day
  // is the one BEFORE each. That is not a bug: a service day starts at its own
  // date's local noon minus 12 hours, and Sunday's noon already sits in the new
  // offset, so Sunday's start shifts while Saturday's does not. The elastic
  // hour therefore falls in Saturday's service day, which is also where the
  // affected late-night trips actually run.
  it("produces a 23-hour service day across the spring-forward boundary", () => {
    const start = serviceDayStartMs("2026-03-07", TZ);
    const next = serviceDayStartMs("2026-03-08", TZ);
    expect((next - start) / HOUR).toBe(23);
  });

  it("produces a 25-hour service day across the fall-back boundary", () => {
    const start = serviceDayStartMs("2026-10-31", TZ);
    const next = serviceDayStartMs("2026-11-01", TZ);
    expect((next - start) / HOUR).toBe(25);
  });

  it("has exactly two irregular service days in the year", () => {
    // Pins the count as well as the dates: a bug in offset handling would
    // typically produce either none or many.
    const irregular: string[] = [];
    let date = "2026-01-01";
    for (let i = 0; i < 364; i += 1) {
      const span =
        (serviceDayStartMs(addDays(date, 1), TZ) - serviceDayStartMs(date, TZ)) /
        HOUR;
      if (span !== 24) irregular.push(`${date}:${span}`);
      date = addDays(date, 1);
    }
    expect(irregular).toEqual(["2026-03-07:23", "2026-10-31:25"]);
  });
});

describe("dayTypeOf", () => {
  it("classifies by service date, not by wall clock", () => {
    expect(dayTypeOf("2026-09-15")).toBe(DayType.Weekday); // Tuesday
    expect(dayTypeOf("2026-09-19")).toBe(DayType.Saturday);
    expect(dayTypeOf("2026-09-20")).toBe(DayType.Sunday);
  });

  it("keeps a Friday-night-into-Saturday trip on weekday service", () => {
    // Friday 2026-09-18 service, arriving 00:30 Saturday. Counting this as
    // Saturday would drag weekday late-night tails into weekend statistics.
    const at = scheduledInstantMs("2026-09-18", parseGtfsTime("24:30:00"), TZ);
    expect(localDateString(at, TZ)).toBe("2026-09-19");
    expect(dayTypeOf("2026-09-18")).toBe(DayType.Weekday);
  });
});

describe("resolveServiceDate", () => {
  const always = () => true;

  it("resolves a daytime trip to its own calendar date", () => {
    const scheduled = parseGtfsTime("08:50:00");
    const observed = scheduledInstantMs("2026-09-15", scheduled, TZ);
    expect(
      resolveServiceDate({
        observedMs: observed,
        scheduledSecondsIntoDay: scheduled,
        tz: TZ,
        runsOn: always,
      }),
    ).toBe("2026-09-15");
  });

  it("resolves a past-midnight trip to the PREVIOUS calendar date", () => {
    // The case the whole function exists for. The observation's local date is
    // the 16th; the trip belongs to the 15th's service day.
    const scheduled = parseGtfsTime("25:10:00");
    const observed = scheduledInstantMs("2026-09-15", scheduled, TZ);
    expect(localDateString(observed, TZ)).toBe("2026-09-16");
    expect(
      resolveServiceDate({
        observedMs: observed,
        scheduledSecondsIntoDay: scheduled,
        tz: TZ,
        runsOn: always,
      }),
    ).toBe("2026-09-15");
  });

  it("still resolves correctly when the bus is badly late", () => {
    // Distance-minimising rather than exact matching: a 40-minute-late
    // post-midnight bus is still nearest to its own service day.
    const scheduled = parseGtfsTime("24:15:00");
    const observed =
      scheduledInstantMs("2026-09-15", scheduled, TZ) + 40 * 60 * 1000;
    expect(
      resolveServiceDate({
        observedMs: observed,
        scheduledSecondsIntoDay: scheduled,
        tz: TZ,
        runsOn: always,
      }),
    ).toBe("2026-09-15");
  });

  it("returns null when the trip runs on none of the candidate dates", () => {
    // Honest failure. The caller records the row as unmatched rather than
    // inventing a date that would later read as a real delay.
    const scheduled = parseGtfsTime("08:50:00");
    expect(
      resolveServiceDate({
        observedMs: scheduledInstantMs("2026-09-15", scheduled, TZ),
        scheduledSecondsIntoDay: scheduled,
        tz: TZ,
        runsOn: () => false,
      }),
    ).toBeNull();
  });

  it("honours the service calendar over raw proximity", () => {
    // If the trip does not run on the nearest date, the next-nearest date it
    // does run on is chosen instead.
    const scheduled = parseGtfsTime("08:50:00");
    const observed = scheduledInstantMs("2026-09-15", scheduled, TZ);
    expect(
      resolveServiceDate({
        observedMs: observed,
        scheduledSecondsIntoDay: scheduled,
        tz: TZ,
        runsOn: (d) => d === "2026-09-14",
      }),
    ).toBe("2026-09-14");
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});
