import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 *   /data/index.json          stop + route metadata for the pickers + dataset summary
 *   /data/stops/<id>.json     one file per stop, all routes/hours/day types
 *   /data/routes/<id>.json    one file per route: overall stats, delay profile
 *                             along the line (per direction), best/worst
 *                             stops, hour-of-day breakdown
 *
 * Sharding by stop (and now by route) matches the access pattern exactly: a
 * visitor picks one stop or one route and needs everything about it.
 * index.json must stay small because it is downloaded before the user can do
 * anything -- so it carries only what the pickers need to search and sort,
 * not any delay figures.
 *
 * ROUTE TIER -- no new base table.
 * stop_route_hour_stats already carries algebraic aggregates keyed by
 * (stop_id, route_id, hour_of_day, day_type). A route's overall reliability
 * and hour-of-day breakdown are exact sums grouped by route_id -- summing an
 * algebraic aggregate loses no precision, so this needs nothing beyond what
 * already exists. The one new ingredient is stop ORDER along the route, which
 * comes from static_stop_times.stop_sequence for a representative trip
 * pattern per (route, direction) -- the trip with the most stops, chosen once
 * per export rather than trying to average across every pattern variant.
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

interface RouteMeta {
  route_id: string;
  route_name: string | null;
  n: number;
}

/** One stop's aggregate stats for one route, summed across hour/day_type. */
interface RouteStopAgg {
  route_id: string;
  stop_id: string;
  n: number;
  sum_delay: string; // bigint over the wire
  sum_delay_sq: string; // bigint over the wire
  n_late_240: number;
  n_early_60: number;
}

/** Representative stop order for one (route, direction) -- longest pattern. */
interface RouteStopOrder {
  route_id: string;
  direction_id: number;
  stop_sequence: number;
  stop_id: string;
  stop_name: string | null;
  trip_headsign: string | null;
}

interface RouteHourAgg {
  route_id: string;
  hour_of_day: number;
  day_type: number;
  n: number;
  sum_delay: string;
  n_late_240: number;
  n_early_60: number;
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

/**
 * Widen the window before suppressing.
 *
 * A specific (route, hour, day_type) cell is often too thin to say anything --
 * 93% of them today. But the same route at the same stop across a 3-hour band,
 * or across the whole day, frequently is not. Answering a slightly broader
 * question is far more useful than refusing to answer at all, PROVIDED the
 * broadening is stated rather than hidden.
 *
 * Tried in order, most specific first, stopping at the first level that clears
 * the threshold:
 *   exact  -- this hour            "Route 80 at 8am"
 *   band   -- +/- 1 hour           "Route 80 between 7am and 9am"
 *   allday -- every hour           "Route 80, weekdays"
 *
 * Each result carries its own scope so the UI can say which question it
 * actually answered. Aggregation is exact at every level because n, n_late and
 * the sums are algebraic -- no approximation is introduced by widening.
 */
type Scope = "exact" | "band" | "allday";

interface Widened {
  scope: Scope;
  n: number;
  nLate: number;
  meanDelay: number;
  hours: number[];
}

function widen(cells: readonly Cell[], route: string, hour: number, dayType: number, minN: number): Widened | null {
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

  const allDay = {
    ...pick(Array.from({ length: 24 }, (_, i) => i)),
    scope: "allday" as Scope,
  };
  if (allDay.n >= minN) return allDay;

  return null;
}

/** Postgres dates arrive as full timestamps; the site only ever shows the day. */
function toDateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Mirrors the client's esc() -- this runs in a separate process from app.js. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/**
 * Static hero markup baked into index.html at export time.
 *
 * This is deliberately a plain summary, not the interactive picker -- app.js
 * replaces #view wholesale on load. The only job here is to give first paint
 * (and any crawler, which never runs the client) real numbers instead of
 * "Loading…".
 */
function renderHeroSsr(
  summary: { totalObservations: number; serviceDays: number; firstServiceDate: string | null },
  growth: readonly { date: string | null; n: number }[],
): string {
  const since = summary.firstServiceDate
    ? new Date(`${summary.firstServiceDate}T12:00:00Z`).toLocaleDateString("en-US", {
        day: "numeric", month: "long", year: "numeric",
      })
    : null;
  const totalN = growth.reduce((t, g) => t + g.n, 0) || summary.totalObservations;
  // Skeleton for the search box and quick-route pills: real markup doesn't
  // exist until index.json loads and renderHome() runs client-side, so
  // without this a visitor's first paint is the headline and then nothing --
  // which reads as broken, not loading. app.js replaces #view wholesale on
  // load, so this never lingers or gets out of sync with the real content;
  // it only has to look right for the one round trip before that happens.
  return `
    <div class="hero">
      <h1>Is my bus late?</h1>
      <p class="lede">See how often Madison Metro actually runs on time.
      ${since ? `Collecting since ${esc(since)}, ${totalN.toLocaleString()} arrivals recorded so far.` : ""}</p>
      <div class="omnisearch">
        <input type="search" class="omniq" disabled autofocus
               placeholder="Search by route number or stop name…" aria-label="Search by route number or stop name">
      </div>
      <div class="pill-row skel" aria-hidden="true">
        <span class="pill-btn skel-pill"></span><span class="pill-btn skel-pill"></span>
        <span class="pill-btn skel-pill"></span><span class="pill-btn skel-pill"></span>
        <span class="pill-btn skel-pill"></span>
      </div>
    </div>`;
}

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

