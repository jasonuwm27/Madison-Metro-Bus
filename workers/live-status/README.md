# bus-live-status

Cloudflare Worker backing the "is this thing alive" pulse on the landing page.
See the comment block in `worker.js` for why this exists despite the rest of
the site being a static export, and how the free-tier read/write budgets are
kept within limit.

## One-time setup

Requires a Cloudflare API token with `Workers Scripts:Edit` and
`Workers KV Storage:Edit` -- broader than the existing Pages-deploy token, so
this is a separate credential.

```
cd workers/live-status
wrangler login                       # or set CLOUDFLARE_API_TOKEN in the shell

wrangler kv namespace create LIVE_STATUS
# paste the returned id into wrangler.toml's kv_namespaces[0].id

wrangler secret put PUSH_TOKEN
# paste a long random value -- this is the bearer token the VM will send.
# Generate one with: openssl rand -hex 32

wrangler deploy
```

Note the deployed URL (`https://bus-live-status.<subdomain>.workers.dev`).

## Wiring the VM

Add to `/etc/bus-cloudflare.env` (or a new root:bushc 0640 file, matching the
existing secret-handling convention):

```
LIVE_STATUS_URL=https://bus-live-status.<subdomain>.workers.dev
LIVE_STATUS_TOKEN=<the same value passed to `wrangler secret put PUSH_TOKEN`>
```

`src/config.ts` reads these as `LIVE_STATUS_URL` / `LIVE_STATUS_TOKEN`. Both
default to empty string, which disables the push entirely -- same pattern as
`HEALTHCHECK_URL`, so a worker with no live-status configured behaves exactly
as it did before this feature existed.

## Budget, for reference

- Writes: VM pushes at most once per 2 minutes -> 720/day against a 1,000/day
  quota.
- Reads: client polls every 30s; `Cache-Control: max-age=25` on the GET
  response means Cloudflare's edge cache absorbs repeat requests within the
  same ~25s window regardless of viewer count. Worst case ~3,456 KV reads/day
  (86,400s / 25s), against 100,000/day.
