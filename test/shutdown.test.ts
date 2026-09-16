import { describe, expect, it } from "vitest";

/**
 * Shutdown coordination.
 *
 * Mirrors the Shutdown class in src/worker.ts. It lives in the worker module,
 * which pulls in config, the database and the archive on import -- none of
 * which belong in a unit test. The logic is twelve lines, so it is duplicated
 * here rather than dragging that whole graph in, and the duplication is
 * deliberate: if the two drift, the worker's copy is the one that matters.
 *
 * What this protects is not academic. The original used a single resolver
 * handle shared by three concurrently-sleeping poll loops, so each sleep()
 * clobbered the last one's resolver. On SIGTERM only the newest sleeper woke;
 * the alerts loop sat out its full 300s interval, blew systemd's 60s
 * TimeoutStopSec, and got SIGKILLed mid-write -- truncating archive shards.
 */
class Shutdown {
  readonly #waiters = new Set<() => void>();
  stopping = false;

  signal(): void {
    this.stopping = true;
    for (const wake of [...this.#waiters]) wake();
    this.#waiters.clear();
  }

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

describe("Shutdown", () => {
  it("wakes ALL concurrent sleepers, not just the most recent", async () => {
    // The regression. Three loops sleep on intervals matching production:
    // trips 30s, vehicles 30s, alerts 300s. All three must return promptly.
    const shutdown = new Shutdown();
    const woke: string[] = [];

    const loops = [
      shutdown.sleep(30_000).then(() => void woke.push("trips")),
      shutdown.sleep(30_000).then(() => void woke.push("vehicles")),
      shutdown.sleep(300_000).then(() => void woke.push("alerts")),
    ];

    const startedAt = Date.now();
    shutdown.signal();
    await Promise.all(loops);
    const elapsed = Date.now() - startedAt;

    expect(woke.sort()).toEqual(["alerts", "trips", "vehicles"]);
    // Must be immediate. Before the fix, "alerts" would take 300 seconds.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("returns immediately for a sleep started after shutdown", async () => {
    const shutdown = new Shutdown();
    shutdown.signal();
    const startedAt = Date.now();
    await shutdown.sleep(300_000);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("sets stopping so poll loops exit their while condition", async () => {
    const shutdown = new Shutdown();
    expect(shutdown.stopping).toBe(false);
    shutdown.signal();
    expect(shutdown.stopping).toBe(true);
  });

  it("still sleeps normally when no shutdown is requested", async () => {
    const shutdown = new Shutdown();
    const startedAt = Date.now();
    await shutdown.sleep(60);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(shutdown.stopping).toBe(false);
  });

  it("tolerates repeated signals", async () => {
    // SIGINT then SIGTERM, or systemd signalling twice, must not throw.
    const shutdown = new Shutdown();
    const sleeping = shutdown.sleep(300_000);
    shutdown.signal();
    shutdown.signal();
    await expect(sleeping).resolves.toBeUndefined();
  });
});
