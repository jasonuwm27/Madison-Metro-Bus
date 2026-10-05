#!/usr/bin/env bash
#
# Export the serving tier and publish it to Cloudflare Pages.
#
# Export and deploy are ONE unit deliberately: a deploy that ran without a
# fresh export would republish yesterday's numbers under today's "updated"
# timestamp, which is worse than not deploying at all. Failing the export must
# therefore abort the deploy.
#
# Credentials come from /etc/bus-cloudflare.env (root:bushc 0640). The token is
# Pages:Write only and IP-restricted to this VM, so it is useless anywhere else
# -- but it is still a credential and is never echoed.
set -euo pipefail

cd /opt/bus/repo

# shellcheck disable=SC1091
export WRANGLER_HOME=/opt/bus/repo/.wrangler
mkdir -p "$WRANGLER_HOME"
set -a; . /etc/bus-cloudflare.env; . /opt/bus/repo/.env; set +a

echo "exporting…"
node --import tsx/esm scripts/export-site.ts

FILES=$(find site/public -type f | wc -l)
echo "deploying ${FILES} files to ${CF_PAGES_PROJECT}…"

# --commit-dirty: the VM is not a git checkout of the site output, and wrangler
# otherwise prompts. Non-interactive by necessity under systemd.
/usr/bin/wrangler pages deploy site/public \
  --project-name="${CF_PAGES_PROJECT}" \
  --branch=main \
  --commit-dirty=true

echo "deployed ${FILES} files"
