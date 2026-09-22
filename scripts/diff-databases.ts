import postgres from "postgres";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

/**
 * Row-for-row comparison of two databases collecting the same feed.
 *
 *   pnpm diff-db                       # compare, settled rows only
 *   pnpm diff-db --date=2026-09-17     # one service date
 *   pnpm diff-db --settled-mins=20     # widen the settle window
 *   pnpm diff-db --examples=10         # show more mismatch detail
 *
 * WHY THIS EXISTS
 * Two workers poll Metro independently and write to different databases. The
 * upsert is convergent and keyed identically, so once a row has settled the two
 * databases should agree exactly. Watching them converge is what makes retiring
 * Supabase a decision backed by evidence rather than a leap.
 *
 * SETTLED ROWS ONLY -- this is the crux.
 * Two workers polling at different instants legitimately disagree about rows
 * still in flight: worker A may have seen a prediction worker B has not yet
 * fetched. Comparing those would report a permanent, meaningless mismatch and
 * the databases would never appear to converge.
 *
 * A row is settled when the feed has stopped reporting it -- the bus has passed
 * the stop and the last prediction stands as the observed arrival. We
 * approximate that as last_seen_at older than --settled-mins (default 15),
 * which is comfortably longer than the interval over which Metro keeps
 * re-reporting a stop after passage.
 *
 * Both connections are read-only. This script never writes to either database.
 */

interface Row {
  service_date: string;
  trip_id: string;
  stop_sequence: number;
  is_modified: boolean;
  observed_arrival: string | null;
  delay_seconds: number | null;
  scheduled_source: number;
  route_id: string;
  stop_id: string;
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const key = (r: Row): string =>
  `${r.service_date}|${r.trip_id}|${r.stop_sequence}|${r.is_modified}`;

/**
 * Seconds between two ISO timestamps, or null if either is missing.
 */
function secondsApart(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  return Math.abs(Date.parse(`${a}Z`) - Date.parse(`${b}Z`)) / 1000;
}

/**
 * Fields whose disagreement means the pipelines actually diverged.
 *
 * TOLERANCE, and why it is not a fudge.
 *
 * The two workers poll Metro independently, ~30s out of phase. Each therefore
 * captures a slightly different "last prediction before the bus passed" -- the
 * value the collapsed row model deliberately keeps. Comparing those exactly can
 * never reach 100%, no matter how long the parallel run continues: it is a
 * property of independent sampling, not of the transform.
 *
 * Measured over 249,345 settled rows on 2026-09-22: exact agreement was 89.6%,
 * but among rows where BOTH workers had seen the same number of feed revisions
 * (change_count equal) it was 99.90%. Deltas were median 13s, 97.9% under a
 * minute. That is the signature of phase offset, not divergence.
 *
 * So a sub-minute difference is reported as agreement, and anything larger is
 * a real disagreement worth investigating. --tolerance=0 restores exact
 * comparison.
 */
function compare(a: Row, b: Row, toleranceSec: number): string[] {
  const diffs: string[] = [];
  const apart = secondsApart(a.observed_arrival, b.observed_arrival);
  if (a.observed_arrival !== b.observed_arrival && (apart === null || apart > toleranceSec)) {
    diffs.push(
      `observed_arrival ${a.observed_arrival} != ${b.observed_arrival}` +
        (apart === null ? "" : ` (${apart}s apart)`),
    );
  }
  // delay_seconds is generated from observed_arrival, so it inherits exactly
  // the same phase offset. Judging it separately would double-count the same
  // difference.
  if (
    a.delay_seconds !== b.delay_seconds &&
    Math.abs((a.delay_seconds ?? 0) - (b.delay_seconds ?? 0)) > toleranceSec
  ) {
    diffs.push(`delay_seconds ${a.delay_seconds} != ${b.delay_seconds}`);
  }
  if (a.scheduled_source !== b.scheduled_source) {
    diffs.push(`scheduled_source ${a.scheduled_source} != ${b.scheduled_source}`);
  }
  if (a.route_id !== b.route_id) diffs.push(`route_id ${a.route_id} != ${b.route_id}`);
  if (a.stop_id !== b.stop_id) diffs.push(`stop_id ${a.stop_id} != ${b.stop_id}`);
  return diffs;
}

async function fetchSettled(
  sql: postgres.Sql,
  settledMins: number,
  serviceDate: string | undefined,
): Promise<Row[]> {
  return (await sql<Row[]>`
    select
      to_char(service_date, 'YYYY-MM-DD') as service_date,
      trip_id, stop_sequence, is_modified,
      to_char(observed_arrival at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') as observed_arrival,
      delay_seconds, scheduled_source, route_id, stop_id
    from stop_time_observations
    where last_seen_at < now() - (${settledMins}::text || ' minutes')::interval
      ${serviceDate === undefined ? sql`` : sql`and service_date = ${serviceDate}::date`}
    order by service_date, trip_id, stop_sequence, is_modified
  `) as unknown as Row[];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);

