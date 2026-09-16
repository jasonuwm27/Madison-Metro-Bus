import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statfs } from "node:fs/promises";
import postgres from "postgres";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

const run = promisify(execFile);

/**
 * One weekly signal that says whether everything is fine.
 *
 *   pnpm summary            # print, and ping HC_SUMMARY if configured
 *   pnpm summary --stdout   # print only
 *
 * The point is to be readable in five seconds on a phone without logging into
 * anything. It leads with a verdict, then the numbers behind it.
 *
 * Every check is expressed as a threshold with a reason, not a bare number: a
 * figure you have to interpret each week is a figure you will eventually stop
 * reading.
 */

interface Check {
  label: string;
  value: string;
  ok: boolean;
  note?: string;
}

const bytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`;

async function rcloneSize(remote: string): Promise<{ bytes: number; count: number }> {
  try {
    const { stdout } = await run("rclone", ["size", remote, "--json", "--tpslimit", "4"], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { bytes: number; count: number };
    return parsed;
  } catch {
    return { bytes: -1, count: -1 };
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);
  const sql = postgres(cfg.databaseUrl, { prepare: cfg.pgPrepare, max: 2 });
  const checks: Check[] = [];

  try {
    // ---- collection ------------------------------------------------------
    const [obs] = await sql<{ n: number; days: number; last: Date | null }[]>`
      select count(*)::int n,
             count(distinct service_date)::int days,
             max(last_seen_at) last
      from stop_time_observations`;
    const [week] = await sql<{ n: number }[]>`
      select count(*)::int n from stop_time_observations
      where first_seen_at > now() - interval '7 days'`;

    const minutesSinceWrite =
      obs?.last == null ? Number.POSITIVE_INFINITY : (Date.now() - obs.last.getTime()) / 60000;
    checks.push({
      label: "Collecting",
      value: `last write ${minutesSinceWrite === Number.POSITIVE_INFINITY ? "never" : `${Math.round(minutesSinceWrite)}m ago`}`,
      // The worker polls every 30s; anything past 15 minutes means it is stuck
      // or dead, not merely between polls.
      ok: minutesSinceWrite < 15,
      note: minutesSinceWrite >= 15 ? "worker may be down" : undefined,
    });
    checks.push({
      label: "Rows this week",
      value: (week?.n ?? 0).toLocaleString(),
      // A full week of collection is ~1M rows; well under that means outages.
      ok: (week?.n ?? 0) > 500_000,
      note: (week?.n ?? 0) <= 500_000 ? "below a full week of collection" : undefined,
    });
    checks.push({
      label: "Total observations",
      value: `${(obs?.n ?? 0).toLocaleString()} over ${obs?.days ?? 0} service days`,
      ok: true,
    });

    // ---- poll health -----------------------------------------------------
    const runs = await sql<{ feed: string; polls: number; fails: number }[]>`
      select feed, count(*)::int polls, count(*) filter (where not ok)::int fails
      from ingest_runs where started_at > now() - interval '7 days'
      group by feed order by feed`;
    const totalPolls = runs.reduce((n, r) => n + r.polls, 0);
    const totalFails = runs.reduce((n, r) => n + r.fails, 0);
    const failRate = totalPolls === 0 ? 1 : totalFails / totalPolls;
    checks.push({
      label: "Poll failures",
      value: `${totalFails} of ${totalPolls.toLocaleString()} (${(failRate * 100).toFixed(2)}%)`,
      // Metro's feed has occasional blips; sustained failure is different.
      ok: failRate < 0.02,
      note: failRate >= 0.02 ? "elevated - check feed or network" : undefined,
    });

    // ---- backups ---------------------------------------------------------
    const backups = await rcloneSize("gdrive:BusProject/backups");
    let newestBackupAgeH = Number.POSITIVE_INFINITY;
    try {
      const { stdout } = await run("rclone", ["lsjson", "gdrive:BusProject/backups", "--files-only"], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const files = JSON.parse(stdout) as { Path: string; ModTime: string }[];
      const newest = files
        .filter((f) => f.Path.endsWith(".dump"))
        .map((f) => new Date(f.ModTime).getTime())
        .sort((a, b) => b - a)[0];
      if (newest !== undefined) newestBackupAgeH = (Date.now() - newest) / 3_600_000;
    } catch {
      /* leave as Infinity -> fails the check */
    }
    checks.push({
      label: "Last DB backup",
      value:
        newestBackupAgeH === Number.POSITIVE_INFINITY
          ? "NONE FOUND"
          : `${newestBackupAgeH.toFixed(1)}h ago (${backups.count} kept, ${bytes(backups.bytes)})`,
      // Nightly at 02:00, so anything past 48h means two runs were missed.
      ok: newestBackupAgeH < 48,
      note: newestBackupAgeH >= 48 ? "backup job may be failing" : undefined,
    });

    // ---- archive ---------------------------------------------------------
    const archive = await rcloneSize("gdrive:BusProject/archive");
    checks.push({
      label: "Archive in Drive",
      value: archive.bytes < 0 ? "UNREACHABLE" : `${bytes(archive.bytes)} in ${archive.count} shards`,
      ok: archive.bytes > 0,
      note: archive.bytes < 0 ? "rclone could not reach Drive" : undefined,
    });

    // ---- disk ------------------------------------------------------------
    const fs = await statfs("/var/lib/bus-archive");
    const freeBytes = fs.bavail * fs.bsize;
    const totalBytes = fs.blocks * fs.bsize;
    const freePct = (freeBytes / totalBytes) * 100;
    checks.push({
      label: "Disk free",
      value: `${bytes(freeBytes)} of ${bytes(totalBytes)} (${freePct.toFixed(0)}%)`,
      // A full disk stops collection AND stops the archive being written.
      ok: freePct > 15,
      note: freePct <= 15 ? "low - prune or grow the volume" : undefined,
    });

    // ---- render ----------------------------------------------------------
    const failing = checks.filter((c) => !c.ok);
    const verdict = failing.length === 0 ? "ALL GOOD" : `${failing.length} ISSUE(S)`;

    const lines: string[] = [];
    lines.push(`Madison Metro collector - weekly summary`);
    lines.push(`${verdict}`);
    lines.push("");
    for (const c of checks) {
      lines.push(`${c.ok ? "[ ok ]" : "[FAIL]"} ${c.label}: ${c.value}${c.note ? ` -- ${c.note}` : ""}`);
    }
    lines.push("");
    lines.push(`generated ${new Date().toISOString()}`);
    const report = lines.join("\n");

    console.log("\n" + report + "\n");

    // Ping the summary check so the report is delivered and its absence is
    // itself an alert. A /fail ping when anything is wrong turns the weekly
    // digest into an actual alarm rather than a newsletter.
    const url = process.env["HC_SUMMARY"];
    if (url !== undefined && url !== "" && !process.argv.includes("--stdout")) {
      const suffix = failing.length === 0 ? "" : "/fail";
      await run("curl", ["-fsS", "-m", "15", "--retry", "3", "--data-raw", report, `${url}${suffix}`]).catch(
        () => log.warn("summary ping failed"),
      );
      log.info({ verdict, failing: failing.length }, "summary sent");
    }

    if (failing.length > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
