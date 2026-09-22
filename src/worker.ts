import { HourlyNdjsonArchive } from "./archive/archive.js";
import type { ShardUploader } from "./archive/archive.js";
import { createR2Uploader } from "./archive/r2.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createSql } from "./db/client.js";
import type { Sql } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ensurePartitions } from "./db/partitions.js";
import { ScheduleCache } from "./db/schedule.js";
import { upsertObservations } from "./db/upsert.js";
import { decodeTripUpdatesFeed, FeedDecodeError } from "./gtfsrt/decode.js";
import { fetchFeed } from "./gtfsrt/fetch.js";
import { transformFeed } from "./gtfsrt/transform.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { localDateString } from "./util/time.js";

/**
 * The collector.
 *
 * Three independent poll loops, one per feed. TripUpdates is decoded and
 * written to Postgres; VehiclePositions and Alerts are archived raw only.
 * Decoding just the one feed keeps phase 1 small, while archiving all three
 * means the history exists when the others are wanted -- none of it is
 * backfillable, so "add it later" would mean permanently missing the days in
 * between.
 *
 * The overriding requirement is that the process stays alive. Every failure
 * path here degrades rather than exits: a feed that will not fetch is retried
 * next tick, a payload that will not decode is logged and archived anyway, and
 * a database that rejects a batch loses that poll rather than the worker.
 */

class Shutdown {
  // A SET of waiters, not a single handle.
  //
  // This held one `#resolve`, which silently broke shutdown: three poll loops
  // sleep concurrently, and each call to sleep() overwrote the previous loop's
  // resolver. On SIGTERM only the most recent sleeper woke; the others ran out
  // their full timer. With the alerts loop sleeping 300s against a
  // TimeoutStopSec of 60, systemd escalated to SIGKILL on every stop -- killing
  // the process mid-write and truncating the very archive shards this design
  // treats as the record of record.
  //
  // A Set wakes every waiter, so the slowest loop to exit is bounded by how
  // long its in-flight poll takes, not by its poll interval.
  readonly #waiters = new Set<() => void>();
  stopping = false;

  signal(): void {
    this.stopping = true;
    for (const wake of [...this.#waiters]) wake();
    this.#waiters.clear();
  }

  /** Sleep that returns immediately once shutdown is requested. */
  async sleep(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.#waiters.add(wake);
    });
  }
}

interface PollOutcome {
  ok: boolean;
  httpStatus: number | null;
  attempts: number;
  payloadBytes: number;
  feedTimestampMs: number | null;
  feedAgeS: number | null;
  entitiesTotal: number | null;
  entitiesDecoded: number | null;
  rowsWritten: number | null;
  rowsChanged: number | null;
  rowsSkipped: number | null;
  error: string | null;
  extra: Record<string, unknown>;
}

