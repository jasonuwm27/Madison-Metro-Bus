import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { parse } from "csv-parse";
import { loadConfig } from "../config.js";
import { createSql } from "../db/client.js";
import type { Sql } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import { parseGtfsTime } from "../util/time.js";

/**
 * One-time loader for the static GTFS zip.
 *
 * Versioned, never destructive. Metro republishes mmt_gtfs.zip periodically
 * (the copy loaded 2026-09-15 declares S072_202608240858 and expires
 * 2026-12-05). Observations must be compared against the schedule that was in
 * effect on their own service date, so a new publication is loaded ALONGSIDE
 * the old one under a new feed_version_id rather than replacing it. Overwriting
 * would silently rewrite the meaning of every historical delay.
 *
 * load_completed_at is set only at the very end. The schedule resolver ignores
 * versions without it, so a crash midway leaves a partial version that is
 * inert rather than one that is half-joined against.
 *
 * Re-running with an unchanged zip is a no-op, so this is safe on a cron.
 */

const CACHE_DIR = ".gtfs-cache";
const CHUNK = 5_000;

interface FeedInfo {
  feed_version: string;
  feed_start_date: string;
  feed_end_date: string;
}

const yyyymmdd = (v: string): string =>
  `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;

const bool = (v: string | undefined): boolean => v === "1";
const nullableInt = (v: string | undefined): number | null =>
  v === undefined || v === "" ? null : Number(v);
const nullableFloat = (v: string | undefined): number | null =>
  v === undefined || v === "" ? null : Number.parseFloat(v);
const orNull = (v: string | undefined): string | null =>
  v === undefined || v === "" ? null : v;

async function readCsv(
  path: string,
  onRow: (row: Record<string, string>) => void | Promise<void>,
): Promise<number> {
  const parser = createReadStream(path).pipe(
    parse({ columns: true, skip_empty_lines: true, bom: true, trim: true }),
  );
  let count = 0;
  for await (const row of parser) {
    await onRow(row as Record<string, string>);
    count += 1;
  }
  return count;
}

/** Buffers rows and flushes in chunks, so 603k stop_times never land at once. */
function batcher<T>(size: number, flush: (rows: T[]) => Promise<void>) {
  let buffer: T[] = [];
  return {
    async push(row: T): Promise<void> {
      buffer.push(row);
      if (buffer.length >= size) {
        const chunk = buffer;
        buffer = [];
        await flush(chunk);
      }
    },
    async drain(): Promise<void> {
      if (buffer.length === 0) return;
      const chunk = buffer;
      buffer = [];
      await flush(chunk);
    },
  };
}

async function downloadZip(url: string, log: Logger): Promise<Buffer> {
  log.info({ url }, "downloading static GTFS");
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) {
    throw new Error(`static GTFS download failed: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function loadStatic(options: {
  sql: Sql;
  log: Logger;
  url: string;
  zipPath?: string | undefined;
  force?: boolean;
}): Promise<{ feedVersionId: number | null; feedVersion: string; skipped: boolean }> {
  const { sql, log } = options;

  const zipBuffer =
    options.zipPath !== undefined
      ? await readFile(options.zipPath)
      : await downloadZip(options.url, log);

  const sha256 = createHash("sha256").update(zipBuffer).digest("hex");
  log.info({ bytes: zipBuffer.byteLength, sha256 }, "static GTFS fetched");

  await mkdir(CACHE_DIR, { recursive: true });
  const zipFile = join(CACHE_DIR, "mmt_gtfs.zip");
  await writeFile(zipFile, zipBuffer);

  const zip = new AdmZip(zipFile);
  zip.extractAllTo(CACHE_DIR, true);

  const feedInfoRows: FeedInfo[] = [];
  await readCsv(join(CACHE_DIR, "feed_info.txt"), (row) => {
    feedInfoRows.push(row as unknown as FeedInfo);
  });
  const info = feedInfoRows[0];
  if (info === undefined) throw new Error("feed_info.txt is empty");

  const feedVersion = info.feed_version;
  const startDate = yyyymmdd(info.feed_start_date);
  const endDate = yyyymmdd(info.feed_end_date);

  const [already] = await sql<{ id: number; sha256: string; done: Date | null }[]>`
    select id, sha256, load_completed_at as done
    from gtfs_feed_versions
    where feed_version = ${feedVersion}
  `;
  if (already !== undefined && already.done !== null && options.force !== true) {
    log.info(
      { feedVersion, feedVersionId: already.id },
      "this feed version is already loaded; nothing to do",
    );
    return { feedVersionId: already.id, feedVersion, skipped: true };
  }

  // A re-run of a partial load starts clean; ON DELETE CASCADE clears children.
  if (already !== undefined) {
    await sql`delete from gtfs_feed_versions where id = ${already.id}`;
    log.warn({ feedVersion }, "removed a previous incomplete load of this version");
  }

  const [inserted] = await sql<{ id: number }[]>`
    insert into gtfs_feed_versions (
      feed_version, feed_start_date, feed_end_date, source_url, sha256
    ) values (
      ${feedVersion}, ${startDate}::date, ${endDate}::date, ${options.url}, ${sha256}
    )
    returning id
  `;
  const feedVersionId = inserted?.id;
  if (feedVersionId === undefined) throw new Error("could not create feed version");

  log.info({ feedVersion, feedVersionId, startDate, endDate }, "loading tables");

  const routes = batcher<Record<string, string>>(CHUNK, async (rows) => {
    await sql`
      insert into static_routes ${sql(
        rows.map((r) => ({
          feed_version_id: feedVersionId,
          route_id: r["route_id"] ?? "",
          route_short_name: orNull(r["route_short_name"]),
          route_long_name: orNull(r["route_long_name"]),
          route_type: nullableInt(r["route_type"]),
          route_color: orNull(r["route_color"]),
        })),
      )}
      on conflict do nothing
    `;
  });
  const routeCount = await readCsv(join(CACHE_DIR, "routes.txt"), (r) =>
    routes.push(r),
  );
  await routes.drain();

  const stops = batcher<Record<string, string>>(CHUNK, async (rows) => {
    await sql`
      insert into static_stops ${sql(
        rows.map((r) => ({
          feed_version_id: feedVersionId,
          stop_id: r["stop_id"] ?? "",
          stop_code: orNull(r["stop_code"]),
          stop_name: orNull(r["stop_name"]),
          stop_lat: nullableFloat(r["stop_lat"]),
          stop_lon: nullableFloat(r["stop_lon"]),
        })),
      )}
      on conflict do nothing
    `;
  });
  const stopCount = await readCsv(join(CACHE_DIR, "stops.txt"), (r) => stops.push(r));
  await stops.drain();

  const trips = batcher<Record<string, string>>(CHUNK, async (rows) => {
    await sql`
      insert into static_trips ${sql(
        rows.map((r) => ({
          feed_version_id: feedVersionId,
          trip_id: r["trip_id"] ?? "",
          route_id: r["route_id"] ?? "",
          service_id: r["service_id"] ?? "",
          trip_headsign: orNull(r["trip_headsign"]),
          direction_id: nullableInt(r["direction_id"]),
          block_id: orNull(r["block_id"]),
          shape_id: orNull(r["shape_id"]),
        })),
      )}
      on conflict do nothing
    `;
  });
  const tripCount = await readCsv(join(CACHE_DIR, "trips.txt"), (r) => trips.push(r));
  await trips.drain();

  const calendar = batcher<Record<string, string>>(CHUNK, async (rows) => {
    await sql`
      insert into static_calendar ${sql(
        rows.map((r) => ({
          feed_version_id: feedVersionId,
          service_id: r["service_id"] ?? "",
          monday: bool(r["monday"]),
          tuesday: bool(r["tuesday"]),
          wednesday: bool(r["wednesday"]),
          thursday: bool(r["thursday"]),
          friday: bool(r["friday"]),
          saturday: bool(r["saturday"]),
          sunday: bool(r["sunday"]),
          start_date: yyyymmdd(r["start_date"] ?? ""),
          end_date: yyyymmdd(r["end_date"] ?? ""),
        })),
      )}
      on conflict do nothing
    `;
  });
  const calendarCount = await readCsv(join(CACHE_DIR, "calendar.txt"), (r) =>
    calendar.push(r),
  );
  await calendar.drain();

  const calendarDates = batcher<Record<string, string>>(CHUNK, async (rows) => {
    await sql`
      insert into static_calendar_dates ${sql(
        rows.map((r) => ({
          feed_version_id: feedVersionId,
          service_id: r["service_id"] ?? "",
          date: yyyymmdd(r["date"] ?? ""),
          exception_type: Number(r["exception_type"] ?? 1),
        })),
      )}
      on conflict do nothing
    `;
  });
  const calendarDateCount = await readCsv(
    join(CACHE_DIR, "calendar_dates.txt"),
    (r) => calendarDates.push(r),
  );
  await calendarDates.drain();

  // The big one: 603,662 rows in the 2026-08-24 feed.
  let stopTimeCount = 0;
  const stopTimes = batcher<Record<string, string>>(CHUNK, async (rows) => {
    await sql`
      insert into static_stop_times ${sql(
        rows.map((r) => ({
          feed_version_id: feedVersionId,
          trip_id: r["trip_id"] ?? "",
          stop_sequence: Number(r["stop_sequence"] ?? 0),
          stop_id: r["stop_id"] ?? "",
          // Stored as seconds since service-day start, so 25:10:00 survives
          // as 90600 rather than being wrapped into the previous morning.
          arrival_s: parseGtfsTime(r["arrival_time"] ?? "00:00:00"),
          departure_s: parseGtfsTime(r["departure_time"] ?? "00:00:00"),
          timepoint: r["timepoint"] === "1",
          pickup_type: nullableInt(r["pickup_type"]),
          drop_off_type: nullableInt(r["drop_off_type"]),
        })),
      )}
      on conflict do nothing
    `;
    stopTimeCount += rows.length;
    if (stopTimeCount % 100_000 < CHUNK) {
      log.info({ stopTimeCount }, "stop_times progress");
    }
  });
  await readCsv(join(CACHE_DIR, "stop_times.txt"), (r) => stopTimes.push(r));
  await stopTimes.drain();

  await sql`
    update gtfs_feed_versions
    set load_completed_at = now()
    where id = ${feedVersionId}
  `;

  log.info(
    {
      feedVersion,
      feedVersionId,
      routes: routeCount,
      stops: stopCount,
      trips: tripCount,
      stopTimes: stopTimeCount,
      calendar: calendarCount,
      calendarDates: calendarDateCount,
    },
    "static GTFS load complete",
  );

  return { feedVersionId, feedVersion, skipped: false };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const sql = createSql(cfg);
  try {
    await runMigrations(sql, log);
    await loadStatic({
      sql,
      log,
      url: cfg.staticUrl,
      force: process.argv.includes("--force"),
      zipPath: process.argv
        .find((a) => a.startsWith("--zip="))
        ?.slice("--zip=".length),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked directly, so tests can import loadStatic.
if (process.argv[1]?.includes("load") === true) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
