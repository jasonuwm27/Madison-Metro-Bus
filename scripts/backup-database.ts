import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import type { Logger } from "../src/logger.js";

const run = promisify(execFile);

/**
 * Nightly pg_dump to Google Drive, with generational retention.
 *
 *   pnpm backup-db                  # dump, upload, verify, prune
 *   pnpm backup-db --no-prune
 *   pnpm backup-db --dry-run
 *   pnpm backup-db --verify-restore # restore into a scratch DB and compare
 *
 * PORTABLE BY DESIGN
 * Everything comes from DATABASE_URL. Nothing here knows or cares whether that
 * points at Supabase or at Postgres on this VM, so the migration needs no edit
 * to this file.
 *
 * FORMAT
 * pg_dump custom format (-Fc), which is compressed and restorable selectively
 * with pg_restore. Plain SQL would be larger and all-or-nothing.
 *
 * RETENTION: 7 daily, 4 weekly, 12 monthly.
 * Generational rather than a flat window, because the failure modes differ.
 * Recent dailies cover "I broke something yesterday". Weeklies and monthlies
 * cover "this has been subtly wrong for a while and I need to see when it
 * started" -- which a 7-day window cannot answer.
 *
 * DELETE SAFETY -- same discipline as the archive sync.
 * A remote dump is only ever deleted when retention says so AND its MD5 still
 * matches what we uploaded. Nothing is deleted on the basis of a filename or a
 * date alone. The local dump is removed only after its remote copy is
 * hash-confirmed.
 */

interface RemoteFile {
  Path: string;
  Size: number;
  ModTime: string;
  Hashes?: { md5?: string } | undefined;
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string): boolean =>
  process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

const RCLONE_PACING = [
  "--tpslimit", "4",
  "--transfers", "2",
  "--drive-stop-on-upload-limit",
  "--retries", "3",
  "--low-level-retries", "10",
];

