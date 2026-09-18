import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

/**
 * Export the serving tier as static JSON for Cloudflare Pages.
 *
 *   pnpm export-site                 # write to ./site/public/data
 *   pnpm export-site --out=/tmp/x
 *   pnpm export-site --window=90     # trailing window in days
 *
 * WHY STATIC
 * The data is historical averages that change once a day. There is no live
 * query to serve, so a static export means the site has ZERO runtime
 * dependency on the VM: if Oracle reclaims the instance, the site keeps
 * serving yesterday's answers instead of going dark. It also keeps Postgres
 * -- which is taking 6,000 upserts per poll -- entirely off the request path.
 *
 * SHAPE
 *   /data/index.json          stop metadata for the picker + dataset summary
 *   /data/stops/<id>.json     one file per stop, all routes/hours/day types
 *
 * Sharding by stop matches the access pattern exactly: a visitor picks one
 * stop and needs everything about it. index.json must stay small because it is
 * downloaded before the user can do anything -- so it carries only what the
 * picker needs to search and sort, not any delay figures.
 */

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

/** Thresholds shared with the UI. Kept here so the export can pre-classify. */
const N_CONFIDENT = 20;
const N_PROVISIONAL = 5;

interface StopMeta {
  stop_id: string;
  stop_name: string;
  stop_lat: number | null;
  stop_lon: number | null;
  /** Distinct headsigns served, so directional pairs are distinguishable. */
  headsigns: string[];
  /** 0/1 direction ids seen at this stop. */
  directions: number[];
  routes: string[];
  n: number;
}

interface Cell {
  route_id: string;
  hour_of_day: number;
  day_type: number;
  n: number;
  mean_delay: number;
  stddev_delay: number;
  pct_late_240: number;
  n_late_240: number;
  n_early_60: number;
  min_delay: number;
  max_delay: number;
  p50_delay_approx: number;
  p90_delay_approx: number;
  service_days: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * A bare "31% late" from 4 observations and from 400 look identical, and the
 * first is noise. Wilson is used rather than the normal approximation because
 * it stays sensible at small n and near 0% or 100%, which is exactly where
 * this dataset lives for its first fortnight.
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

const round = (v: number, dp = 1): number => Number(v.toFixed(dp));

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const outRoot = arg("out") ?? join(process.cwd(), "site", "public", "data");
  const windowDays = arg("window");
  const sql = postgres(cfg.databaseUrl, { prepare: cfg.pgPrepare, max: 4 });

