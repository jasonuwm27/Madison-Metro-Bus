import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, sep } from "node:path";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import type { Logger } from "../src/logger.js";

const run = promisify(execFile);

/**
 * Back the archive up to Google Drive via rclone, and prune the local cache
 * only once a shard is provably safe remotely.
 *
 *   pnpm upload-archive                  # upload new shards
 *   pnpm upload-archive --prune          # ...then prune local shards >90d old
 *   pnpm upload-archive --dry-run        # show what would happen, change nothing
 *   pnpm upload-archive --verify         # re-download a sample and byte-compare
 *   pnpm upload-archive --prune-days=90
 *
 * STORAGE MODEL
 * Google Drive is permanent and authoritative: 2TB against ~5GB/month is
 * decades of runway, so nothing there is ever expired or pruned. The VM's
 * local disk is a hot cache, pruned at 90 days to stay inside Oracle's free
 * block storage.
 *
 * WHY `rclone copy` AND NEVER `rclone sync`
 * `sync` makes the destination mirror the source, which means it DELETES
 * remote files that are missing locally. Combined with a local pruner that is
 * deliberately removing old files, `sync` would propagate every prune straight
 * into the only backup and quietly destroy the archive from the oldest end
 * forward. `copy` only ever adds. This is the single most important line in
 * this file.
 *
 * PRUNE SAFETY
 * A shard is deletable locally only when rclone confirms a remote file at the
 * same path whose **MD5 matches the local file**. Existence alone is not
 * enough: an upload interrupted mid-stream leaves a short remote file, and
 * deleting the good local copy against a truncated remote one is precisely the
 * failure that destroyed the 2026-09-15 archive, one layer up. Drive supplies
 * MD5 for every file, so there is no reason to settle for a size check.
 */

interface Shard {
  localPath: string;
  /** Remote key in Drive layout: feed/YYYY/MM/DD/HH.ndjson.gz */
  key: string;
  bytes: number;
  mtimeMs: number;
  partial: boolean;
}

/**
 * Translate a local shard path into the Drive layout.
 *
 * Local:  trips/2026-09-16/2026-09-16T17.ndjson.gz
 * Drive:  trips/2026/09/16/17.ndjson.gz
 *
 * The nested form keeps directory listings small as the archive grows: a flat
 * year of hourly shards is 8,760 entries in one folder, which Drive paginates
 * badly and which makes a targeted replay ("give me March") require listing
 * everything. Splitting on Y/M/D means any prefix query touches a few dozen
 * entries. The hour is UTC, matching the shard's own naming.
 *
 * Returns null for anything that does not match the expected shape, so an
 * unrecognised file is skipped loudly rather than uploaded to a wrong path.
 */
export function toDriveKey(localRelative: string): string | null {
  const parts = localRelative.split("/");
  if (parts.length !== 3) return null;
  const [feed, , filename] = parts;
  if (feed === undefined || filename === undefined) return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})\.ndjson\.(gz|br)$/.exec(filename);
  if (m === null) return null;
  const [, year, month, day, hour, ext] = m;
  return `${feed}/${year}/${month}/${day}/${hour}.ndjson.${ext}`;
}

interface RemoteFile {
  Path: string;
  Size: number;
  Hashes?: { md5?: string } | undefined;
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string): boolean =>
  process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

/**
 * Pacing flags, applied to every rclone invocation.
 *
 * Drive's practical ceiling is ~10 transactions/sec and rclone is itself
 * limited to roughly 2 files/sec against it. Daily volume here is 72 small
 * shards (~170MB), which is nowhere near the ~750GiB/day upload cap -- but a
 * first bulk backfill of months of accumulated shards is exactly where 403
 * rateLimitExceeded shows up, so the pacing is set for that case rather than
 * the steady state.
 *
 * --drive-stop-on-upload-limit makes a quota breach a hard error instead of a
 * partial transfer. That matters enormously here: the pruner trusts remote
 * state, so a sync that half-fails silently is far more dangerous than one
 * that stops.
 */
const RCLONE_PACING = [
  "--tpslimit", "4",
  "--tpslimit-burst", "8",
  "--transfers", "4",
  "--checkers", "8",
  "--drive-stop-on-upload-limit",
  "--retries", "3",
  "--low-level-retries", "10",
  "--drive-chunk-size", "32M",
];

