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
