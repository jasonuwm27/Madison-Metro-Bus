import { join } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

/**
 * Environment configuration, validated once at startup.
 *
 * The worker is meant to run unattended for weeks. A typo in an env var should
 * crash the process immediately and loudly, not surface at 3am as a confusing
 * runtime error after the process has already missed six hours of collection.
 */

/**
 * Load .env exactly once, from inside loadConfig rather than as a top-level
 * `import "dotenv/config"` in each entry point.
 *
 * Entry-point imports are fragile in two ways: ESM hoists all imports and
 * evaluates them in source order, so a dotenv import placed below a module that
 * reads process.env at evaluation time runs too late; and every new entry point
 * (a script, a backfill tool, a one-off) has to remember to add it. Doing it
 * here means the only way to obtain config is through a function that has
 * already loaded the file, so a future entry point cannot reintroduce the bug.
 *
 * `override: false` is the default and is what we want: a real environment
 * variable set by the host (Heroku, systemd, CI) must beat a stale local .env.
 */
let envFileLoaded = false;
function ensureEnvFileLoaded(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  dotenv.config({ quiet: true });
}

/**
 * Where bulk files go by default.
 *
 * Deliberately outside the project tree on Windows. This repo commonly lives
 * under OneDrive, and the archive writes a compressed shard continuously while
 * holding the file open — that means both a few GB per month uploaded to
 * Microsoft and lock contention with the sync client on a file the worker is
 * still writing. Neither is acceptable for the one copy of data that cannot be
 * re-collected.
 */
const DEFAULT_ARCHIVE_DIR =
  process.platform === "win32" ? "C:\\bus-archive" : "./archive";
const DEFAULT_GTFS_CACHE_DIR =
  process.platform === "win32" ? join("C:\\bus-archive", ".gtfs-cache") : "./.gtfs-cache";

const intFromEnv = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  DATABASE_URL: z
    .string({
      required_error:
        "DATABASE_URL is required. This is the POSTGRES connection string from " +
        "Supabase > Project Settings > Database > Connection string > URI. " +
        "It is NOT SUPABASE_URL, and the password is not any of the API keys.",
    })
    .min(1),
  PGPREPARE: z.enum(["true", "false"]).default("true"),
  PGPOOL_MAX: intFromEnv(4),

  GTFSRT_TRIP_UPDATES_URL: z
    .string()
    .url()
    .default("https://metromap.cityofmadison.com/gtfsrt/trips"),
  GTFSRT_VEHICLE_POSITIONS_URL: z
    .string()
    .url()
    .default("https://metromap.cityofmadison.com/gtfsrt/vehicles"),
  GTFSRT_ALERTS_URL: z
    .string()
    .url()
    .default("https://metromap.cityofmadison.com/gtfsrt/alerts"),
  GTFS_STATIC_URL: z
    .string()
    .url()
    .default("https://transitdata.cityofmadison.com/GTFS/mmt_gtfs.zip"),

  POLL_INTERVAL_TRIPS_MS: intFromEnv(30_000),
  POLL_INTERVAL_VEHICLES_MS: intFromEnv(30_000),
  POLL_INTERVAL_ALERTS_MS: intFromEnv(300_000),

  FETCH_TIMEOUT_MS: intFromEnv(20_000),
  FETCH_MAX_RETRIES: z.coerce.number().int().min(0).default(4),
  BACKOFF_BASE_MS: intFromEnv(1_000),
  BACKOFF_MAX_MS: intFromEnv(120_000),

  ARCHIVE_SINK: z.enum(["local", "r2"]).default("local"),
  // rclone remote for the permanent archive, e.g. "gdrive:bus-archive".
  ARCHIVE_REMOTE: z.string().default("gdrive:bus-archive"),
  ARCHIVE_PRUNE_DAYS: intFromEnv(90),
  ARCHIVE_COMPRESSION: z.enum(["gzip", "brotli"]).default("gzip"),
  ARCHIVE_DIR: z.string().default(DEFAULT_ARCHIVE_DIR),
  GTFS_CACHE_DIR: z.string().default(DEFAULT_GTFS_CACHE_DIR),
  R2_ACCOUNT_ID: z.string().default(""),
  R2_BUCKET: z.string().default(""),
  R2_ACCESS_KEY_ID: z.string().default(""),
  R2_SECRET_ACCESS_KEY: z.string().default(""),
  ARCHIVE_DELETE_LOCAL_AFTER_UPLOAD: z
    .enum(["true", "false"])
    .default("false"),

  AGENCY_TIMEZONE: z.string().default("America/Chicago"),

  HEALTHCHECK_URL: z.string().default(""),
  HEALTHCHECK_TIMEOUT_MS: intFromEnv(5_000),

  // Empty disables the push entirely -- same pattern as HEALTHCHECK_URL, so a
  // worker with no live-status configured behaves exactly as it always has.
  LIVE_STATUS_URL: z.string().default(""),
  LIVE_STATUS_TOKEN: z.string().default(""),
  LIVE_STATUS_PUSH_INTERVAL_MS: intFromEnv(120_000),

  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_FORMAT: z.enum(["json", "pretty"]).default("json"),
});

