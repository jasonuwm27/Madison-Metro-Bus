import { describe, expect, it } from "vitest";

/**
 * Wilson score interval.
 *
 * Mirrors the implementation in scripts/export-site.ts. Duplicated rather than
 * imported because that module connects to Postgres at import time; the rule
 * that tests never touch a database matters more than avoiding twelve lines of
 * duplication. If the two drift, the exporter's copy is authoritative.
 *
 * This is what stops the site lying at small n. With 93.4% of cells currently
 * below n=5, a bare proportion would be actively misleading -- "31% late" from
 * four buses is noise wearing a number's clothes.
 */
function wilson(successes: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 100];
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [
    Math.max(0, ((centre - spread) / denom) * 100),
    Math.min(100, ((centre + spread) / denom) * 100),
  ];
}

describe("wilson", () => {
  it("is honestly wide at the sample sizes this dataset actually has", () => {
    // 1 late out of 4 -- the shape of a typical cell today. A naive reading is
    // "25% late"; the truth is somewhere between roughly 5% and 70%.
    const [lo, hi] = wilson(1, 4);
    expect(lo).toBeLessThan(10);
    expect(hi).toBeGreaterThan(60);
    expect(hi - lo).toBeGreaterThan(50);
  });

  it("tightens as observations accumulate", () => {
    // Same 25% proportion at increasing n: the interval must shrink
    // monotonically, which is the entire reason for showing it.
    const widths = [4, 20, 100, 500].map((n) => {
      const [lo, hi] = wilson(n / 4, n);
      return hi - lo;
    });
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
    }
    // At n=500 it should be tight enough to quote plainly.
    expect(widths[3]!).toBeLessThan(10);
  });

  it("never reports an impossible percentage", () => {
    // The normal approximation happily returns negative lower bounds or >100%
    // upper bounds near the extremes. Wilson must not, at any n.
    for (const n of [1, 2, 3, 5, 10, 47, 1000]) {
      for (const k of [0, 1, n - 1, n]) {
        if (k < 0 || k > n) continue;
        const [lo, hi] = wilson(k, n);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(100);
        expect(lo).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("does not claim certainty from a unanimous small sample", () => {
    // 3 of 3 late is NOT "100% late, guaranteed". The upper bound may reach
    // 100 but the lower bound must stay well short of it.
    const [lo, hi] = wilson(3, 3);
    expect(hi).toBeLessThanOrEqual(100);
    expect(lo).toBeLessThan(60);
  });

  it("brackets the point estimate", () => {
    // Sanity: the observed proportion always lies inside its own interval.
    for (const [k, n] of [[1, 4], [5, 20], [13, 47], [250, 1000]] as [number, number][]) {
      const [lo, hi] = wilson(k, n);
      const point = (k / n) * 100;
      expect(point).toBeGreaterThanOrEqual(lo);
      expect(point).toBeLessThanOrEqual(hi);
    }
  });

  it("returns the full range for no data rather than NaN", () => {
    // n=0 must not produce NaN -- that would serialise into the JSON export
    // and render as "NaN%" on the page.
    expect(wilson(0, 0)).toEqual([0, 100]);
  });
});
