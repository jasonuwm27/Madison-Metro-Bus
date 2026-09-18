import { describe, expect, it } from "vitest";

/**
 * Window-widening fallback.
 *
 * Mirrors the implementation in scripts/export-site.ts (which connects to
 * Postgres at import time, so it cannot be imported from a test). If the two
 * drift, the exporter's copy is authoritative.
 *
 * The point: refusing to answer is worse than answering a slightly broader
 * question, PROVIDED the broadening is declared. "Route 80 between 7 and 9am"
 * from 14 observations beats "not enough data" from 3 — but only if the screen
 * says which question it answered.
 */

interface Cell {
  route_id: string;
  hour_of_day: number;
  day_type: number;
  n: number;
  n_late_240: number;
  mean_delay: number;
}

type Scope = "exact" | "band" | "allday";

interface Widened {
  scope: Scope;
  n: number;
  nLate: number;
  meanDelay: number;
  hours: number[];
}

function widen(
  cells: readonly Cell[],
  route: string,
  hour: number,
  dayType: number,
  minN: number,
): Widened | null {
  const pick = (hours: readonly number[]): Widened => {
    const matched = cells.filter(
      (c) => c.route_id === route && c.day_type === dayType && hours.includes(c.hour_of_day),
    );
    const n = matched.reduce((t, c) => t + c.n, 0);
    const nLate = matched.reduce((t, c) => t + c.n_late_240, 0);
    const sum = matched.reduce((t, c) => t + c.mean_delay * c.n, 0);
    return {
      scope: "exact",
      n,
      nLate,
      meanDelay: n === 0 ? 0 : sum / n,
      hours: matched.map((c) => c.hour_of_day).sort((a, b) => a - b),
    };
  };

  const exact = { ...pick([hour]), scope: "exact" as Scope };
  if (exact.n >= minN) return exact;
  const band = { ...pick([hour - 1, hour, hour + 1]), scope: "band" as Scope };
  if (band.n >= minN) return band;
  const allDay = { ...pick(Array.from({ length: 24 }, (_, i) => i)), scope: "allday" as Scope };
  if (allDay.n >= minN) return allDay;
  return null;
}

const cell = (hour: number, n: number, late: number, mean = 60, route = "80", day = 0): Cell => ({
  route_id: route,
  hour_of_day: hour,
  day_type: day,
  n,
  n_late_240: late,
  mean_delay: mean,
});

describe("widen", () => {
  it("prefers the exact hour when it already has enough", () => {
    const cells = [cell(8, 30, 9), cell(7, 30, 9), cell(9, 30, 9)];
    const r = widen(cells, "80", 8, 0, 5);
    expect(r?.scope).toBe("exact");
    expect(r?.n).toBe(30);
    expect(r?.hours).toEqual([8]);
  });

  it("widens to a 3-hour band when the hour alone is too thin", () => {
    // 3 at 8am is below the threshold; 7-9am together clears it.
    const cells = [cell(7, 6, 2), cell(8, 3, 1), cell(9, 6, 2)];
    const r = widen(cells, "80", 8, 0, 5);
    expect(r?.scope).toBe("band");
    expect(r?.n).toBe(15);
    expect(r?.hours).toEqual([7, 8, 9]);
  });

  it("falls back to the whole day when even the band is too thin", () => {
    const cells = [cell(8, 2, 1), cell(14, 4, 1), cell(17, 3, 2)];
    const r = widen(cells, "80", 8, 0, 5);
    expect(r?.scope).toBe("allday");
    expect(r?.n).toBe(9);
  });

  it("returns null rather than inventing an answer from nothing", () => {
    // The honest outcome when even all-day cannot reach the threshold. The UI
    // shows raw counts instead of a percentage.
    const cells = [cell(8, 2, 1)];
    expect(widen(cells, "80", 8, 0, 5)).toBeNull();
  });

  it("never mixes routes or day types", () => {
    // Widening the HOUR must not quietly widen the route or the day type --
    // Saturday service is a different thing, not more of the same thing.
    const cells = [
      cell(8, 2, 1, 60, "80", 0),
      cell(8, 50, 25, 60, "81", 0),
      cell(8, 50, 25, 60, "80", 1),
      cell(7, 4, 1, 60, "80", 0),
      cell(9, 4, 1, 60, "80", 0),
    ];
    const r = widen(cells, "80", 8, 0, 5);
    expect(r?.scope).toBe("band");
    // 2 + 4 + 4 = 10, using only route 80 weekday cells.
    expect(r?.n).toBe(10);
  });

  it("aggregates exactly, since the inputs are algebraic", () => {
    // Widening must not approximate: n and n_late are plain sums.
    const cells = [cell(7, 10, 3), cell(8, 4, 2), cell(9, 6, 1)];
    const r = widen(cells, "80", 8, 0, 5);
    expect(r?.n).toBe(20);
    expect(r?.nLate).toBe(6);
  });

  it("weights the mean by observation count, not by cell count", () => {
    // A cell with 90 observations must dominate one with 10.
    const cells = [cell(7, 90, 0, 100), cell(8, 4, 0, 0), cell(9, 6, 0, 0)];
    const r = widen(cells, "80", 8, 0, 5);
    expect(r?.n).toBe(100);
    expect(r?.meanDelay).toBeCloseTo(90, 5);
  });

  it("handles hour 0 and 23 without wrapping into nonsense", () => {
    // Band around midnight reaches for -1 and 24, which simply do not exist.
    // It must not wrap to 23 or 0 and silently borrow the far end of the day.
    const cells = [cell(0, 3, 1), cell(23, 40, 20), cell(1, 3, 1)];
    const r = widen(cells, "80", 0, 0, 5);
    expect(r?.scope).toBe("band");
    expect(r?.hours).toEqual([0, 1]);
    expect(r?.n).toBe(6);
  });
});
