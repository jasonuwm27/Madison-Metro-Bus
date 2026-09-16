import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

/**
 * Upload local archive shards to R2.
 *
 *   pnpm upload-archive                    # upload everything not already there
 *   pnpm upload-archive --dir=C:\bus-archive
 *   pnpm upload-archive --dry-run          # list what would be sent
 *   pnpm upload-archive --include-partial  # also send unfinalised .partial shards
 *
 * WHY THIS EXISTS
 * Collection started on the laptop on 2026-09-15 and moved to the VM on
 * 2026-09-16. Those laptop shards are the only copy of that window, and the
 * feeds cannot be re-fetched for a past moment. This makes the two eras one
 * continuous history in a single bucket.
 *
 * IDEMPOTENT. Keys are derived from the shard's own path (feed/date/hour), so
 * re-running skips anything already present with a matching size. Run it as
 * often as you like; the laptop and the VM can both target the same bucket
 * without stepping on each other, because their hours never overlap for a
 * given feed.
 *
 * SAFETY. This never deletes a local file. Verification is by remote size
 * against local size -- a truncated upload therefore re-uploads rather than
 * being mistaken for done.
 */

interface Shard {
  localPath: string;
  key: string;
  bytes: number;
  partial: boolean;
}

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string): boolean =>
  process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));

/** Collect shards, deriving the object key from the path layout the archive writes. */
async function collectShards(root: string): Promise<Shard[]> {
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
        // Skip the GTFS extraction scratch dir -- it is regenerable and large.
        if (entry.name === ".gtfs-cache") continue;
        await walk(path);
        continue;
      }
      if (!/\.ndjson\.(gz|br)(\.partial)?$/.test(entry.name)) continue;

      const { size } = await stat(path);
      // Key mirrors the local layout (feed/date/file) so VM-written and
      // laptop-written shards interleave naturally in one bucket. Backslashes
      // are normalised because this runs on Windows.
      const key = relative(root, path).split(sep).join("/");
      found.push({
        localPath: path,
        key,
        bytes: size,
        partial: entry.name.endsWith(".partial"),
      });
    }
  };

  await walk(root);
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg);

  const root = arg("dir") ?? cfg.archive.dir;
  const dryRun = flag("dry-run");
  const includePartial = flag("include-partial");

  const all = await collectShards(root);
  const shards = includePartial ? all : all.filter((s) => !s.partial);
  const skippedPartial = all.length - shards.length;

  const totalBytes = shards.reduce((n, s) => n + s.bytes, 0);
  log.info(
    {
      root,
      shards: shards.length,
      megabytes: +(totalBytes / 1e6).toFixed(1),
      skippedPartial,
    },
    "archive scan complete",
  );

  if (skippedPartial > 0) {
    // A .partial shard is one the worker had open when it stopped. It is valid
    // compressed data but the stream was never finalised, so it may be
    // truncated mid-record. Excluded by default rather than silently shipping
    // a shard a replayer might choke on.
    log.warn(
      { skippedPartial },
      "unfinalised .partial shards skipped; pass --include-partial to send them",
    );
  }

  if (shards.length === 0) {
    log.info("nothing to upload");
    return;
  }

  if (dryRun) {
    for (const s of shards) {
      console.log(`  ${s.key}  ${(s.bytes / 1024).toFixed(0)}KB`);
    }
    log.info("dry run: nothing uploaded");
    return;
  }

  if (cfg.archive.sink !== "r2") {
    throw new Error(
      "ARCHIVE_SINK must be 'r2' to upload, and R2_* credentials must be set. " +
        "Use --dry-run to preview without credentials.",
    );
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.archive.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.archive.r2.accessKeyId,
      secretAccessKey: cfg.archive.r2.secretAccessKey,
    },
  });
  const bucket = cfg.archive.r2.bucket;

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let bytesSent = 0;

  for (const shard of shards) {
    // Skip if an object of the same size is already there. Size rather than
    // ETag because R2 multipart ETags are not plain MD5, so an ETag compare
    // would produce spurious re-uploads on larger shards.
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: shard.key }),
      );
      if (head.ContentLength === shard.bytes) {
        skipped += 1;
        continue;
      }
      log.warn(
        { key: shard.key, remote: head.ContentLength, local: shard.bytes },
        "size mismatch; re-uploading",
      );
    } catch {
      // Not found -- fall through and upload.
    }

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: shard.key,
          Body: createReadStream(shard.localPath),
          ContentLength: shard.bytes,
          ContentType: "application/x-ndjson",
          ContentEncoding: shard.key.endsWith(".br") ? "br" : "gzip",
          Metadata: {
            "origin-host": process.env["COMPUTERNAME"] ?? process.env["HOSTNAME"] ?? "unknown",
            "sha256-prefix": await sha256Prefix(shard.localPath),
          },
        }),
      );
      uploaded += 1;
      bytesSent += shard.bytes;
      log.info(
        { key: shard.key, kilobytes: Math.round(shard.bytes / 1024) },
        "shard uploaded",
      );
    } catch (error) {
      failed += 1;
      // Keep going: one bad shard must not abandon the rest of the backfill.
      log.error({ err: error, key: shard.key }, "shard upload failed");
    }
  }

  log.info(
    {
      uploaded,
      alreadyPresent: skipped,
      failed,
      megabytesSent: +(bytesSent / 1e6).toFixed(1),
    },
    "archive upload complete",
  );

  if (failed > 0) process.exitCode = 1;
}

/** First 16 hex chars of the file's SHA-256, stored as object metadata. */
async function sha256Prefix(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 16)));
    stream.on("error", reject);
  });
}



main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
