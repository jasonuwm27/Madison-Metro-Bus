# Deployment artifacts

Files here are copied onto the VM; they are not used by the application at
runtime. Kept in the repo so the VM is reproducible after a reclaim.

- `postgresql.tuning.conf` — included from `postgresql.conf` on the VM at
  `/mnt/pgdata/17/data/conf.d-tuning.conf`. Sized for 2 OCPU / 12 GB **shared
  with the collector**, not for a dedicated database host.
- `check-pgdata-volume.sh` — `ExecStartPre` guard for `postgresql-17.service`.

## Why the volume guard exists

`RequiresMountsFor=` is **not** sufficient on its own. systemd will auto-mount
the path to satisfy the dependency, and the packaged Postgres unit runs
`initdb` when `PGDATA` looks empty — so a failed mount would silently create a
new empty cluster on the boot disk and start serving it. The collector would
look healthy while filling the root filesystem.

Verified by unmounting the volume and masking the mount unit: Postgres refused
to start and wrote **zero** entries to the boot disk.

## Device names are not stable

Observed across a single reboot: the block volume moved from `/dev/sdb` to
`/dev/sda` and the boot disk from `sda` to `sdb`. The `/dev/oracleoci/oraclevd*`
symlinks also disappeared after reboot. **Only the filesystem UUID is
trustworthy** — which is why fstab and the guard both key on
`d94a6856-d7f3-499a-8988-ff5e51d6d7e6`.