    // count(*) returns bigint, which postgres.js surfaces as a STRING to avoid
    // precision loss. Left alone these reach the browser as "34232" and every
    // arithmetic operation silently becomes string concatenation -- a total of
    // 34232 + 1 renders as "342321". Cast at the boundary, once.
    const [rawSummary] = await sql<Record<string, unknown>[]>`select * from dataset_summary`;
    if (rawSummary === undefined) throw new Error("dataset_summary returned nothing");
    const summary = {
      firstServiceDate: toDateOnly(rawSummary["first_service_date"]),
      lastServiceDate: toDateOnly(rawSummary["last_service_date"]),
      serviceDays: Number(rawSummary["service_days"] ?? 0),
      totalObservations: Number(rawSummary["total_observations"] ?? 0),
      stopsWithData: Number(rawSummary["stops_with_data"] ?? 0),
      routesWithData: Number(rawSummary["routes_with_data"] ?? 0),
      cellsConfident: Number(rawSummary["cells_confident"] ?? 0),
      cellsProvisional: Number(rawSummary["cells_provisional"] ?? 0),
      cellsSparse: Number(rawSummary["cells_sparse"] ?? 0),
      cellsTotal: Number(rawSummary["cells_total"] ?? 0),
      // Which day types have any data at all. Weekend cells only exist once a
      // weekend has elapsed, and the UI must not offer a Saturday tab that
      // can only ever say "no data".
      dayTypesPresent: [] as number[],
    };

