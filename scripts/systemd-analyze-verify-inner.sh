#!/usr/bin/env bash
# Runs inside Ubuntu container; invoked by systemd-analyze-verify.sh.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends systemd python3
mkdir -p /tmp/ra-home/logs /tmp/ra-units

mkdir -p "/tmp/ra repo with spaces/apps/worker/dist"
printf '#!/usr/bin/env python3\n' > "/tmp/ra repo with spaces/apps/worker/dist/index.js"
chmod +x "/tmp/ra repo with spaces/apps/worker/dist/index.js"

python3 /repo/apps/worker/scripts/systemd-serialize.py worker-unit \
  --output /tmp/ra-units/worker.service \
  --root "/tmp/ra repo with spaces" \
  --node "/usr/bin/python3" \
  --worker-js "/tmp/ra repo with spaces/apps/worker/dist/index.js" \
  --env-file '/tmp/ra-home/worker $TOKEN%.env' \
  --log-dir '/tmp/ra-home/logs $RUN%'

mkdir -p '/opt/remote agents $DEPLOY%/apps/server/dist'
printf '#!/usr/bin/env python3\n' > '/opt/remote agents $DEPLOY%/apps/server/dist/index.js'
chmod +x '/opt/remote agents $DEPLOY%/apps/server/dist/index.js'
printf 'PORT=3847\n' > '/opt/remote agents $DEPLOY%/.env'
ln -sf /usr/bin/python3 /usr/bin/node

python3 /repo/apps/worker/scripts/systemd-serialize.py server-unit \
  --template /repo/deploy/systemd/remote-agents.service.template \
  --output /tmp/ra-units/remote-agents.service \
  --install-dir '/opt/remote agents $DEPLOY%' \
  --state-dir '/var/lib/remote agents $STATE%' \
  --service-user www-data

systemd-analyze verify /tmp/ra-units/worker.service
systemd-analyze verify /tmp/ra-units/remote-agents.service
echo "systemd-analyze-verify: PASS"