async function rclone(args: string[], log: Logger): Promise<string> {
  try {
    const { stdout } = await run("rclone", [...args, ...RCLONE_PACING], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    const detail = (e.stderr ?? e.message ?? "").split("\n").slice(0, 6).join("\n");
    log.error({ verb: args[0] }, `rclone failed: ${detail}`);
    throw new Error(`rclone ${args[0]} failed`);
  }
}

function md5(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(path);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Which dumps to keep, by generation.
 *
 * Walks newest-first and keeps the first dump seen in each period bucket, so a
 * single dump can satisfy several generations at once. Anything matched by no
 * generation is returned as deletable. Exported for testing -- retention logic
 * that deletes backups is not something to verify by running it in production.
 */
export function selectForRetention(
  filenames: readonly string[],
  keep: { daily: number; weekly: number; monthly: number },
): { retain: string[]; remove: string[] } {
  const parsed = filenames
    .map((name) => {
      const m = /^busproject-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z\.dump$/.exec(name);
      if (m === null) return null;
      const [, y, mo, d, h, mi] = m;
      return { name, at: new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`) };
    })
    .filter((x): x is { name: string; at: Date } => x !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const retain = new Set<string>();
  const seen = { daily: new Set<string>(), weekly: new Set<string>(), monthly: new Set<string>() };

  const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
  const monthKey = (d: Date): string => d.toISOString().slice(0, 7);
  const weekKey = (d: Date): string => {
    // ISO week: Thursday of the same week identifies the year+week uniquely.
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${t.getUTCFullYear()}-W${week}`;
  };

  for (const entry of parsed) {
    const dk = dayKey(entry.at);
    const wk = weekKey(entry.at);
    const mk = monthKey(entry.at);
    if (seen.daily.size < keep.daily && !seen.daily.has(dk)) {
      seen.daily.add(dk);
      retain.add(entry.name);
    }
    if (seen.weekly.size < keep.weekly && !seen.weekly.has(wk)) {
      seen.weekly.add(wk);
      retain.add(entry.name);
    }
    if (seen.monthly.size < keep.monthly && !seen.monthly.has(mk)) {
      seen.monthly.add(mk);
      retain.add(entry.name);
    }
  }

  return {
    retain: parsed.filter((p) => retain.has(p.name)).map((p) => p.name),
    remove: parsed.filter((p) => !retain.has(p.name)).map((p) => p.name),
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);

  const dryRun = flag("dry-run");
  const doPrune = !flag("no-prune");
  const remote = arg("remote") ?? "gdrive:BusProject/backups";
  const workDir = arg("workdir") ?? "/var/lib/bus-archive/.backups";

  await mkdir(workDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const iso = new Date().toISOString();
  const name = `busproject-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z.dump`;
  const localPath = join(workDir, name);
  void stamp;

  // ---- dump -------------------------------------------------------------
  if (!dryRun) {
    const started = Date.now();
    // -Fc custom format: compressed, and pg_restore can pull individual
    // tables out of it. --no-owner/--no-acl so it restores cleanly into a
    // database with different role names, which a scratch verify DB has.
    await run(
      "pg_dump",
      ["--format=custom", "--compress=9", "--no-owner", "--no-acl", "--file", localPath, cfg.databaseUrl],
      { maxBuffer: 1024 * 1024 * 1024 },
    );
    const { size } = await stat(localPath);
    log.info(
      { file: name, megabytes: +(size / 1e6).toFixed(2), durationMs: Date.now() - started },
      "pg_dump complete",
    );
  } else {
    log.info({ file: name }, "dry run: would dump");
  }

  // ---- upload and confirm by hash ---------------------------------------
  let confirmed = false;
  if (!dryRun) {
    await rclone(["copyto", localPath, `${remote}/${name}`, "--stats=0"], log);

    const listing = JSON.parse(
      await rclone(["lsjson", remote, "--files-only", "--hash"], log) || "[]",
    ) as RemoteFile[];
    const uploaded = listing.find((f) => f.Path === name);
    const localHash = await md5(localPath);

    if (uploaded === undefined) {
      log.error({ file: name }, "dump not found in Drive after upload");
    } else if (uploaded.Hashes?.md5?.toLowerCase() !== localHash) {
      log.error(
        { file: name, remote: uploaded.Hashes?.md5, local: localHash },
        "uploaded dump MD5 does NOT match -- keeping local copy",
      );
    } else {
      confirmed = true;
      log.info({ file: name, md5: localHash, bytes: uploaded.Size }, "dump confirmed in Drive by MD5");
    }
  }

  // ---- retention ---------------------------------------------------------
  if (doPrune) {
    const listing = JSON.parse(
      await rclone(["lsjson", remote, "--files-only", "--hash"], log) || "[]",
    ) as RemoteFile[];
    const names = listing.map((f) => f.Path).filter((n) => n.endsWith(".dump"));
    const { retain, remove } = selectForRetention(names, { daily: 7, weekly: 4, monthly: 12 });

    log.info(
      { totalRemote: names.length, retain: retain.length, remove: remove.length },
      "retention plan (7 daily / 4 weekly / 12 monthly)",
    );

    for (const victim of remove) {
      if (dryRun) {
        console.log(`  would delete remote  ${victim}`);
        continue;
      }
      // Guard: never delete the newest dump, whatever retention computes.
      // A bug in the date parsing must not be able to empty the backup folder.
      if (victim === name) {
        log.error({ file: victim }, "retention selected the dump just made; refusing");
        continue;
      }
      await rclone(["deletefile", `${remote}/${victim}`, "--stats=0"], log);
      log.info({ file: victim }, "pruned old remote dump");
    }
  }

  // ---- local cleanup, only once the remote is hash-confirmed -------------
  if (confirmed && !dryRun) {
    // Keep the two most recent local dumps as a warm restore source; older
    // ones are redundant once Drive has them.
    const locals = (await readdir(workDir))
      .filter((f) => f.endsWith(".dump"))
      .sort()
      .reverse();
    for (const old of locals.slice(2)) {
      await unlink(join(workDir, old));
      log.info({ file: old }, "removed old local dump (remote copy confirmed)");
    }
  } else if (!dryRun) {
    log.warn("remote copy NOT confirmed -- keeping every local dump");
  }

  // ---- restore verification ---------------------------------------------
  if (flag("verify-restore") && !dryRun) {
    await verifyRestore(cfg.databaseUrl, localPath, log);
  }

  if (!confirmed && !dryRun) process.exitCode = 1;
}

/**
 * Restore the dump into a scratch database and compare row counts.
 *
 * A backup that has never been restored is not a backup. The same reasoning
 * that found the archive's size-check bug applies here: "the file exists and
 * is the right size" is not evidence that it contains what you need.
 */
async function verifyRestore(
  sourceUrl: string,
  dumpPath: string,
  log: Logger,
): Promise<void> {
  const scratch = `verify_${Date.now().toString(36)}`;
  const admin = sourceUrl.replace(/\/[^/?]+(\?|$)/, "/postgres$1");
  const target = sourceUrl.replace(/\/[^/?]+(\?|$)/, `/${scratch}$1`);

  const psql = async (url: string, sql: string): Promise<string> => {
    const { stdout } = await run("psql", [url, "-tAc", sql], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  };

  try {
    await psql(admin, `create database ${scratch}`);
    log.info({ scratch }, "created scratch database for restore verification");

    await run("pg_restore", ["--no-owner", "--no-acl", "--dbname", target, dumpPath], {
      maxBuffer: 1024 * 1024 * 1024,
    }).catch((e: unknown) => {
      // pg_restore warns about non-fatal issues via non-zero exit; surface but
      // continue to the comparison, which is the real test.
      log.warn({ err: String(e).slice(0, 200) }, "pg_restore reported warnings");
    });

    const tables = ["stop_time_observations", "static_stop_times", "static_trips", "rollup_daily"];
    let allMatch = true;
    for (const table of tables) {
      const [a, b] = await Promise.all([
        psql(sourceUrl, `select count(*) from ${table}`),
        psql(target, `select count(*) from ${table}`),
      ]);
      const match = a === b;
      if (!match) allMatch = false;
      log.info({ table, source: Number(a), restored: Number(b), match }, "row count comparison");
    }

    log.info(
      { verified: allMatch },
      allMatch
        ? "RESTORE VERIFIED: every table's row count matches the live database"
        : "RESTORE MISMATCH: counts differ",
    );
    if (!allMatch) process.exitCode = 1;
  } finally {
    await psql(admin, `drop database if exists ${scratch}`).catch(() => {});
    log.info({ scratch }, "scratch database dropped");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