    // ---- stop metadata -----------------------------------------------------
    // Only stops that actually have observations. Shipping all 1,659 including
    // ones with no data would put dead ends in the picker.
    // Headsigns and directions are aggregated ONCE across all stops, then
    // joined -- not fetched per stop. The obvious correlated-subquery form
    // rescans static_stop_times (603k rows) once per stop, which at 1,464
    // stops timed out against Supabase's statement limit. One grouped pass is
    // the same answer in a single scan.
    const stops = await sql<StopMeta[]>`
      with feed as (
        select id from gtfs_feed_versions
        where load_completed_at is not null
        order by loaded_at desc limit 1
      ),
      observed as (
        select stop_id, sum(n)::int as n,
               array_agg(distinct route_id order by route_id) as routes
        from stop_route_hour_stats group by stop_id
      ),
      stop_trips as (
        select st.stop_id,
               array_agg(distinct t.trip_headsign) filter (where t.trip_headsign is not null) as headsigns,
               array_agg(distinct t.direction_id)  filter (where t.direction_id  is not null) as directions
        from static_stop_times st
        join static_trips t
          on t.trip_id = st.trip_id and t.feed_version_id = st.feed_version_id
        where st.feed_version_id = (select id from feed)
          and st.stop_id in (select stop_id from observed)
        group by st.stop_id
      )
      select
        o.stop_id,
        coalesce(s.stop_name, o.stop_id)      as stop_name,
        s.stop_lat, s.stop_lon,
        coalesce(tr.headsigns,  '{}')         as headsigns,
        coalesce(tr.directions, '{}')         as directions,
        o.routes, o.n
      from observed o
      left join static_stops s
        on s.stop_id = o.stop_id and s.feed_version_id = (select id from feed)
      left join stop_trips tr on tr.stop_id = o.stop_id
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

    summary.dayTypesPresent = [...new Set(allCells.map((c) => c.day_type))].sort();

    // ---- dataset growth: observations per service day ----------------------
    // Sourced from rollup_daily so it uses the exact same "countable
    // observation" filter as every other headline number on the site --
    // never a separate, possibly-disagreeing count of raw rows.
    const growth = await sql<{ service_date: unknown; n: string }[]>`
      select service_date, sum(n)::bigint as n
      from rollup_daily
      group by service_date
      order by service_date
    `;
    const growthSeries = growth.map((r) => ({
      date: toDateOnly(r.service_date),
      n: Number(r.n),
    }));

    // ---- data completeness --------------------------------------------------
    // This is a feature, not an apology: the archive proving a Metro-side
    // feed outage happened is exactly what this project exists to do.
    // Rebuilt before reading so a day collected since the last export shows
    // up immediately rather than waiting for tomorrow's rebuild.
    await sql`select build_day_coverage_all()`;
    const coverageRows = await sql<
      { service_date: unknown; coverage_pct: number; known_gap_reason: string | null }[]
    >`
      select service_date, coverage_pct, known_gap_reason
      from day_coverage
      order by service_date
    `;
    const dayCoverage = coverageRows.map((r) => ({
      date: toDateOnly(r.service_date),
      coveragePct: r.coverage_pct,
      knownGapReason: r.known_gap_reason,
    }));

    // ---- route tier ----------------------------------------------------------
    const feedForRoutes = sql`
      select id from gtfs_feed_versions where load_completed_at is not null order by loaded_at desc limit 1
    `;

    const routeMeta = await sql<RouteMeta[]>`
      with observed as (
        select route_id, sum(n)::int as n from stop_route_hour_stats group by route_id
      )
      select o.route_id, r.route_long_name as route_name, o.n
      from observed o
      left join static_routes r
        on r.route_id = o.route_id and r.feed_version_id = (${feedForRoutes})
      order by o.route_id
    `;

    const routeStopAgg = await sql<RouteStopAgg[]>`
      select route_id, stop_id, sum(n)::int as n,
             sum(sum_delay)::bigint::text as sum_delay,
             sum(sum_delay_sq)::bigint::text as sum_delay_sq,
             sum(n_late_240)::int as n_late_240, sum(n_early_60)::int as n_early_60
      from stop_route_hour_stats
      group by route_id, stop_id
    `;

    const routeHourAgg = await sql<RouteHourAgg[]>`
      select route_id, hour_of_day, day_type, sum(n)::int as n,
             sum(sum_delay)::bigint::text as sum_delay,
             sum(n_late_240)::int as n_late_240, sum(n_early_60)::int as n_early_60
      from stop_route_hour_stats
      group by route_id, hour_of_day, day_type
    `;

    // Representative stop order per (route, direction): the trip with the
    // most stops, picked once rather than trying to reconcile every pattern
    // variant a route runs (short-turns, detour patterns, etc).
    const routeStopOrder = await sql<RouteStopOrder[]>`
      with feed as (${feedForRoutes}),
      trip_lengths as (
        select t.trip_id, t.route_id, t.direction_id, count(*) as n_stops
        from static_trips t
        join static_stop_times st on st.trip_id = t.trip_id and st.feed_version_id = t.feed_version_id
        where t.feed_version_id = (select id from feed) and t.direction_id is not null
        group by t.trip_id, t.route_id, t.direction_id
      ),
      best as (
        select tl.route_id, tl.direction_id, tl.trip_id, t.trip_headsign,
               row_number() over (partition by tl.route_id, tl.direction_id order by tl.n_stops desc, tl.trip_id) as rn
        from trip_lengths tl
        join static_trips t on t.trip_id = tl.trip_id and t.feed_version_id = (select id from feed)
      )
      select b.route_id, b.direction_id, b.trip_headsign, st.stop_sequence, st.stop_id, s.stop_name
      from best b
      join static_stop_times st on st.trip_id = b.trip_id and st.feed_version_id = (select id from feed)
      left join static_stops s on s.stop_id = st.stop_id and s.feed_version_id = (select id from feed)
      where b.rn = 1
      order by b.route_id, b.direction_id, st.stop_sequence
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
    await mkdir(join(outRoot, "routes"), { recursive: true });

