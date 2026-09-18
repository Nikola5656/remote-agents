#!/usr/bin/env bash
# Remove remote-agents systemd unit and nginx vhost. Preserves install dir and state.
set -euo pipefail

: "${REMOTE_AGENTS_DOMAIN:?Set REMOTE_AGENTS_DOMAIN}"
NGINX_DIR="${REMOTE_AGENTS_NGINX_DIR:-/etc/nginx/conf.d}"
NGINX_SITE="${NGINX_DIR}/${REMOTE_AGENTS_DOMAIN}.conf"

if systemctl is-active --quiet remote-agents 2>/dev/null; then
  systemctl stop remote-agents
fi
if systemctl is-enabled --quiet remote-agents 2>/dev/null; then
  systemctl disable remote-agents
fi
rm -f /etc/systemd/system/remote-agents.service
systemctl daemon-reload

if [[ -f "$NGINX_SITE" ]]; then
  rm -f "$NGINX_SITE"
  nginx -t && systemctl reload nginx
fi

echo "Removed systemd unit and nginx vhost."
echo "Install tree and state dir preserved (delete manually if desired)."
