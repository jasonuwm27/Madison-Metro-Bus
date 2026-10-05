#!/usr/bin/env bash
# Refuse to let Postgres start unless PGDATA is genuinely on the block volume.
#
# RequiresMountsFor alone is NOT sufficient: systemd will happily AUTO-MOUNT
# the path to satisfy the dependency, and if the device is missing entirely it
# can still let the service through against a bare directory. Postgres packaged
# units also run initdb when PGDATA looks empty -- so a failed mount would
# silently create a brand-new empty cluster on the boot disk and start serving
# it. The collector would appear healthy while writing to the wrong disk and
# filling the root filesystem.
#
# Three independent assertions, any of which failing aborts the start:
set -euo pipefail

MOUNT=/mnt/pgdata
MARKER="$MOUNT/.is-pgdata-volume"
PGDATA="$MOUNT/17/data"
EXPECT_UUID="d94a6856-d7f3-499a-8988-ff5e51d6d7e6"

# 1. Is it a mount point at all (not just a directory)?
if ! mountpoint -q "$MOUNT"; then
  echo "FATAL: $MOUNT is not a mount point -- refusing to start Postgres" >&2
  exit 1
fi

# 2. Is it THE volume, by UUID? Device names swap across reboots (observed:
#    sdb became sda), so only the UUID is trustworthy.
ACTUAL_UUID="$(findmnt -no UUID "$MOUNT" 2>/dev/null || true)"
if [[ "$ACTUAL_UUID" != "$EXPECT_UUID" ]]; then
  echo "FATAL: $MOUNT has UUID '$ACTUAL_UUID', expected '$EXPECT_UUID'" >&2
  exit 1
fi

# 3. Does the marker and an initialised cluster exist? Guards against a mounted
#    but wiped/reformatted volume, where initdb would otherwise re-run.
[[ -f "$MARKER" ]] || { echo "FATAL: volume marker $MARKER missing" >&2; exit 1; }
[[ -f "$PGDATA/PG_VERSION" ]] || { echo "FATAL: no cluster at $PGDATA" >&2; exit 1; }

echo "pgdata volume verified: UUID $ACTUAL_UUID, cluster present"
