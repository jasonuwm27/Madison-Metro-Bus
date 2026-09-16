import { describe, expect, it } from "vitest";
import { selectForRetention } from "../scripts/backup-database.js";

/**
 * Generational backup retention.
 *
 * This function decides which backups get DELETED, so it is tested rather than
 * trusted. A bug here is not a crash — it is the silent disappearance of the
 * history you would only miss at the moment you needed it.
 */

const KEEP = { daily: 7, weekly: 4, monthly: 12 };
const name = (iso: string): string => `busproject-${iso}Z.dump`;

/** Daily dumps at 08:30Z, newest last. */
function dailySeries(startIso: string, days: number): string[] {
  const out: string[] = [];
  const start = new Date(`${startIso}T08:30:00Z`);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push(name(`${d.toISOString().slice(0, 10)}T0830`));
  }
  return out;
}

describe("selectForRetention", () => {
  it("keeps everything when there is less than a week of backups", () => {
    const files = dailySeries("2026-09-10", 5);
    const { retain, remove } = selectForRetention(files, KEEP);
    expect(retain).toHaveLength(5);
    expect(remove).toEqual([]);
  });

  it("keeps the 7 most recent dailies", () => {
    const files = dailySeries("2026-09-01", 10);
    const { retain } = selectForRetention(files, KEEP);
    // The last 7 days must all survive.
    for (const recent of dailySeries("2026-09-04", 7)) {
      expect(retain).toContain(recent);
    }
  });

  it("thins older backups to weeklies rather than deleting them all", () => {
    // 60 days of dailies: dailies cover the last week, but older ones must
    // survive as weekly and monthly representatives, not vanish.
    const files = dailySeries("2026-07-20", 60);
    const { retain, remove } = selectForRetention(files, KEEP);
    expect(retain.length).toBeGreaterThan(7);
    expect(retain.length).toBeLessThan(files.length);
    expect(remove.length).toBeGreaterThan(0);
    expect(retain.length + remove.length).toBe(files.length);
  });

  it("never deletes the single newest backup", () => {
    // The property that matters most: whatever else happens, the most recent
    // dump is never a deletion candidate.
    for (const days of [1, 8, 40, 200, 500]) {
      const files = dailySeries("2025-06-01", days);
      const newest = files[files.length - 1];
      const { retain, remove } = selectForRetention(files, KEEP);
      expect(remove, `newest deleted with ${days} days of history`).not.toContain(newest);
      expect(retain).toContain(newest);
    }
  });

  it("retains a bounded number of backups over two years", () => {
    // Guards against unbounded growth: 730 dailies must collapse to roughly
    // 7 + 4 + 12, not accumulate forever.
    const files = dailySeries("2024-09-16", 730);
    const { retain } = selectForRetention(files, KEEP);
    expect(retain.length).toBeLessThanOrEqual(7 + 4 + 12);
    expect(retain.length).toBeGreaterThanOrEqual(12);
  });

  it("ignores files that are not dumps rather than deleting them", () => {
    // An unrecognised filename must never be selected for deletion -- that is
    // how unrelated data in the same folder gets destroyed.
    const files = [...dailySeries("2026-09-01", 3), "notes.txt", "archive.tar.gz", "README"];
    const { retain, remove } = selectForRetention(files, KEEP);
    for (const stranger of ["notes.txt", "archive.tar.gz", "README"]) {
      expect(remove).not.toContain(stranger);
      expect(retain).not.toContain(stranger);
    }
  });

  it("handles an empty folder without throwing", () => {
    expect(selectForRetention([], KEEP)).toEqual({ retain: [], remove: [] });
  });

  it("keeps one representative per month across a sparse year", () => {
    // Monthly dumps only: all 12 fit inside the monthly allowance.
    const monthly = Array.from({ length: 12 }, (_, i) =>
      name(`2026-${String(i + 1).padStart(2, "0")}-15T0830`),
    );
    const { retain, remove } = selectForRetention(monthly, KEEP);
    expect(retain).toHaveLength(12);
    expect(remove).toEqual([]);
  });
});