  const localUrl = process.env["LOCAL_DATABASE_URL"];
  if (localUrl === undefined || localUrl === "") {
    throw new Error(
      "LOCAL_DATABASE_URL is required (the VM's own Postgres). " +
        "DATABASE_URL is used as the other side of the comparison.",
    );
  }

  const settledMins = Number(arg("settled-mins") ?? "15");
  const toleranceSec = Number(arg("tolerance") ?? "60");
  const serviceDate = arg("date");
  const maxExamples = Number(arg("examples") ?? "5");

  // Both sides read-only.
  const a = postgres(cfg.databaseUrl, { prepare: cfg.pgPrepare, max: 2 });
  const b = postgres(localUrl, { prepare: true, max: 2 });

  try {
    const [rowsA, rowsB] = await Promise.all([
      fetchSettled(a, settledMins, serviceDate),
      fetchSettled(b, settledMins, serviceDate),
    ]);

    const mapA = new Map(rowsA.map((r) => [key(r), r]));
    const mapB = new Map(rowsB.map((r) => [key(r), r]));

    const onlyA: Row[] = [];
    const onlyB: Row[] = [];
    const mismatched: { key: string; diffs: string[]; a: Row; b: Row }[] = [];
    let matching = 0;
    let withinTolerance = 0;

    for (const [k, ra] of mapA) {
      const rb = mapB.get(k);
      if (rb === undefined) {
        onlyA.push(ra);
        continue;
      }
      const diffs = compare(ra, rb, toleranceSec);
      if (diffs.length === 0) {
        matching += 1;
        if (ra.observed_arrival !== rb.observed_arrival) withinTolerance += 1;
      } else {
        mismatched.push({ key: k, diffs, a: ra, b: rb });
      }
    }
    for (const [k, rb] of mapB) if (!mapA.has(k)) onlyB.push(rb);

    const total = matching + mismatched.length + onlyA.length + onlyB.length;
    const agreement = total === 0 ? 0 : (matching / total) * 100;

    log.info(
      {
        settledMins,
        serviceDate: serviceDate ?? "all",
        supabaseRows: rowsA.length,
        localRows: rowsB.length,
        matching,
        // Of those, how many agreed only because of the tolerance. A large
        // number here is expected and healthy; a large `mismatched` is not.
        matchedWithinTolerance: withinTolerance,
        toleranceSec,
        mismatched: mismatched.length,
        onlyInSupabase: onlyA.length,
        onlyInLocal: onlyB.length,
        agreementPercent: +agreement.toFixed(4),
      },
      "database comparison complete",
    );

    // Examples, not just counts -- a count tells you something is wrong, an
    // example tells you what.
    if (mismatched.length > 0) {
      console.log(`\n  MISMATCHED (showing ${Math.min(maxExamples, mismatched.length)} of ${mismatched.length}):`);
      for (const m of mismatched.slice(0, maxExamples)) {
        console.log(`    ${m.key}`);
        console.log(`      route ${m.a.route_id} stop ${m.a.stop_id}`);
        for (const d of m.diffs) console.log(`      ${d}`);
      }
    }
    if (onlyA.length > 0) {
      console.log(`\n  ONLY IN SUPABASE (showing ${Math.min(maxExamples, onlyA.length)} of ${onlyA.length}):`);
      for (const r of onlyA.slice(0, maxExamples)) {
        console.log(`    ${key(r)}  route ${r.route_id} stop ${r.stop_id} delay=${r.delay_seconds}`);
      }
    }
    if (onlyB.length > 0) {
      console.log(`\n  ONLY IN LOCAL (showing ${Math.min(maxExamples, onlyB.length)} of ${onlyB.length}):`);
      for (const r of onlyB.slice(0, maxExamples)) {
        console.log(`    ${key(r)}  route ${r.route_id} stop ${r.stop_id} delay=${r.delay_seconds}`);
      }
    }

    if (total > 0 && matching === total) {
      console.log("\n  DATABASES AGREE on every settled row.");
    }

    // Non-zero exit on divergence so a timer or CI can act on it.
    if (mismatched.length > 0) process.exitCode = 1;
  } finally {
    await a.end({ timeout: 5 });
    await b.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