const emptyOutcome = (): PollOutcome => ({
  ok: false,
  httpStatus: null,
  attempts: 0,
  payloadBytes: 0,
  feedTimestampMs: null,
  feedAgeS: null,
  entitiesTotal: null,
  entitiesDecoded: null,
  rowsWritten: null,
  rowsChanged: null,
  rowsSkipped: null,
  error: null,
  extra: {},
});

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const shutdown = new Shutdown();

  log.info(
    {
      pollIntervalMs: cfg.pollIntervalMs,
      archiveSink: cfg.archive.sink,
      timezone: cfg.timezone,
      healthcheck: cfg.healthcheck.url !== "",
    },
    "collector starting",
  );

  const sql = createSql(cfg);
  await runMigrations(sql, log);

  const today = localDateString(Date.now(), cfg.timezone);
  await ensurePartitions(sql, {
    fromDate: today,
    weeksAhead: 6,
    weeksBehind: 2,
    logger: log,
  });

  const schedule = new ScheduleCache(sql, log);
  await schedule.initialise(today);

  // Seed the running total once at startup rather than querying it every poll
  // -- dataset_summary aggregates rollup_daily, which is cheap but pointless
  // to hit every 30s when the poll loop already knows how many NEW rows it
  // just wrote. After the seed, the total advances in-process by rowsChanged.
  let totalObservations = 0;
  try {
    const [row] = await sql<{ total_observations: string }[]>`
      select coalesce(total_observations, 0)::text as total_observations from dataset_summary
    `;
    totalObservations = Number(row?.total_observations ?? 0);
  } catch (error) {
    log.warn({ err: error }, "could not seed observation total for live status");
  }
  let lastLiveStatusPushMs = 0;

  let uploader: ShardUploader | undefined;
  if (cfg.archive.sink === "r2") uploader = createR2Uploader(cfg.archive.r2);
  const archive = new HourlyNdjsonArchive({
    dir: cfg.archive.dir,
    logger: log,
    uploader,
    deleteLocalAfterUpload: cfg.archive.deleteLocalAfterUpload,
    compression: cfg.archive.compression,
  });

  // A day boundary means new partitions may be needed and the trip cache is
  // stale. Checked on each TripUpdates poll rather than on a timer, so it
  // cannot fire while the worker is down and be missed.
  let currentServiceDay = today;
  const onDayRollover = async (): Promise<void> => {
    const now = localDateString(Date.now(), cfg.timezone);
    if (now === currentServiceDay) return;
    currentServiceDay = now;
    log.info({ date: now }, "service day rolled over");
    await ensurePartitions(sql, {
      fromDate: now,
      weeksAhead: 6,
      weeksBehind: 0,
      logger: log,
    });
    schedule.clearTrips();
    await schedule.initialise(now);
  };

  const pollTripUpdates = async (): Promise<PollOutcome> => {
    const outcome = emptyOutcome();
    const fetched = await fetchFeed(cfg.feeds.tripUpdates, {
      ...cfg.fetch,
      onRetry: ({ attempt, delayMs, error }) =>
        log.warn({ feed: "trips", attempt, delayMs, error }, "retrying feed fetch"),
    });
    outcome.httpStatus = fetched.httpStatus;
    outcome.attempts = fetched.attempts;
    outcome.payloadBytes = fetched.payload.byteLength;

    // Archive BEFORE decoding. If the decode throws, the bytes are already
    // safe, and a decoder bug becomes a replay rather than a permanent hole.
    await archive.write({
      feed: "trips",
      fetchedAtMs: Date.now(),
      httpStatus: fetched.httpStatus,
      feedTimestampMs: null,
      attempts: fetched.attempts,
      payload: fetched.payload,
    });

    const feed = decodeTripUpdatesFeed(fetched.payload);
    outcome.feedTimestampMs = feed.headerTimestampMs;
    outcome.feedAgeS = Math.round((Date.now() - feed.headerTimestampMs) / 1000);
    outcome.entitiesTotal = feed.entityTotal;
    outcome.entitiesDecoded = feed.tripUpdates.length;

    await onDayRollover();

    const index = await schedule.indexFor(feed.tripUpdates.map((t) => t.tripId));
    const { rows, stats } = transformFeed(feed, index, cfg.timezone);

    const written = await upsertObservations(sql, rows);
    outcome.rowsWritten = written.rowsWritten;
    outcome.rowsChanged = written.rowsChanged;
    outcome.rowsSkipped =
      stats.skippedNoData + stats.skippedDepartureOnly + stats.skippedNoTime;
    outcome.ok = true;
    // Distinct real vehicles reporting this poll -- excludes the planned-
    // itinerary half of a detour trip's doubled entity, which carries no
    // vehicleId (see CLAUDE.md, "detoured trips are published twice").
    // Deduplicated because a single bus can appear against more than one
    // tripUpdate entity within a poll (e.g. mid-transfer between trips).
    const busesTracked = new Set(
      feed.tripUpdates.filter((t) => t.vehicleId !== null).map((t) => t.vehicleId),
    ).size;
    outcome.extra = {
      entityCounts: feed.entityCounts,
      unmatchedTrips: stats.unmatchedTrips,
      unmatchedStops: stats.unmatchedStops,
      unresolvedServiceDate: stats.unresolvedServiceDate,
      duplicateKeys: stats.duplicateKeys,
      modifiedTrips: stats.modifiedTrips,
      unidentifiableTrips: feed.unidentifiableTrips,
      newRows: written.rowsChanged,
      cachedTrips: schedule.cachedTripCount,
      busesTracked,
    };
    return outcome;
  };

  /** Archive-only feeds. Decoded in a later phase; the bytes are kept now. */
  const pollRawOnly = (feedName: string, url: string) => async (): Promise<PollOutcome> => {
    const outcome = emptyOutcome();
    const fetched = await fetchFeed(url, {
      ...cfg.fetch,
      onRetry: ({ attempt, delayMs, error }) =>
        log.warn({ feed: feedName, attempt, delayMs, error }, "retrying feed fetch"),
    });
    outcome.httpStatus = fetched.httpStatus;
    outcome.attempts = fetched.attempts;
    outcome.payloadBytes = fetched.payload.byteLength;
    await archive.write({
      feed: feedName,
      fetchedAtMs: Date.now(),
      httpStatus: fetched.httpStatus,
      feedTimestampMs: null,
      attempts: fetched.attempts,
      payload: fetched.payload,
    });
    outcome.ok = true;
    return outcome;
  };

  const runLoop = async (
    feedName: string,
    intervalMs: number,
    poll: () => Promise<PollOutcome>,
    pingHealthcheck: boolean,
    onPollComplete?: (outcome: PollOutcome) => void,
  ): Promise<void> => {
    while (!shutdown.stopping) {
      const startedAt = new Date();
      let outcome = emptyOutcome();
      try {
        outcome = await poll();
      } catch (error) {
        outcome.ok = false;
        outcome.error =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (error instanceof FeedDecodeError) {
          // Raw bytes are already archived, so this is recoverable by replay.
          log.error({ feed: feedName, err: error }, "feed decode failed");
        } else {
          log.error({ feed: feedName, err: error }, "poll failed");
        }
      }

      const durationMs = Date.now() - startedAt.getTime();

      if (outcome.ok) {
        log.info(
          {
            feed: feedName,
            durationMs,
            feedAgeS: outcome.feedAgeS,
            payloadBytes: outcome.payloadBytes,
            entitiesTotal: outcome.entitiesTotal,
            entitiesDecoded: outcome.entitiesDecoded,
            rowsWritten: outcome.rowsWritten,
            rowsSkipped: outcome.rowsSkipped,
            attempts: outcome.attempts,
            ...outcome.extra,
          },
          "poll complete",
        );
      }

      await recordRun(sql, log, feedName, startedAt, durationMs, outcome);
      if (outcome.ok && pingHealthcheck) await ping(cfg, log);
      if (outcome.ok && onPollComplete) onPollComplete(outcome);

      await shutdown.sleep(Math.max(0, intervalMs - durationMs));
    }
  };

  const onTripsPollComplete = (outcome: PollOutcome): void => {
    totalObservations += outcome.rowsChanged ?? 0;
    if (cfg.liveStatus.url === "") return;
    const now = Date.now();
    // Throttled independently of the 30s poll interval so the write rate is
    // fixed at deploy time (see workers/live-status/README.md's budget math)
    // rather than tracking whatever POLL_INTERVAL_TRIPS_MS happens to be.
    if (now - lastLiveStatusPushMs < cfg.liveStatus.pushIntervalMs) return;
    lastLiveStatusPushMs = now;
    pushLiveStatus(cfg, log, {
      rowsLastPoll: outcome.rowsWritten ?? 0,
      totalObservations,
      busesTracked: typeof outcome.extra["busesTracked"] === "number" ? outcome.extra["busesTracked"] : 0,
      lastPollAt: new Date().toISOString(),
    });
  };

  const loops = [
    runLoop("trips", cfg.pollIntervalMs.tripUpdates, pollTripUpdates, true, onTripsPollComplete),
    runLoop(
      "vehicles",
      cfg.pollIntervalMs.vehiclePositions,
      pollRawOnly("vehicles", cfg.feeds.vehiclePositions),
      false,
    ),
    runLoop(
      "alerts",
      cfg.pollIntervalMs.alerts,
      pollRawOnly("alerts", cfg.feeds.alerts),
      false,
    ),
  ];

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info({ signal }, "shutdown requested; closing archive shards");
      shutdown.signal();
    });
  }

  await Promise.all(loops);
  await archive.close();
  await sql.end({ timeout: 5 });
  log.info("collector stopped cleanly");
}

