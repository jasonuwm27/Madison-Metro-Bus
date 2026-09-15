/**
 * Feed fetching with bounded retries.
 *
 * Design constraint: the worker must survive Metro's endpoints going down
 * overnight without anyone noticing. So a fetch failure is never fatal --
 * retries back off, the error is logged, and the next poll tick tries again
 * from scratch. The process stays up and resumes collecting the moment the
 * feed returns.
 */

export interface FetchResult {
  payload: Uint8Array;
  httpStatus: number;
  attempts: number;
  durationMs: number;
  etag: string | null;
  lastModified: string | null;
}

export interface FetchOptions {
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retries do not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void;
}

export class FeedFetchError extends Error {
  override readonly name = "FeedFetchError";
  constructor(
    message: string,
    readonly attempts: number,
    readonly httpStatus: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters even for a single worker: without it, a feed that fails at a
 * fixed interval gets retried at a fixed interval forever, and the worker's
 * requests stay locked in phase with whatever is failing upstream. Sampling
 * uniformly from [0, cap] spreads them out.
 */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * exponential);
}

/** HTTP statuses worth retrying. 4xx other than 408/429 will not fix itself. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchFeed(
  url: string,
  options: FetchOptions,
): Promise<FetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const doSleep = options.sleepImpl ?? sleep;
  const startedAt = Date.now();

  let lastError = "unknown";
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delayMs = backoffDelayMs(
        attempt - 1,
        options.backoffBaseMs,
        options.backoffMaxMs,
      );
      options.onRetry?.({ attempt, delayMs, error: lastError });
      await doSleep(delayMs);
    }

    // A timeout controller per attempt. Without this a hung socket would stall
    // the poll loop indefinitely, which looks identical to a dead worker.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await doFetch(url, {
        signal: controller.signal,
        headers: {
          // Identify ourselves. Metro publishes these feeds openly; being
          // identifiable is the polite minimum for polling every 30 seconds.
          "user-agent":
            "madison-bus-reliability/0.1 (+https://github.com/; archival research)",
          accept: "application/x-google-protobuf, application/octet-stream, */*",
        },
      });
      lastStatus = response.status;

      if (!response.ok) {
        lastError = `HTTP ${response.status} ${response.statusText}`;
        if (!isRetryableStatus(response.status)) {
          throw new FeedFetchError(lastError, attempt + 1, response.status);
        }
        continue;
      }

      const payload = new Uint8Array(await response.arrayBuffer());
      if (payload.byteLength === 0) {
        lastError = "empty response body";
        continue;
      }

      return {
        payload,
        httpStatus: response.status,
        attempts: attempt + 1,
        durationMs: Date.now() - startedAt,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    } catch (cause) {
      if (cause instanceof FeedFetchError) throw cause;
      lastError =
        cause instanceof Error
          ? cause.name === "AbortError"
            ? `timed out after ${options.timeoutMs}ms`
            : cause.message
          : String(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new FeedFetchError(
    `giving up after ${options.maxRetries + 1} attempts: ${lastError}`,
    options.maxRetries + 1,
    lastStatus,
  );
}
