import { describe, expect, it } from "vitest";
import { toDriveKey } from "../scripts/upload-archive.js";

/**
 * Local-to-Drive path translation.
 *
 * This decides where every shard lands permanently. A wrong mapping would
 * scatter the archive across paths that a future replay cannot find, and
 * because the pruner deletes local copies once the remote is confirmed, a
 * misfiled shard could end up being the only copy — at an address nobody
 * knows to look at. Hence tests rather than trust.
 */
describe("toDriveKey", () => {
  it("maps the archive's real layout to nested Y/M/D", () => {
    expect(toDriveKey("trips/2026-09-16/2026-09-16T17.ndjson.gz")).toBe(
      "trips/2026/09/16/17.ndjson.gz",
    );
    expect(toDriveKey("vehicles/2026-09-16/2026-09-16T17.ndjson.gz")).toBe(
      "vehicles/2026/09/16/17.ndjson.gz",
    );
    expect(toDriveKey("alerts/2026-01-01/2026-01-01T00.ndjson.gz")).toBe(
      "alerts/2026/01/01/00.ndjson.gz",
    );
  });

  it("preserves brotli shards' extension", () => {
    expect(toDriveKey("trips/2026-09-16/2026-09-16T17.ndjson.br")).toBe(
      "trips/2026/09/16/17.ndjson.br",
    );
  });

  it("keeps zero-padding so lexical order equals chronological order", () => {
    // A replay that lists a prefix relies on this: "09" must sort before "10".
    const keys = [
      toDriveKey("trips/2026-03-09/2026-03-09T09.ndjson.gz"),
      toDriveKey("trips/2026-03-09/2026-03-09T10.ndjson.gz"),
      toDriveKey("trips/2026-11-02/2026-11-02T00.ndjson.gz"),
    ];
    expect(keys).toEqual([
      "trips/2026/03/09/09.ndjson.gz",
      "trips/2026/03/09/10.ndjson.gz",
      "trips/2026/11/02/00.ndjson.gz",
    ]);
    expect([...keys].sort()).toEqual(keys);
  });

  it("refuses anything it does not recognise rather than guessing", () => {
    // Returning null makes the caller skip and report. Guessing a path would
    // silently file data somewhere a replay will never look.
    expect(toDriveKey("trips/2026-09-16/2026-09-16T17.ndjson.gz.partial")).toBeNull();
    expect(toDriveKey("trips/2026-09-16/notashard.txt")).toBeNull();
    expect(toDriveKey("2026-09-16T17.ndjson.gz")).toBeNull();
    expect(toDriveKey("a/b/c/d/2026-09-16T17.ndjson.gz")).toBeNull();
    expect(toDriveKey("")).toBeNull();
  });

  it("never produces a path that escapes the archive folder", () => {
    // The remote is pinned at gdrive:BusProject/archive, so a key containing
    // ".." would write outside it. The regex cannot emit one, but assert it.
    for (const input of [
      "trips/2026-09-16/2026-09-16T17.ndjson.gz",
      "../../etc/2026-09-16/2026-09-16T17.ndjson.gz",
      "trips/../../2026-09-16/2026-09-16T17.ndjson.gz",
    ]) {
      const key = toDriveKey(input);
      if (key !== null) expect(key).not.toContain("..");
    }
  });
});
