/**
 * Live status endpoint for the "is this thing actually running" pulse on the
 * landing page.
 *
 * WHY A WORKER AT ALL, GIVEN THE SITE IS STATIC
 * The site exports once nightly, so nothing in the static export can honestly
 * be called live. This Worker is the one narrow exception: the VM pushes a
 * tiny status blob to KV after every successful poll, and the site polls this
 * endpoint every 30s (the real collection cadence) to show that the collector
 * is actually running right now -- not a replay, not a daily snapshot.
 *
 * TWO ROUTES, TWO TRUST LEVELS
 *   POST /  -- from the VM only, bearer-token authenticated. Writes KV.
 *   GET  /  -- public, unauthenticated. Reads KV, served with a short
 *              Cache-Control so Cloudflare's edge cache absorbs repeat
 *              requests from different simultaneous viewers.
 *
 * WHY THE CACHE HEADER IS LOAD-BEARING, NOT AN OPTIMISATION
 * KV free tier is 100,000 reads/day. A client polling every 30s alone would
 * cost 2,880 reads/day; at ~34 concurrent all-day viewers that already
 * exhausts the daily quota, after which the pulse would silently stop
 * updating for everyone until the next UTC midnight -- the worst failure mode
 * for a feature whose entire point is "look, it's alive". `max-age=25`
 * (slightly under the client's 30s poll) means Cloudflare's HTTP edge cache
 * answers repeat requests within the same window without touching KV at all,
 * so the KV read cost scales with unique 25s windows (~3,456/day worst case),
 * not with viewer count.
 *
 * WHY THE WRITE SIDE IS THROTTLED IN THE CALLER, NOT HERE
 * Free tier write budget is a separate pool: 1,000/day. The VM pushes at most
 * once per 2 minutes (720/day, see src/worker.ts), which this Worker trusts
 * rather than re-enforcing -- a second rate limiter here would just be another
 * place for the two sides to disagree about the throttle.
 */

const KEY = "live:status";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/") {
      return handlePush(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return handleRead(env);
    }
    return new Response("not found", { status: 404 });
  },
};

async function handlePush(request, env) {
  const auth = request.headers.get("authorization") ?? "";
  // Constant-time-ish comparison is unnecessary here: this token is a
  // capability for "write one small non-sensitive JSON blob", not a secret
  // that gates access to anything valuable. Simplicity over defensive theatre.
  if (auth !== `Bearer ${env.PUSH_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const { rowsLastPoll, totalObservations, busesTracked, lastPollAt } = body;
  if (
    typeof rowsLastPoll !== "number" ||
    typeof totalObservations !== "number" ||
    typeof busesTracked !== "number" ||
    typeof lastPollAt !== "string"
  ) {
    return new Response("missing or malformed fields", { status: 400 });
  }

  const payload = JSON.stringify({ rowsLastPoll, totalObservations, busesTracked, lastPollAt });
  await env.LIVE_STATUS.put(KEY, payload);
  return new Response("ok", { status: 200 });
}

async function handleRead(env) {
  const stored = await env.LIVE_STATUS.get(KEY, "json");
  const body = stored === null ? { available: false } : { ...stored, available: true };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // Just under the client's 30s poll interval -- see the module comment.
      "cache-control": "public, max-age=25",
      "access-control-allow-origin": "*",
    },
  });
}