export type Config = {
  databaseUrl: string;
  pgPrepare: boolean;
  pgPoolMax: number;
  feeds: {
    tripUpdates: string;
    vehiclePositions: string;
    alerts: string;
  };
  staticUrl: string;
  gtfsCacheDir: string;
  pollIntervalMs: {
    tripUpdates: number;
    vehiclePositions: number;
    alerts: number;
  };
  fetch: {
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
  };
  archive: {
    sink: "local" | "r2";
    compression: "gzip" | "brotli";
    dir: string;
    remote: string;
    pruneDays: number;
    r2: {
      accountId: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };
    deleteLocalAfterUpload: boolean;
  };
  timezone: string;
  healthcheck: { url: string; timeoutMs: number };
  liveStatus: { url: string; token: string; pushIntervalMs: number };
  log: { level: string; format: "json" | "pretty" };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Must run before the schema reads anything. dotenv mutates process.env in
  // place, so the default parameter's reference sees the loaded values.
  ensureEnvFileLoaded();

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  // Validate the timezone eagerly. An unknown zone name makes every service
  // date wrong, and Intl throws only at first use -- which would be deep inside
  // the transform, long after startup.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: e.AGENCY_TIMEZONE });
  } catch {
    throw new Error(`AGENCY_TIMEZONE is not a valid IANA zone: ${e.AGENCY_TIMEZONE}`);
  }

  if (e.ARCHIVE_SINK === "r2") {
    const missing = (
      [
        ["R2_ACCOUNT_ID", e.R2_ACCOUNT_ID],
        ["R2_BUCKET", e.R2_BUCKET],
        ["R2_ACCESS_KEY_ID", e.R2_ACCESS_KEY_ID],
        ["R2_SECRET_ACCESS_KEY", e.R2_SECRET_ACCESS_KEY],
      ] as const
    )
      .filter(([, v]) => v === "")
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(
        `ARCHIVE_SINK=r2 requires: ${missing.join(", ")}. ` +
          `Set ARCHIVE_SINK=local to archive to disk instead.`,
      );
    }
  }

  return {
    databaseUrl: e.DATABASE_URL,
    pgPrepare: e.PGPREPARE === "true",
    pgPoolMax: e.PGPOOL_MAX,
    feeds: {
      tripUpdates: e.GTFSRT_TRIP_UPDATES_URL,
      vehiclePositions: e.GTFSRT_VEHICLE_POSITIONS_URL,
      alerts: e.GTFSRT_ALERTS_URL,
    },
    staticUrl: e.GTFS_STATIC_URL,
    gtfsCacheDir: e.GTFS_CACHE_DIR,
    pollIntervalMs: {
      tripUpdates: e.POLL_INTERVAL_TRIPS_MS,
      vehiclePositions: e.POLL_INTERVAL_VEHICLES_MS,
      alerts: e.POLL_INTERVAL_ALERTS_MS,
    },
    fetch: {
      timeoutMs: e.FETCH_TIMEOUT_MS,
      maxRetries: e.FETCH_MAX_RETRIES,
      backoffBaseMs: e.BACKOFF_BASE_MS,
      backoffMaxMs: e.BACKOFF_MAX_MS,
    },
    archive: {
      sink: e.ARCHIVE_SINK,
      compression: e.ARCHIVE_COMPRESSION,
      dir: e.ARCHIVE_DIR,
      remote: e.ARCHIVE_REMOTE,
      pruneDays: e.ARCHIVE_PRUNE_DAYS,
      r2: {
        accountId: e.R2_ACCOUNT_ID,
        bucket: e.R2_BUCKET,
        accessKeyId: e.R2_ACCESS_KEY_ID,
        secretAccessKey: e.R2_SECRET_ACCESS_KEY,
      },
      deleteLocalAfterUpload: e.ARCHIVE_DELETE_LOCAL_AFTER_UPLOAD === "true",
    },
    timezone: e.AGENCY_TIMEZONE,
    healthcheck: { url: e.HEALTHCHECK_URL, timeoutMs: e.HEALTHCHECK_TIMEOUT_MS },
    liveStatus: {
      url: e.LIVE_STATUS_URL,
      token: e.LIVE_STATUS_TOKEN,
      pushIntervalMs: e.LIVE_STATUS_PUSH_INTERVAL_MS,
    },
    log: { level: e.LOG_LEVEL, format: e.LOG_FORMAT },
  };
}
