import { mkdtempSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { HourlyNdjsonArchive } from "../src/archive/archive.js";
import type { ShardUploader } from "../src/archive/archive.js";

/**
 * The archive is the record of record -- if a shard is unreadable, the data is
 * gone regardless of what Postgres holds. These tests check the properties that
 * make a shard trustworthy: it round-trips the exact bytes, it is only
 * finalised once complete, and a failed upload never destroys the local copy.
 */

const silent = pino({ level: "silent" });
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "archive-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  dirs.length = 0;
});

async function findShards(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

function readShard(path: string): Record<string, unknown>[] {
  const raw = readFileSync(path);
  const decoded = path.endsWith(".br")
    ? brotliDecompressSync(raw)
    : gunzipSync(raw);
  return decoded
    .toString("utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const at = (iso: string): number => new Date(iso).getTime();

describe("HourlyNdjsonArchive", () => {
  it("round-trips the exact payload bytes", async () => {
    const dir = tempDir();
    const archive = new HourlyNdjsonArchive({ dir, logger: silent });
    // Include high bytes and a zero, which would not survive a text encoding.
    const payload = new Uint8Array([0x00, 0x1f, 0x8b, 0xff, 0x41, 0x00, 0xfe]);

    await archive.write({
      feed: "trips",
      fetchedAtMs: at("2026-09-15T11:06:06Z"),
      httpStatus: 200,
      feedTimestampMs: at("2026-09-15T11:06:28Z"),
      attempts: 1,
      payload,
    });
    await archive.close();

    const shards = await findShards(dir);
    expect(shards).toHaveLength(1);

    const records = readShard(shards[0] ?? "");
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.["feed"]).toBe("trips");
    expect(record?.["http_status"]).toBe(200);
    expect(record?.["payload_bytes"]).toBe(7);
    expect(Buffer.from(String(record?.["payload_b64"]), "base64")).toEqual(
      Buffer.from(payload),
    );
  });

  it("batches an hour of polls into one shard", async () => {
    const dir = tempDir();
    const archive = new HourlyNdjsonArchive({ dir, logger: silent });

    // 30-second polling across the same UTC hour.
    for (let i = 0; i < 20; i += 1) {
      await archive.write({
        feed: "trips",
        fetchedAtMs: at("2026-09-15T11:00:00Z") + i * 30_000,
        httpStatus: 200,
        feedTimestampMs: null,
        attempts: 1,
        payload: new Uint8Array([i]),
      });
    }
    await archive.close();

    const shards = await findShards(dir);
    expect(shards).toHaveLength(1);
    expect(readShard(shards[0] ?? "")).toHaveLength(20);
  });

  it("rotates on the hour boundary", async () => {
    const dir = tempDir();
    const archive = new HourlyNdjsonArchive({ dir, logger: silent });

    await archive.write({
      feed: "trips",
      fetchedAtMs: at("2026-09-15T11:59:45Z"),
      httpStatus: 200,
      feedTimestampMs: null,
      attempts: 1,
      payload: new Uint8Array([1]),
    });
    await archive.write({
      feed: "trips",
      fetchedAtMs: at("2026-09-15T12:00:15Z"),
      httpStatus: 200,
      feedTimestampMs: null,
      attempts: 1,
      payload: new Uint8Array([2]),
    });
    await archive.close();

    const shards = await findShards(dir);
    expect(shards).toHaveLength(2);
    expect(shards.every((s) => s.endsWith(".ndjson.gz"))).toBe(true);
    // Crossing an hour finalises the previous shard; nothing left partial.
    expect(shards.some((s) => s.includes(".partial"))).toBe(false);
  });

  it("keeps each feed in its own shard", async () => {
    const dir = tempDir();
    const archive = new HourlyNdjsonArchive({ dir, logger: silent });

    for (const feed of ["trips", "vehicles", "alerts"]) {
      await archive.write({
        feed,
        fetchedAtMs: at("2026-09-15T11:06:06Z"),
        httpStatus: 200,
        feedTimestampMs: null,
        attempts: 1,
        payload: new Uint8Array([1]),
      });
    }
    await archive.close();

    const shards = await findShards(dir);
    expect(shards).toHaveLength(3);
    for (const feed of ["trips", "vehicles", "alerts"]) {
      expect(shards.some((s) => s.includes(feed))).toBe(true);
    }
  });

  it("uploads a finished shard and keeps it locally by default", async () => {
    const dir = tempDir();
    const uploaded: string[] = [];
    const uploader: ShardUploader = {
      upload: async (_local, key) => {
        uploaded.push(key);
      },
    };
    const archive = new HourlyNdjsonArchive({ dir, logger: silent, uploader });

    await archive.write({
      feed: "trips",
      fetchedAtMs: at("2026-09-15T11:06:06Z"),
      httpStatus: 200,
      feedTimestampMs: null,
      attempts: 1,
      payload: new Uint8Array([1]),
    });
    await archive.close();

    expect(uploaded).toEqual(["trips/2026-09-15/2026-09-15T11.ndjson.gz"]);
    expect(await findShards(dir)).toHaveLength(1);
  });

  it("round-trips through brotli and labels the shard .br", async () => {
    // Same NDJSON, ~21% smaller. The extension is what lets a replayer pick
    // the right decompressor without sniffing magic bytes.
    const dir = tempDir();
    const archive = new HourlyNdjsonArchive({
      dir,
      logger: silent,
      compression: "brotli",
    });
    const payload = new Uint8Array([0x00, 0xff, 0x10, 0x8b]);

    await archive.write({
      feed: "trips",
      fetchedAtMs: at("2026-09-15T11:06:06Z"),
      httpStatus: 200,
      feedTimestampMs: null,
      attempts: 1,
      payload,
    });
    await archive.close();

    const shards = await findShards(dir);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toMatch(/\.ndjson\.br$/);
    const records = readShard(shards[0] ?? "");
    expect(Buffer.from(String(records[0]?.["payload_b64"]), "base64")).toEqual(
      Buffer.from(payload),
    );
  });

  it("retains the local shard when the upload fails", async () => {
    // The critical property: a failed upload must degrade to "still on disk",
    // never to "gone". It must also not take the worker down.
    const dir = tempDir();
    const uploader: ShardUploader = {
      upload: async () => {
        throw new Error("R2 unreachable");
      },
    };
    const archive = new HourlyNdjsonArchive({
      dir,
      logger: silent,
      uploader,
      deleteLocalAfterUpload: true,
    });

    await archive.write({
      feed: "trips",
      fetchedAtMs: at("2026-09-15T11:06:06Z"),
      httpStatus: 200,
      feedTimestampMs: null,
      attempts: 1,
      payload: new Uint8Array([42]),
    });
    await expect(archive.close()).resolves.toBeUndefined();

    const shards = await findShards(dir);
    expect(shards).toHaveLength(1);
    expect(readShard(shards[0] ?? "")).toHaveLength(1);
  });
});