/**
 * Persist the per-poll summary. Failures here are swallowed: the operational
 * record must never be the reason collection stops.
 */
async function recordRun(
  sql: Sql,
  log: Logger,
  feed: string,
  startedAt: Date,
  durationMs: number,
  outcome: PollOutcome,
): Promise<void> {
  try {
    await sql`
      insert into ingest_runs (
        feed, started_at, duration_ms, ok, http_status, feed_age_s,
        feed_timestamp, payload_bytes, entities_total, entities_decoded,
        rows_written, rows_changed, rows_skipped, attempts, error
      ) values (
        ${feed}, ${startedAt}, ${durationMs}, ${outcome.ok},
        ${outcome.httpStatus}, ${outcome.feedAgeS},
        ${outcome.feedTimestampMs === null ? null : new Date(outcome.feedTimestampMs)},
        ${outcome.payloadBytes}, ${outcome.entitiesTotal},
        ${outcome.entitiesDecoded}, ${outcome.rowsWritten},
        ${outcome.rowsChanged}, ${outcome.rowsSkipped},
        ${outcome.attempts}, ${outcome.error}
      )
    `;
  } catch (error) {
    log.warn({ err: error }, "could not record ingest run");
  }
}

/**
 * Healthcheck ping after a successful poll.
 *
 * Worker death is the only unrecoverable failure: every minute it is down is a
 * minute of history that cannot be reconstructed from anywhere. A dead worker
 * also stops all database activity, so after seven days Supabase pauses the
 * project on top of the outage. Configure the check to alert after 20 minutes.
 */