  try {
    // Rebuild the serving tier first so the export is never stale relative to
    // rollup_daily. Cheap: one grouped scan of a small table.
    const [built] = await sql<{ build_stop_route_hour_stats: string }[]>`
      select build_stop_route_hour_stats(${windowDays === undefined ? null : Number(windowDays)})
    `;
    log.info({ cells: Number(built?.build_stop_route_hour_stats ?? 0) }, "serving tier rebuilt");

    const [summary] = await sql<Record<string, unknown>[]>`select * from dataset_summary`;
    if (summary === undefined) throw new Error("dataset_summary returned nothing");

    // ---- stop metadata -----------------------------------------------------
    // Only stops that actually have observations. Shipping all 1,659 including
    // ones with no data would put dead ends in the picker.
    const stops = await sql<StopMeta[]>`
      with feed as (
        select id from gtfs_feed_versions
        where load_completed_at is not null
        order by loaded_at desc limit 1
      ),
      observed as (
        select stop_id, sum(n)::int as n, array_agg(distinct route_id order by route_id) as routes
        from stop_route_hour_stats group by stop_id
      )
      select
        o.stop_id,
        coalesce(s.stop_name, o.stop_id)                           as stop_name,
        s.stop_lat, s.stop_lon,
        coalesce((
          select array_agg(distinct t.trip_headsign order by t.trip_headsign)
          from static_stop_times st
          join static_trips t on t.trip_id = st.trip_id and t.feed_version_id = st.feed_version_id
          where st.stop_id = o.stop_id and st.feed_version_id = (select id from feed)
            and t.trip_headsign is not null
        ), '{}')                                                    as headsigns,
        coalesce((
          select array_agg(distinct t.direction_id order by t.direction_id)
          from static_stop_times st
          join static_trips t on t.trip_id = st.trip_id and t.feed_version_id = st.feed_version_id
          where st.stop_id = o.stop_id and st.feed_version_id = (select id from feed)
            and t.direction_id is not null
        ), '{}')                                                    as directions,
        o.routes, o.n
      from observed o
      left join static_stops s
        on s.stop_id = o.stop_id and s.feed_version_id = (select id from feed)
      order by o.stop_id
    `;

    const allCells = await sql<(Cell & { stop_id: string })[]>`
      select stop_id, route_id, hour_of_day, day_type, n,
             mean_delay, stddev_delay, pct_late_240,
             n_late_240, n_early_60, min_delay, max_delay,
             p50_delay_approx, p90_delay_approx, service_days
      from stop_route_hour_stats
      order by stop_id, route_id, day_type, hour_of_day
    `;

    const byStop = new Map<string, Cell[]>();
    for (const row of allCells) {
      const { stop_id, ...cell } = row;
      const list = byStop.get(stop_id);
      if (list === undefined) byStop.set(stop_id, [cell]);
      else list.push(cell);
    }

    // ---- write -------------------------------------------------------------
    // Clear first: a stop that drops out of the window must not leave a stale
    // file serving numbers from a window the site no longer claims.
    await rm(outRoot, { recursive: true, force: true });
    await mkdir(join(outRoot, "stops"), { recursive: true });

    let filesWritten = 0;
    let bytes = 0;

    for (const stop of stops) {
      const cells = byStop.get(stop.stop_id) ?? [];
      const payload = {
        stop: {
          id: stop.stop_id,
          name: stop.stop_name,
          lat: stop.stop_lat,
          lon: stop.stop_lon,
          headsigns: stop.headsigns,
          directions: stop.directions,
        },
        routes: stop.routes,
        // Pre-classified so the UI never re-derives a threshold and the two
        // can never disagree about what counts as enough data.
        cells: cells.map((c) => {
          const [lo, hi] = wilson(c.n_late_240, c.n);
          return {
            r: c.route_id,
            h: c.hour_of_day,
            d: c.day_type,
            n: c.n,
            confidence:
              c.n >= N_CONFIDENT ? "confident" : c.n >= N_PROVISIONAL ? "provisional" : "sparse",
            mean: round(c.mean_delay),
            sd: round(c.stddev_delay),
            pctLate: round(c.pct_late_240),
            pctLateLo: round(lo),
            pctLateHi: round(hi),
            nLate: c.n_late_240,
            nEarly: c.n_early_60,
            min: c.min_delay,
            max: c.max_delay,
            p50: c.p50_delay_approx,
            p90: c.p90_delay_approx,
            days: c.service_days,
          };
        }),
        generatedAt: new Date().toISOString(),
      };
      const json = JSON.stringify(payload);
      await writeFile(join(outRoot, "stops", `${stop.stop_id}.json`), json);
      filesWritten += 1;
      bytes += Buffer.byteLength(json);
    }

    // index.json: picker-only fields. Deliberately excludes every delay figure
    // -- this file is downloaded before the user can do anything, so it must
    // stay small enough to parse instantly on a phone.
    const index = {
      dataset: summary,
      thresholds: { confident: N_CONFIDENT, provisional: N_PROVISIONAL },
      stops: stops.map((s) => ({
        id: s.stop_id,
        name: s.stop_name,
        lat: s.stop_lat,
        lon: s.stop_lon,
        // Headsigns are what actually disambiguate a directional pair: two
        // stops named "University at Park" on opposite kerbs differ only by
        // where their buses are going.
        headsigns: s.headsigns.slice(0, 4),
        routes: s.routes,
        n: s.n,
      })),
      generatedAt: new Date().toISOString(),
    };
    const indexJson = JSON.stringify(index);
    await writeFile(join(outRoot, "index.json"), indexJson);

    log.info(
      {
        out: outRoot,
        stopFiles: filesWritten,
        stopBytes: bytes,
        indexBytes: Buffer.byteLength(indexJson),
        totalMegabytes: +((bytes + Buffer.byteLength(indexJson)) / 1e6).toFixed(2),
      },
      "site export complete",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
