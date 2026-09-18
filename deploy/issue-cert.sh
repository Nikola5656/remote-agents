#!/usr/bin/env bash
# Issue or renew Let's Encrypt for REMOTE_AGENTS_DOMAIN using webroot.
set -euo pipefail

# shellcheck source=install-lib.sh
source "$(dirname "$0")/install-lib.sh"

: "${REMOTE_AGENTS_DOMAIN:?Set REMOTE_AGENTS_DOMAIN}"
DEST="${REMOTE_AGENTS_INSTALL_DIR:-/opt/remote-agents}"
EMAIL="${REMOTE_AGENTS_LE_EMAIL:-${LETSENCRYPT_EMAIL:-admin@${REMOTE_AGENTS_DOMAIN}}}"
NGINX_DIR="${REMOTE_AGENTS_NGINX_DIR:-/etc/nginx/conf.d}"

export_remote_agents_template_vars
ACME_ROOT="${REMOTE_AGENTS_ACME_ROOT}"
NGINX_SITE="${NGINX_DIR}/${REMOTE_AGENTS_DOMAIN}.conf"

validate_domain "${REMOTE_AGENTS_DOMAIN}"
validate_abs_path "REMOTE_AGENTS_INSTALL_DIR" "${DEST}"
validate_abs_path "REMOTE_AGENTS_ACME_ROOT" "${ACME_ROOT}"

mkdir -p "$ACME_ROOT"
chmod 755 "$ACME_ROOT"

if [[ ! -f "$NGINX_SITE" ]]; then
  render_nginx_template "${DEST}/deploy/nginx/remote-agents.http-only.conf.template" "${NGINX_SITE}"
  nginx -t && systemctl reload nginx
fi

certbot certonly --webroot \
  --webroot-path "$ACME_ROOT" \
  --agree-tos --no-eff-email \
  --email "$EMAIL" \
  --cert-name "$REMOTE_AGENTS_DOMAIN" \
  -d "$REMOTE_AGENTS_DOMAIN" \
  --keep-until-expiring \
  --non-interactive

if [[ -f "/etc/letsencrypt/live/${REMOTE_AGENTS_DOMAIN}/fullchain.pem" ]]; then
  if [[ ! -f /etc/letsencrypt/options-ssl-nginx.conf ]]; then
    cat >/etc/letsencrypt/options-ssl-nginx.conf <<'EOF'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
EOF
  fi
  if [[ ! -f /etc/letsencrypt/ssl-dhparams.pem ]]; then
    openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
  fi
  render_nginx_template "${DEST}/deploy/nginx/remote-agents.conf.template" "${NGINX_SITE}"
  nginx -t
  systemctl reload nginx
  echo "==> https://${REMOTE_AGENTS_DOMAIN} is live"
fi