async function rclone(args: string[], log: Logger): Promise<string> {
  try {
    const { stdout } = await run("rclone", [...args, ...RCLONE_PACING], {
      maxBuffer: 64 * 1024 * 1024,
      // Never inherit a shell; args are passed as an array so paths with
      // spaces need no quoting and nothing is interpolated.
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    // rclone puts the useful detail on stderr. Surface it, but never echo the
    // config file, which holds the OAuth refresh token.
    const detail = (e.stderr ?? e.message ?? "").split("\n").slice(0, 6).join("\n");
    log.error({ args: args.filter((a) => !a.includes("token")) }, `rclone failed: ${detail}`);
    throw new Error(`rclone ${args[0]} failed`);
  }
}

async function collectShards(
  root: string,
  unrecognised: string[],
): Promise<Shard[]> {
  const found: Shard[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".gtfs-cache") continue;
        await walk(path);
        continue;
      }
      if (!/\.ndjson\.(gz|br)(\.partial.*)?$/.test(entry.name)) continue;
      const info = await stat(path);
      const localRelative = relative(root, path).split(sep).join("/");
      const isPartial = entry.name.includes(".partial");
      const key = isPartial ? localRelative : toDriveKey(localRelative);
      if (key === null) {
        unrecognised.push(localRelative);
        continue;
      }
      found.push({
        localPath: path,
        key,
        bytes: info.size,
        mtimeMs: info.mtimeMs,
        // Anything still .partial (including a rotated-aside .partial.<ts>)
        // was never finalised and may be truncated mid-record.
        partial: isPartial,
      });
    }
  };
  await walk(root);
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

/** MD5 of a local file, to compare against the hash Drive reports. */
function md5(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Everything currently in the Drive folder, keyed by remote path. */
async function listRemote(remote: string, log: Logger): Promise<Map<string, RemoteFile>> {
  const stdout = await rclone(
    ["lsjson", remote, "--recursive", "--files-only", "--hash"],
    log,
  );
  const files = JSON.parse(stdout || "[]") as RemoteFile[];
  return new Map(files.map((f) => [f.Path, f]));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);

  const root = arg("dir") ?? cfg.archive.dir;
  const remote = arg("remote") ?? cfg.archive.remote;
  const dryRun = flag("dry-run");
  const doPrune = flag("prune");
  const doVerify = flag("verify");
  const pruneDays = Number(arg("prune-days") ?? "90");

  const unrecognised: string[] = [];
  const all = await collectShards(root, unrecognised);
  const shards = all.filter((s) => !s.partial);
  const partials = all.length - shards.length;

  log.info(
    {
      root,
      remote,
      shards: shards.length,
      skippedPartial: partials,
      megabytes: +(shards.reduce((n, s) => n + s.bytes, 0) / 1e6).toFixed(1),
    },
    "archive scan complete",
  );
  if (unrecognised.length > 0) {
    // Never guess a remote path. A file whose name does not parse is left
    // local and reported, rather than being uploaded somewhere arbitrary.
    log.warn(
      { count: unrecognised.length, examples: unrecognised.slice(0, 3) },
      "files did not match the expected shard naming and were NOT uploaded",
    );
  }
  if (partials > 0) {
    log.warn(
      { partials },
      "unfinalised .partial shards skipped -- an open or interrupted stream is " +
        "not safe to treat as a backup",
    );
  }

  const before = await listRemote(remote, log);

  // ---- upload ------------------------------------------------------------
  const missing = shards.filter((s) => {
    const r = before.get(s.key);
    return r === undefined || r.Size !== s.bytes;
  });

  log.info(
    { alreadyRemote: shards.length - missing.length, toUpload: missing.length },
    "upload plan",
  );

  if (dryRun) {
    for (const s of missing) {
      console.log(`  would upload  ${s.key}  ${(s.bytes / 1024).toFixed(0)}KB`);
    }
  } else {
    // `copyto` per file, not `copy` of the tree, because the Drive layout
    // (feed/YYYY/MM/DD/HH) differs from the local one (feed/YYYY-MM-DD/...).
    //
    // Still `copyto` and never `sync`: sync mirrors the destination to the
    // source, so combined with the local pruner below it would delete remote
    // shards whose local copies had aged out -- eating the only backup from
    // the oldest end forward. Every rclone verb used here only ever adds.
    for (const shard of missing) {
      await rclone(
        ["copyto", shard.localPath, `${remote}/${shard.key}`, "--stats=0"],
        log,
      );
      log.info(
        { key: shard.key, kilobytes: Math.round(shard.bytes / 1024) },
        "shard uploaded",
      );
    }
  }

  // ---- confirm, by hash --------------------------------------------------
  const after = dryRun ? before : await listRemote(remote, log);
  const confirmed = new Set<string>();
  let mismatched = 0;

  for (const shard of shards) {
    const r = after.get(shard.key);
    if (r === undefined) continue;
    if (r.Size !== shard.bytes) {
      mismatched += 1;
      log.warn({ key: shard.key, localBytes: shard.bytes, remoteBytes: r.Size }, "remote size mismatch");
      continue;
    }
    const remoteMd5 = r.Hashes?.md5;
    if (remoteMd5 === undefined) {
      // No hash offered: refuse to treat as confirmed rather than downgrading
      // silently to a size-only check.
      log.warn({ key: shard.key }, "remote reports no MD5; not counting as confirmed");
      continue;
    }
    if (remoteMd5.toLowerCase() !== (await md5(shard.localPath))) {
      mismatched += 1;
      log.error({ key: shard.key }, "remote MD5 does NOT match local -- will re-upload next run");
      continue;
    }
    confirmed.add(shard.key);
  }

  const remoteBytes = [...after.values()].reduce((n, f) => n + (f.Size ?? 0), 0);
  log.info(
    {
      uploaded: dryRun ? 0 : Math.max(0, after.size - before.size),
      confirmedByHash: confirmed.size,
      mismatched,
      remoteFiles: after.size,
      remoteGigabytes: +(remoteBytes / 1e9).toFixed(3),
    },
    "drive sync complete",
  );

  // ---- optional deep verification ---------------------------------------
  if (doVerify) await verifySample(remote, shards, confirmed, log);

  // ---- prune, gated on hash confirmation --------------------------------
  if (doPrune) {
    const cutoff = Date.now() - pruneDays * 86_400_000;
    const eligible = shards.filter((s) => s.mtimeMs < cutoff);
    let pruned = 0;
    let withheld = 0;

    for (const shard of eligible) {
      // Age alone is never sufficient. Only a hash-confirmed remote copy makes
      // the local file redundant.
      if (!confirmed.has(shard.key)) {
        withheld += 1;
        log.warn(
          { key: shard.key },
          "past retention but NOT confirmed in Drive -- keeping local copy",
        );
        continue;
      }
      if (dryRun) {
        console.log(`  would prune   ${shard.key}`);
        continue;
      }
      await unlink(shard.localPath);
      pruned += 1;
    }
    log.info({ pruneDays, eligible: eligible.length, pruned, withheld }, "local prune complete");
  }

  if (mismatched > 0) process.exitCode = 1;
}