    let filesWritten = 0;
    let bytes = 0;
    const usableStops = new Set<string>();

    // ---- write route files ---------------------------------------------------
    const stopAggByRoute = new Map<string, RouteStopAgg[]>();
    for (const row of routeStopAgg) {
      const list = stopAggByRoute.get(row.route_id);
      if (list === undefined) stopAggByRoute.set(row.route_id, [row]);
      else list.push(row);
    }
    const hourAggByRoute = new Map<string, RouteHourAgg[]>();
    for (const row of routeHourAgg) {
      const list = hourAggByRoute.get(row.route_id);
      if (list === undefined) hourAggByRoute.set(row.route_id, [row]);
      else list.push(row);
    }
    const orderByRoute = new Map<string, RouteStopOrder[]>();
    for (const row of routeStopOrder) {
      const list = orderByRoute.get(row.route_id);
      if (list === undefined) orderByRoute.set(row.route_id, [row]);
      else list.push(row);
    }

    let routeFilesWritten = 0;
    let routeBytes = 0;
    const usableRoutes = new Set<string>();
    const stopNameById = new Map(stops.map((s) => [s.stop_id, s.stop_name]));

    for (const route of routeMeta) {
      const stopAgg = stopAggByRoute.get(route.route_id) ?? [];
      const totalN = stopAgg.reduce((t, r) => t + r.n, 0);
      const totalDelay = stopAgg.reduce((t, r) => t + Number(r.sum_delay), 0);
      const totalLate = stopAgg.reduce((t, r) => t + r.n_late_240, 0);
      const totalEarly = stopAgg.reduce((t, r) => t + r.n_early_60, 0);
      const [olo, ohi] = wilson(totalLate, totalN);

      // Delay profile along the line: one point per stop, in schedule order,
      // per direction. This is the "does lateness accumulate toward the end
      // of the line" shape.
      const order = orderByRoute.get(route.route_id) ?? [];
      const aggByStop = new Map(stopAgg.map((r) => [r.stop_id, r]));
      const directions = [...new Set(order.map((o) => o.direction_id))].sort();
      const profile = directions.map((dir) => ({
        direction: dir,
        // Every stop on a direction shares the same representative trip, so
        // its headsign is one value per direction, not per stop.
        headsign: order.find((o) => o.direction_id === dir)?.trip_headsign ?? null,
        stops: order
          .filter((o) => o.direction_id === dir)
          .map((o) => {
            const a = aggByStop.get(o.stop_id);
            if (a === undefined || a.n === 0) {
              return { seq: o.stop_sequence, id: o.stop_id, name: o.stop_name, n: 0, mean: null, meanLo: null, meanHi: null };
            }
            const mean = Number(a.sum_delay) / a.n;
            // Same SE-of-the-mean convention as the stop page's cellCard, so
            // "delay with its interval" means the same thing everywhere on
            // the site rather than two different uncertainty conventions.
            const variance = a.n > 1 ? Math.max(0, Number(a.sum_delay_sq) / a.n - mean * mean) : 0;
            const se = a.n > 1 ? Math.sqrt(variance) / Math.sqrt(a.n) : 0;
            return {
              seq: o.stop_sequence,
              id: o.stop_id,
              name: o.stop_name,
              n: a.n,
              mean: round(mean),
              meanLo: round(mean - 1.96 * se),
              meanHi: round(mean + 1.96 * se),
            };
          }),
      }));

      // Best/worst stops: ranked by % late, restricted to stops with N_CONFIDENT
      // (20) arrivals rather than the lighter N_PROVISIONAL (5) used elsewhere.
      // This ranking makes a claim someone is meant to act on ("go dig into
      // why"), and N_PROVISIONAL only promises "not complete noise" -- a
      // five-observation stop at the top of a ranked list reads as confident
      // regardless of caption. N_CONFIDENT is where the Wilson interval has
      // actually narrowed past "wide open".
      const stopSeq = new Map(order.map((o) => [o.stop_id, o.stop_sequence]));
      const maxSeq = order.length > 0 ? Math.max(...order.map((o) => o.stop_sequence)) : 1;

      const rankedRaw = stopAgg
        .filter((r) => r.n >= N_CONFIDENT)
        .map((r) => ({
          id: r.stop_id,
          name: stopNameById.get(r.stop_id) ?? r.stop_id,
          n: r.n,
          mean: Number(r.sum_delay) / r.n,
          pctLate: round((r.n_late_240 / r.n) * 100),
          seq: stopSeq.get(r.stop_id) ?? null,
        }));

      // Delay accumulates along a route (see the profile chart), so position
      // is a real explanatory variable, not noise -- a stop being "worst"
      // because it's simply near the end of a long route is a different,
      // less interesting fact than a stop that's worse than ITS position
      // predicts. Fit mean delay as a linear function of position-along-route
      // (0..1, so routes of different lengths are comparable) using ordinary
      // least squares over stops that have both a position and enough data,
      // then flag stops whose actual mean sits well above that trend line.
      const withSeq = rankedRaw.filter((r) => r.seq !== null);
      let slope = 0, intercept = 0;
      if (withSeq.length >= 4) {
        const xs = withSeq.map((r) => (r.seq as number) / maxSeq);
        const ys = withSeq.map((r) => r.mean);
        const xBar = xs.reduce((a, b) => a + b, 0) / xs.length;
        const yBar = ys.reduce((a, b) => a + b, 0) / ys.length;
        const num = xs.reduce((s, x, i) => s + (x - xBar) * ((ys[i] ?? yBar) - yBar), 0);
        const den = xs.reduce((s, x) => s + (x - xBar) * (x - xBar), 0);
        slope = den > 0 ? num / den : 0;
        intercept = yBar - slope * xBar;
      }
      // Residual std dev of the fit, so "well above" is relative to how noisy
      // this particular route's delay-vs-position relationship actually is,
      // rather than a fixed number of seconds that would flag every stop on
      // a generally-late route and none on a generally-punctual one.
      const residuals = withSeq.map((r) => r.mean - (intercept + slope * ((r.seq as number) / maxSeq)));
      const residMean = residuals.reduce((a, b) => a + b, 0) / (residuals.length || 1);
      const residSd =
        residuals.length > 1
          ? Math.sqrt(residuals.reduce((s, e) => s + (e - residMean) * (e - residMean), 0) / (residuals.length - 1))
          : 0;

      const ranked = rankedRaw
        .map((r) => {
          const predicted = r.seq === null ? null : intercept + slope * (r.seq / maxSeq);
          const residual = predicted === null ? null : r.mean - predicted;
          return {
            id: r.id,
            name: r.name,
            n: r.n,
            mean: round(r.mean),
            pctLate: r.pctLate,
            seq: r.seq,
            seqOf: r.seq === null ? null : maxSeq,
            // Flagged only when there's enough spread in the fit to judge
            // "surprising" at all (residSd > 0) and the stop sits at least
            // 1.5 residual-SDs above the trend -- comfortably past ordinary
            // route-to-route noise, short of an arbitrary round number.
            flagged: residual !== null && residSd > 0 && residual > 1.5 * residSd,
          };
        })
        .sort((a, b) => a.pctLate - b.pctLate);
      const best = ranked.slice(0, 5);
      const worst = ranked.slice(-5).reverse();

      // Hour-of-day breakdown, summed across all stops on the route.
      const hourAgg = hourAggByRoute.get(route.route_id) ?? [];
      const byHourDay = hourAgg.map((r) => {
        const [hlo, hhi] = wilson(r.n_late_240, r.n);
        return {
          h: r.hour_of_day,
          d: r.day_type,
          n: r.n,
          mean: r.n > 0 ? round(Number(r.sum_delay) / r.n) : 0,
          pctLate: round((r.n_late_240 / r.n) * 100),
          pctLateLo: round(hlo),
          pctLateHi: round(hhi),
        };
      });

      const payload = {
        route: { id: route.route_id, name: route.route_name },
        n: totalN,
        hasUsableData: totalN >= N_PROVISIONAL,
        mean: totalN > 0 ? round(totalDelay / totalN) : 0,
        pctLate: totalN > 0 ? round((totalLate / totalN) * 100) : 0,
        pctLateLo: round(olo),
        pctLateHi: round(ohi),
        nLate: totalLate,
        nEarly: totalEarly,
        profile,
        best,
        worst,
        hours: byHourDay,
        generatedAt: new Date().toISOString(),
      };
      if (totalN >= N_PROVISIONAL) usableRoutes.add(route.route_id);
      const json = JSON.stringify(payload);
      await writeFile(join(outRoot, "routes", `${route.route_id}.json`), json);
      routeFilesWritten += 1;
      routeBytes += Buffer.byteLength(json);
    }

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
        // Whether this stop can show ANY number yet. Today only 26% of stops
        // can, so the picker needs to say so rather than let people tap into
        // a dead end.
        hasUsableData: cells.some((c) => c.n >= N_PROVISIONAL),
        observations: stop.n,
        // Pre-classified so the UI never re-derives a threshold and the two
        // can never disagree about what counts as enough data.
        cells: cells.map((c) => {
          const [lo, hi] = wilson(c.n_late_240, c.n);
          // For a cell too thin to speak for itself, precompute the broadest
          // honest answer so the UI never has to aggregate client-side.
          const fallback =
            c.n >= N_PROVISIONAL ? null : widen(cells, c.route_id, c.hour_of_day, c.day_type, N_PROVISIONAL);
          const fb =
            fallback === null
              ? null
              : (() => {
                  const [flo, fhi] = wilson(fallback.nLate, fallback.n);
                  return {
                    scope: fallback.scope,
                    n: fallback.n,
                    nLate: fallback.nLate,
                    pctLate: round((fallback.nLate / fallback.n) * 100),
                    pctLateLo: round(flo),
                    pctLateHi: round(fhi),
                    mean: round(fallback.meanDelay),
                    hours: fallback.hours,
                  };
                })();
          return {
            fallback: fb,
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
      if (cells.some((c) => c.n >= N_PROVISIONAL)) usableStops.add(stop.stop_id);
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
      growth: growthSeries,
      dayCoverage,
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
        // Lets the picker mark dead ends instead of letting someone tap a stop
        // and find nothing. Today this is true for only 26% of stops.
        usable: usableStops.has(s.stop_id),
      })),
      routes: routeMeta.map((r) => ({
        id: r.route_id,
        name: r.route_name,
        n: r.n,
        usable: usableRoutes.has(r.route_id),
      })),
      generatedAt: new Date().toISOString(),
    };
    const indexJson = JSON.stringify(index);
    await writeFile(join(outRoot, "index.json"), indexJson);

    // ---- bake headline stats into index.html --------------------------------
    // First paint must show real content, not "Loading…", so the shell served
    // to a cold visitor (and to a crawler, which never runs the client fetch)
    // already carries the dataset's real numbers. app.js still re-fetches and
    // re-renders on load -- this only fixes what appears before that finishes.
    //
    // The template lives at site/public/index.html, one directory above the
    // default --out target. This is skipped (not an error) when --out points
    // somewhere without a sibling index.html, e.g. a scratch directory used
    // for inspecting export output.
    const htmlPath = join(dirname(outRoot), "index.html");
    try {
      const template = await readFile(htmlPath, "utf8");
      const ssrBlock = renderHeroSsr(summary, growthSeries);
      const rendered = template.replace(
        /<!-- SSR-BEGIN -->[\s\S]*?<!-- SSR-END -->/,
        `<!-- SSR-BEGIN -->${ssrBlock}<!-- SSR-END -->`,
      );
      if (rendered === template) {
        log.warn({ htmlPath }, "SSR markers not found in index.html; left unmodified");
      } else {
        await writeFile(htmlPath, rendered);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      log.info({ htmlPath }, "no index.html next to --out; skipping SSR injection");
    }

    log.info(
      {
        out: outRoot,
        stopFiles: filesWritten,
        stopBytes: bytes,
        routeFiles: routeFilesWritten,
        routeBytes,
        indexBytes: Buffer.byteLength(indexJson),
        totalMegabytes: +((bytes + routeBytes + Buffer.byteLength(indexJson)) / 1e6).toFixed(2),
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