async function ping(cfg: Config, log: Logger): Promise<void> {
  if (cfg.healthcheck.url === "") return;
  try {
    await fetch(cfg.healthcheck.url, {
      signal: AbortSignal.timeout(cfg.healthcheck.timeoutMs),
    });
  } catch (error) {
    log.warn({ err: error }, "healthcheck ping failed");
  }
}

interface LiveStatusPayload {
  rowsLastPoll: number;
  totalObservations: number;
  busesTracked: number;
  lastPollAt: string;
}

/**
 * Push the "is this alive" blob to the Cloudflare Worker fronting KV.
 *
 * Not awaited by the caller's poll loop -- this is cosmetic (a pulse on the
 * landing page), never load-bearing, so it must not be able to slow down or
 * fail the collection loop. Failure is logged at debug, not warn: a transient
 * miss here just means the pulse looks briefly stale, which is a acceptable
 * outcome for a feature that exists purely to look alive, not one worth
 * paging anyone over.
 */
function pushLiveStatus(cfg: Config, log: Logger, payload: LiveStatusPayload): void {
  if (cfg.liveStatus.url === "") return;
  fetch(cfg.liveStatus.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.liveStatus.token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5_000),
  }).catch((error: unknown) => {
    log.debug({ err: error }, "live status push failed");
  });
}

main().catch((error: unknown) => {
  // Last resort. Anything reaching here happened during startup, before the
  // loops could absorb it; exiting non-zero lets the supervisor restart us.
  console.error(error);
  process.exit(1);
});
