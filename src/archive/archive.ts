import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { constants, createBrotliCompress, createGzip } from "node:zlib";
import type { Transform, Writable } from "node:stream";
import type { Logger } from "../logger.js";

/**
 * The archive is the record of record.
 *
 * Postgres holds a collapsed, opinionated view of the data that is evicted at
 * 45 days. Everything that is actually irreplaceable lives here: the raw bytes
 * Metro published, exactly as published. Any future analysis -- prediction
 * drift, vehicle bunching, headway regularity, a schema decision made
 * differently -- is a replay away. Nothing in the pipeline is allowed to be
 * the only copy of anything.
 *
 * FORMAT: one compressed NDJSON file per (feed, UTC hour). Each line is a JSON
 * record whose `payload_b64` holds the untouched protobuf.
 *
 * Hourly shards rather than per-poll objects: at 30-second polling that is
 * 2,880 objects per feed per day, and object stores charge per PUT and list
 * badly at that count. One shard per hour is 24 PUTs per feed per day.
 *
 * Base64 inside JSON costs storage that framing the binary directly would not.
 * That is the price of a format any language can replay line by line without a
 * custom reader, and it is worth paying for an archive whose whole purpose is
 * to be readable years from now.
 *
 * COMPRESSION, measured on a real 131,904-byte TripUpdates payload:
 *
 *   gzip(base64)    54,307 B   ~4.7 GB/month   <- default
 *   brotli(base64)  43,076 B   ~3.7 GB/month   21% smaller, same NDJSON
 *   gzip(raw pb)    41,191 B                   would abandon NDJSON
 *   brotli(raw pb)  29,838 B                   would abandon NDJSON
 *
 * gzip is the default because it is universal -- every language, every CLI,
 * every object browser reads it without thinking. Brotli is one env var away
 * (ARCHIVE_COMPRESSION=brotli) and buys a fifth of the storage bill while
 * keeping the format identical; Node has decompressed it natively since v11.
 * The file extension records which was used, so a replayer can tell.
 */

export interface ArchiveRecord {
  feed: string;
  fetchedAtMs: number;
  httpStatus: number;
  feedTimestampMs: number | null;
  attempts: number;
  payload: Uint8Array;
}

export interface ArchiveSink {
  write(record: ArchiveRecord): Promise<void>;
  /** Close all open shards. Called on shutdown. */
  close(): Promise<void>;
}

export interface ShardUploader {
  /** Upload a finished shard. Throwing keeps the local file in place. */
  upload(localPath: string, key: string): Promise<void>;
}

export type ArchiveCompression = "gzip" | "brotli";

interface OpenShard {
  hourKey: string;
  path: string;
  finalPath: string;
  key: string;
  compressor: Transform;
  file: Writable;
  lines: number;
}

function createCompressor(kind: ArchiveCompression): Transform {
  if (kind === "brotli") {
    return createBrotliCompress({
      params: {
        // Quality 5 is the knee of the curve: near-maximum ratio at a fraction
        // of the CPU of 11, which matters on a shared-core VPS compressing a
        // 130 KB payload every 30 seconds.
        [constants.BROTLI_PARAM_QUALITY]: 5,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      },
    });
  }
  return createGzip();
}

