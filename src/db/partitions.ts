import type { Logger } from "../logger.js";
import { addDays } from "../util/time.js";
import type { Sql } from "./client.js";

/**
 * Weekly partition management for stop_time_observations.
 *
 * Partitions are created ahead of time rather than on demand. If a write ever
 * arrives for a date with no partition it lands in the DEFAULT partition, which
 * is a warning sign rather than a failure -- but rows in the default partition
 * cannot be evicted by DROP, so they have to be migrated out by hand. Creating
 * several weeks ahead means that only happens if the worker has been down for
 * longer than the lookahead.
 */

/** Monday of the ISO week containing `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  // getUTCDay: Sunday = 0. Shift so Monday starts the week.
  return addDays(date, -((dow + 6) % 7));
}

export function partitionNameFor(weekStartDate: string): string {
  return `stop_time_observations_w${weekStartDate.replace(/-/g, "")}`;
}

export async function ensurePartitions(
  sql: Sql,
  options: { fromDate: string; weeksAhead: number; weeksBehind?: number; logger: Logger },
): Promise<string[]> {
  const created: string[] = [];
  const start = weekStart(addDays(options.fromDate, -7 * (options.weeksBehind ?? 1)));

  for (let i = 0; i <= options.weeksAhead + (options.weeksBehind ?? 1); i += 1) {
    const from = addDays(start, i * 7);
    const to = addDays(from, 7);
    const name = partitionNameFor(from);

    const [existing] = await sql<{ exists: boolean }[]>`
      select exists (
        select 1 from pg_class where relname = ${name}
      ) as exists
    `;
    if (existing?.exists === true) continue;

    // fillfactor leaves free space in each page for HOT updates. Every poll
    // rewrites observed_arrival on thousands of rows, and a HOT update can only
    // stay on its own page if that page has room. Without the headroom, updates
    // migrate to new pages and the table bloats far faster than it grows.
    await sql.unsafe(`
      create table if not exists ${name}
        partition of stop_time_observations
        for values from ('${from}') to ('${to}')
        with (fillfactor = 85)
    `);
    created.push(name);
    options.logger.info({ partition: name, from, to }, "partition created");
  }
  return created;
}

/**
 * Drop partitions older than `retainDays`, but only where the data has already
 * been rolled up. The guard is the point: raw observations are the input to the
 * monthly rollup's percentiles, which cannot be recomputed from daily rollups
 * because percentiles do not compose. Dropping early would silently degrade
 * every month boundary.
 */
export async function dropExpiredPartitions(
  sql: Sql,
  options: { today: string; retainDays: number; logger: Logger },
): Promise<string[]> {
  const cutoff = addDays(options.today, -options.retainDays);
  const dropped: string[] = [];

  const partitions = await sql<{ relname: string; upper_bound: string }[]>`
    select c.relname,
           (regexp_match(
              pg_get_expr(c.relpartbound, c.oid),
              'TO \\(''([0-9-]+)''\\)'))[1] as upper_bound
    from pg_class c
    join pg_inherits i on i.inhrelid = c.oid
    join pg_class p on p.oid = i.inhparent
    where p.relname = 'stop_time_observations'
      and c.relname <> 'stop_time_observations_default'
  `;

  for (const partition of partitions) {
    const upper = partition.upper_bound;
    if (upper === null || upper === undefined) continue;
    // Upper bound is exclusive, so the partition's last day is upper - 1.
    if (addDays(upper, -1) >= cutoff) continue;

    const [unrolled] = await sql<{ missing: number }[]>`
      with days as (
        select distinct service_date
        from stop_time_observations
        where service_date < ${upper}::date
          and service_date >= (${upper}::date - interval '7 days')
      )
      select count(*)::int as missing
      from days d
      where not exists (
        select 1 from rollup_daily r where r.service_date = d.service_date
      )
    `;

    if ((unrolled?.missing ?? 0) > 0) {
      options.logger.warn(
        { partition: partition.relname, unrolledDays: unrolled?.missing },
        "partition is past retention but not fully rolled up; NOT dropping",
      );
      continue;
    }

    await sql.unsafe(`drop table if exists ${partition.relname}`);
    dropped.push(partition.relname);
    options.logger.info({ partition: partition.relname }, "partition dropped");
  }
  return dropped;
}
