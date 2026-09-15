import { loadConfig } from "../src/config.js";
import { createSql } from "../src/db/client.js";
import { dropExpiredPartitions, ensurePartitions } from "../src/db/partitions.js";
import { createLogger } from "../src/logger.js";
import { localDateString } from "../src/util/time.js";

/**
 * Partition maintenance.
 *
 *   pnpm partitions             -- create upcoming partitions only
 *   pnpm partitions --drop      -- also evict partitions past retention
 *   pnpm partitions --retain=45
 *
 * Creation is safe to run any time and is also performed by the worker at
 * startup and on each service-day rollover. This script exists so it can be
 * scheduled independently, and so eviction is an explicit, opt-in action rather
 * than something the collector does on its own.
 *
 * Dropping is guarded: a partition whose days are not yet present in
 * rollup_daily is skipped with a warning. Raw observations feed the monthly
 * percentiles, which cannot be rebuilt from daily rollups.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const sql = createSql(cfg);

  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}`))?.split("=")[1];

  try {
    const today = localDateString(Date.now(), cfg.timezone);

    const created = await ensurePartitions(sql, {
      fromDate: today,
      weeksAhead: 8,
      weeksBehind: 1,
      logger: log,
    });
    log.info({ created: created.length }, "partition creation complete");

    if (process.argv.includes("--drop")) {
      const retainDays = Number(arg("retain") ?? "45");
      const dropped = await dropExpiredPartitions(sql, {
        today,
        retainDays,
        logger: log,
      });
      log.info({ dropped, retainDays }, "partition eviction complete");
    }

    // ingest_runs is operational telemetry, not history worth keeping. At
    // three feeds it accrues ~8,600 rows/day, so it is pruned on its own
    // schedule rather than growing without bound.
    const pruned = await sql`
      delete from ingest_runs where started_at < now() - interval '30 days'
    `;
    log.info({ pruned: pruned.count }, "ingest_runs pruned");

    // The default partition should always be empty. Rows here mean creation
    // fell behind, and they cannot be evicted by DROP until moved.
    const [stray] = await sql<{ count: number }[]>`
      select count(*)::int as count from stop_time_observations_default
    `;
    if ((stray?.count ?? 0) > 0) {
      log.warn(
        { rows: stray?.count },
        "rows found in the DEFAULT partition -- partition creation fell behind; " +
          "these must be moved into a real partition before they can be evicted",
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