/** UTC hour bucket, e.g. 2026-09-15T11. UTC so shards never shift with DST. */
function hourKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export class HourlyNdjsonArchive implements ArchiveSink {
  readonly #dir: string;
  readonly #log: Logger;
  readonly #uploader: ShardUploader | undefined;
  readonly #deleteLocalAfterUpload: boolean;
  readonly #compression: ArchiveCompression;
  readonly #shards = new Map<string, OpenShard>();

  constructor(options: {
    dir: string;
    logger: Logger;
    uploader?: ShardUploader | undefined;
    deleteLocalAfterUpload?: boolean;
    compression?: ArchiveCompression;
  }) {
    this.#dir = options.dir;
    this.#log = options.logger;
    this.#uploader = options.uploader;
    this.#deleteLocalAfterUpload = options.deleteLocalAfterUpload ?? false;
    this.#compression = options.compression ?? "gzip";
    mkdirSync(this.#dir, { recursive: true });
  }

  async write(record: ArchiveRecord): Promise<void> {
    const hourKey = hourKeyOf(record.fetchedAtMs);
    const shard = await this.#shardFor(record.feed, hourKey);

    const line = `${JSON.stringify({
      feed: record.feed,
      fetched_at: new Date(record.fetchedAtMs).toISOString(),
      http_status: record.httpStatus,
      feed_timestamp:
        record.feedTimestampMs === null
          ? null
          : new Date(record.feedTimestampMs).toISOString(),
      attempts: record.attempts,
      payload_bytes: record.payload.byteLength,
      payload_b64: Buffer.from(record.payload).toString("base64"),
    })}\n`;

    await new Promise<void>((resolve, reject) => {
      shard.compressor.write(line, (error) =>
        error === null || error === undefined ? resolve() : reject(error),
      );
    });
    shard.lines += 1;
  }

  async #shardFor(feed: string, hourKey: string): Promise<OpenShard> {
    const existing = this.#shards.get(feed);
    if (existing !== undefined && existing.hourKey === hourKey) return existing;

    // The hour rolled over (or this is the first write for the feed).
    if (existing !== undefined) {
      this.#shards.delete(feed);
      await this.#closeShard(existing);
    }

    // Shards land under feed/date/ so a day's worth can be fetched with one
    // prefix listing during a replay.
    const [date] = hourKey.split("T");
    const relativeDir = join(feed, date ?? "unknown");
    const dir = join(this.#dir, relativeDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const extension = this.#compression === "brotli" ? "br" : "gz";
    const filename = `${hourKey.replace(/:/g, "")}.ndjson.${extension}`;
    // Written as .partial so an interrupted process never leaves a truncated
    // shard that looks complete to the uploader or to a replay.
    const basePath = join(dir, `${filename}.partial`);
    const finalPath = join(dir, filename);

    // "wx" -- create exclusively, never append.
    //
    // This was "a", which corrupted every shard written on 2026-09-15: a worker
    // restarting inside the same hour reopened the same .partial file and piped
    // a SECOND gzip stream onto the end of an unfinalised first one. Concatenated
    // gzip members are legal, but a truncated member followed by another is not,
    // and the whole shard became undecompressable. Restarts are routine -- a
    // crash, a deploy, a reboot -- so this was guaranteed to happen.
    //
    // With "wx" a collision is surfaced instead of silently corrupting: the
    // existing shard is rotated aside with a suffix and a fresh stream starts,
    // so each file holds exactly one complete gzip member.
    let path = basePath;
    if (existsSync(path)) {
      const salvaged = `${basePath}.${Date.now()}`;
      renameSync(path, salvaged);
      this.#log.warn(
        { shard: filename, salvaged },
        "an unfinalised shard already existed for this hour (previous run ended " +
          "abruptly); moved aside rather than appending, which would corrupt both",
      );
    }
    const file = createWriteStream(path, { flags: "wx" });
    const compressor = createCompressor(this.#compression);
    compressor.pipe(file);

    const shard: OpenShard = {
      hourKey,
      path,
      finalPath,
      key: `${relativeDir.replace(/\\/g, "/")}/${filename}`,
      compressor,
      file,
      lines: 0,
    };
    this.#shards.set(feed, shard);
    this.#log.info({ feed, shard: shard.key }, "archive shard opened");
    return shard;
  }

  async #closeShard(shard: OpenShard): Promise<void> {
    // Wait for the FILE to close, not for the compressor to end. The
    // compressor's end callback fires once compression finishes, which is
    // before the piped bytes have reached disk -- finalising there produced
    // shards that were silently truncated and failed to decompress. Because
    // the compressor is piped to the file, ending it ends the file, so the
    // file's "close" is the real completion signal.
    try {
      await new Promise<void>((resolve, reject) => {
        shard.file.once("close", resolve);
        shard.file.once("error", reject);
        shard.compressor.once("error", reject);
        shard.compressor.end();
      });
    } catch (error) {
      this.#log.error(
        { err: error, shard: shard.key },
        "archive shard failed to flush; leaving .partial in place for recovery",
      );
      return;
    }

    try {
      await rename(shard.path, shard.finalPath);
    } catch (error) {
      this.#log.error(
        { err: error, shard: shard.key },
        "could not finalise archive shard",
      );
      return;
    }

    const { size } = await stat(shard.finalPath);
    this.#log.info(
      { shard: shard.key, lines: shard.lines, bytes: size },
      "archive shard closed",
    );

    if (this.#uploader === undefined) return;
    try {
      await this.#uploader.upload(shard.finalPath, shard.key);
      this.#log.info({ shard: shard.key, bytes: size }, "archive shard uploaded");
      if (this.#deleteLocalAfterUpload) await unlink(shard.finalPath);
    } catch (error) {
      // Deliberately non-fatal and deliberately does NOT delete the local file.
      // A failed upload must degrade to "still on disk", never to "gone".
      this.#log.error(
        { err: error, shard: shard.key },
        "archive upload failed; shard retained locally",
      );
    }
  }

  async close(): Promise<void> {
    const open = [...this.#shards.values()];
    this.#shards.clear();
    for (const shard of open) await this.#closeShard(shard);
  }
}
