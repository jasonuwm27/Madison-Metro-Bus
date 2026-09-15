import { describe, expect, it, vi } from "vitest";
import { backoffDelayMs, FeedFetchError, fetchFeed } from "../src/gtfsrt/fetch.js";

/**
 * No network. A stub fetch and a stub sleep make the retry policy directly
 * observable, which is the only part of this module worth testing -- whether
 * `fetch` works is Node's problem, whether the worker survives a flaky feed
 * is ours.
 */

const OPTIONS = {
  timeoutMs: 1_000,
  maxRetries: 3,
  backoffBaseMs: 100,
  backoffMaxMs: 5_000,
};

const ok = (body: Uint8Array): Response =>
  new Response(body, { status: 200, headers: { etag: '"abc"' } });

describe("backoffDelayMs", () => {
  it("grows exponentially and respects the cap", () => {
    const full = () => 1; // full jitter at its maximum
    expect(backoffDelayMs(0, 100, 5_000, full)).toBe(100);
    expect(backoffDelayMs(1, 100, 5_000, full)).toBe(200);
    expect(backoffDelayMs(4, 100, 5_000, full)).toBe(1_600);
    expect(backoffDelayMs(20, 100, 5_000, full)).toBe(5_000);
  });

  it("jitters down to zero", () => {
    // Full jitter samples the whole range, so repeated failures do not stay
    // locked in phase with whatever is failing upstream.
    expect(backoffDelayMs(3, 100, 5_000, () => 0)).toBe(0);
    expect(backoffDelayMs(3, 100, 5_000, () => 0.5)).toBe(400);
  });
});

describe("fetchFeed", () => {
  it("returns the payload on a first-try success", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const result = await fetchFeed("https://example.test/feed", {
      ...OPTIONS,
      fetchImpl: vi.fn(async () => ok(payload)),
      sleepImpl: async () => {},
    });
    expect(result.payload).toEqual(payload);
    expect(result.attempts).toBe(1);
    expect(result.etag).toBe('"abc"');
  });

  it("retries a 503 and succeeds", async () => {
    // The overnight case: Metro's endpoint is down, then comes back.
    const payload = new Uint8Array([9]);
    const impl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(ok(payload));

    const sleeps: number[] = [];
    const result = await fetchFeed("https://example.test/feed", {
      ...OPTIONS,
      fetchImpl: impl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.attempts).toBe(3);
    expect(result.payload).toEqual(payload);
    expect(sleeps).toHaveLength(2);
  });

  it("retries a network error", async () => {
    const impl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(ok(new Uint8Array([7])));
    const result = await fetchFeed("https://example.test/feed", {
      ...OPTIONS,
      fetchImpl: impl,
      sleepImpl: async () => {},
    });
    expect(result.attempts).toBe(2);
  });

  it("gives up after maxRetries and throws a typed error", async () => {
    // The worker catches this, logs it, and tries again on the next tick --
    // it must never escape far enough to kill the process.
    const impl = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      fetchFeed("https://example.test/feed", {
        ...OPTIONS,
        fetchImpl: impl,
        sleepImpl: async () => {},
      }),
    ).rejects.toThrow(FeedFetchError);
    expect(impl).toHaveBeenCalledTimes(OPTIONS.maxRetries + 1);
  });

  it("does not retry a 404", async () => {
    // A permanent client error will not fix itself; burning four attempts on
    // it only delays the next real poll.
    const impl = vi.fn(async () => new Response("", { status: 404 }));
    await expect(
      fetchFeed("https://example.test/feed", {
        ...OPTIONS,
        fetchImpl: impl,
        sleepImpl: async () => {},
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429", async () => {
    const impl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(ok(new Uint8Array([1])));
    const result = await fetchFeed("https://example.test/feed", {
      ...OPTIONS,
      fetchImpl: impl,
      sleepImpl: async () => {},
    });
    expect(result.attempts).toBe(2);
  });

  it("treats an empty body as retryable", async () => {
    // A 200 with no bytes decodes to an empty feed, which would otherwise look
    // like Metro having cancelled every trip in the city.
    const impl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(new Uint8Array([])))
      .mockResolvedValueOnce(ok(new Uint8Array([5])));
    const result = await fetchFeed("https://example.test/feed", {
      ...OPTIONS,
      fetchImpl: impl,
      sleepImpl: async () => {},
    });
    expect(result.attempts).toBe(2);
    expect(result.payload.byteLength).toBe(1);
  });

  it("reports a timeout as an abort rather than hanging", async () => {
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const error = new Error("aborted");
      error.name = "AbortError";
      void init;
      throw error;
    }) as unknown as typeof fetch;

    await expect(
      fetchFeed("https://example.test/feed", {
        ...OPTIONS,
        maxRetries: 0,
        fetchImpl: impl,
        sleepImpl: async () => {},
      }),
    ).rejects.toThrow(/timed out after 1000ms/);
  });
});
