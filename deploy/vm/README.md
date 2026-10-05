# VM configuration snapshot (2026-10-05)

Copied verbatim from the Oracle VM (`163.192.9.150`) before it was shut down,
so a replacement can be rebuilt. Paths mirror their location on the VM root.
Nothing here is a secret.

**Not captured, because they are credentials** -- recreate them on the new box:

| File | Where to get it again |
|---|---|
| `/opt/bus/repo/.env` | `.env.example`; `DATABASE_URL` points at the new local Postgres |
| `/etc/bus-healthchecks.env` | ping URLs from the healthchecks.io dashboard |
| `/etc/bus-cloudflare.env` | new Pages:Write token (the old one is IP-locked to the old VM) + `LIVE_STATUS_URL`/`LIVE_STATUS_TOKEN` (`wrangler secret put PUSH_TOKEN` to rotate) |
| `~/.config/rclone/rclone.conf` | `rclone config` with the personal Google client ID, `scope = drive` (see CLAUDE.md) |

Restoring onto a new VM:

1. Attach a volume, `mkfs.xfs`, mount at `/mnt/pgdata`. The UUID in `etc/fstab`
   and `usr/local/bin/check-pgdata-volume.sh` is the **old** volume's -- update both.
2. Install Postgres 17, `conf.d-tuning.conf` into PGDATA, the
   `postgresql-17.service.d` override, then restore the newest
   `busproject-*.dump` from `gdrive:BusProject/backups` with `pg_restore`.
3. Copy `usr/local/bin/*` and `etc/systemd/system/*`, then
   `chcon -t bin_t /usr/local/bin/*.sh` (SELinux -- see CLAUDE.md).
4. Enable `bus-worker-local` and the timers. `bus-worker`, `bus-rollup-local`
   and `bus-drop-local` were already disabled duplicates; leave them off.
5. Un-pause the site: `COLLECTION_PAUSED_ON = null` and restore
   `LIVE_STATUS_URL` in `site/public/app.js`.