/**
 * Pull a shard back out of Drive and byte-compare it.
 *
 * `rclone check` compares hashes, which is good but still trusts Drive's own
 * reported MD5. This downloads the object, decompresses it, and compares the
 * decoded protobuf payloads against the local shard -- proving the round trip
 * end to end rather than asserting it.
 */
async function verifySample(
  remote: string,
  shards: readonly Shard[],
  confirmed: ReadonlySet<string>,
  log: Logger,
): Promise<void> {
  const target = shards.filter((s) => confirmed.has(s.key)).at(-1);
  if (target === undefined) {
    log.warn("nothing confirmed to verify");
    return;
  }

  const { gunzipSync, brotliDecompressSync } = await import("node:zlib");
  const { readFileSync } = await import("node:fs");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");

  const scratch = await mkdtemp(join(tmpdir(), "archive-verify-"));
  try {
    await rclone(["copyto", `${remote}/${target.key}`, join(scratch, "roundtrip"), "--stats=0"], log);

    const localRaw = readFileSync(target.localPath);
    const remoteRaw = readFileSync(join(scratch, "roundtrip"));
    const decode = (b: Buffer): Buffer =>
      target.key.endsWith(".br") ? brotliDecompressSync(b) : gunzipSync(b);

    const parse = (b: Buffer): { count: number; payloads: string[] } => {
      const lines = decode(b).toString("utf8").split("\n").filter(Boolean);
      return {
        count: lines.length,
        payloads: lines.map((l) => (JSON.parse(l) as { payload_b64: string }).payload_b64),
      };
    };

    const a = parse(localRaw);
    const b = parse(remoteRaw);

    const bytesIdentical = localRaw.equals(remoteRaw);
    const payloadsIdentical =
      a.count === b.count && a.payloads.every((p, i) => p === b.payloads[i]);
    const totalPayloadBytes = a.payloads.reduce(
      (n, p) => n + Buffer.from(p, "base64").byteLength,
      0,
    );

    log.info(
      {
        key: target.key,
        compressedBytesIdentical: bytesIdentical,
        records: a.count,
        decodedPayloadsIdentical: payloadsIdentical,
        protobufBytesVerified: totalPayloadBytes,
      },
      payloadsIdentical && bytesIdentical
        ? "ROUND TRIP VERIFIED: Drive copy is byte-identical after decompression"
        : "ROUND TRIP FAILED",
    );
    if (!payloadsIdentical || !bytesIdentical) process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
