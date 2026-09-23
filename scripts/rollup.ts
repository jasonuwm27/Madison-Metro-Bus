import { loadConfig } from "../src/config.js";
import { createSql } from "../src/db/client.js";
import { createLogger } from "../src/logger.js";
import { addDays, localDateString } from "../src/util/time.js";

/**
 * Build rollups.
 *
 *   pnpm rollup                  -- yesterday's daily rollup
 *   pnpm rollup --date=2026-09-15
 *   pnpm rollup --backfill=14    -- the last 14 service days
 *   pnpm rollup --monthly        -- also rebuild the current month
 *   pnpm rollup --monthly=2026-09
 *
 * Both functions delete and rebuild their target period, so re-running is
 * always safe and always converges to the same answer.
 *
 * SCHEDULING: run daily, after the service day has fully settled. Late-night
 * trips can still be updating past midnight, so early morning local time is the
 * right window. The monthly rollup must run before the 45-day partition drop
 * reaches that month -- see dropExpiredPartitions, which refuses to drop
 * anything not yet rolled up.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const sql = createSql(cfg);

  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}`))?.split("=")[1];
  const has = (name: string): boolean =>
    process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

  try {
    const today = localDateString(Date.now(), cfg.timezone);
    const explicit = arg("date");
    const backfill = Number(arg("backfill") ?? "0");

    const dates: string[] = [];
    if (explicit !== undefined) {
      dates.push(explicit);
    } else if (backfill > 0) {
      for (let i = 1; i <= backfill; i += 1) dates.push(addDays(today, -i));
    } else {
      dates.push(addDays(today, -1));
    }

    for (const date of dates) {
      const started = Date.now();
      const [result] = await sql<{ build_rollup_daily: string }[]>`
        select build_rollup_daily(${date}::date)
      `;
      log.info(
        {
          serviceDate: date,
          buckets: Number(result?.build_rollup_daily ?? 0),
          durationMs: Date.now() - started,
        },
        "daily rollup built",
      );
    }

    // ---- coverage check -----------------------------------------------------
    // Runs once per invocation, on the most recent date just rolled up (not
    // every backfilled date), so a --backfill run doesn't spam alerts for
    // days already known and long since investigated.
    //
    // Threshold and reasoning match scripts/weekly-summary.ts: 85% cleanly
    // separates every clean day measured so far (94%+) from every day with a
    // diagnosed or undiagnosed shortfall (83% or below). This check exists
    // SEPARATELY from the weekly summary so a gap is caught the next morning,
    // not up to six days later -- the whole point raised after the Sept 17
    // incident sat undiscovered for a week.
    const latestDate = dates.at(-1);
    if (latestDate !== undefined) {
      await sql`select build_day_coverage_all()`;
      const [coverage] = await sql<{ coverage_pct: number; known_gap_reason: string | null }[]>`
        select coverage_pct, known_gap_reason from day_coverage where service_date = ${latestDate}::date
      `;
      if (coverage !== undefined && coverage.known_gap_reason === null && coverage.coverage_pct < 85) {
        log.error(
          { serviceDate: latestDate, coveragePct: coverage.coverage_pct },
          "coverage below threshold with no diagnosed cause",
        );
        // Non-zero exit fails the systemd unit, which fails HC_ROLLUP's ping --
        // reusing the existing healthcheck rather than adding a new one that
        // could itself be forgotten in a future healthcheck cleanup.
        process.exitCode = 1;
      }
    }

    if (has("monthly")) {
      const month = arg("monthly") ?? today.slice(0, 7);
      const started = Date.now();
      const [result] = await sql<{ build_rollup_monthly: string }[]>`
        select build_rollup_monthly(${`${month}-01`}::date)
      `;
      log.info(
        {
          month,
          buckets: Number(result?.build_rollup_monthly ?? 0),
          durationMs: Date.now() - started,
        },
        "monthly rollup built",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
