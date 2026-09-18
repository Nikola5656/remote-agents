#!/usr/bin/env bash
# Parameterized HTTPS control-server install (additive nginx vhost + systemd).
# Container dry-run: RA_SERVER_INSTALL_ROOT=/tmp/ra-server RA_SKIP_SYSTEMCTL=1
set -euo pipefail

ROOT_SRC="${1:-}"
if [[ -z "$ROOT_SRC" || ! -d "$ROOT_SRC" ]]; then
  echo "usage: REMOTE_AGENTS_DOMAIN=... $0 /path/to/unpacked/repo" >&2
  exit 1
fi

# shellcheck source=install-lib.sh
source "$(dirname "$0")/install-lib.sh"
if ! command -v python3 >/dev/null 2>&1; then
  install_lib_fail "Python 3 is required to render service configuration; install python3 and retry (see docs/setup.md)."
fi

: "${REMOTE_AGENTS_DOMAIN:?Set REMOTE_AGENTS_DOMAIN}"
DEST="${REMOTE_AGENTS_INSTALL_DIR:-${RA_SERVER_INSTALL_ROOT:-/opt/remote-agents}}"
STATE_DIR="${REMOTE_AGENTS_STATE_DIR:-/var/lib/remote-agents}"
SERVICE_USER="${REMOTE_AGENTS_SERVICE_USER:-www-data}"
SKIP_SYSTEMCTL="${RA_SKIP_SYSTEMCTL:-0}"
SKIP_NGINX="${RA_SKIP_NGINX:-0}"

export_remote_agents_template_vars
PORT="${REMOTE_AGENTS_PORT}"
ACME_ROOT="${REMOTE_AGENTS_ACME_ROOT}"
NGINX_DIR="${REMOTE_AGENTS_NGINX_DIR:-/etc/nginx/conf.d}"
NGINX_SITE="${NGINX_DIR}/${REMOTE_AGENTS_DOMAIN}.conf"

validate_domain "${REMOTE_AGENTS_DOMAIN}"
validate_port "${PORT}"
validate_service_user "${SERVICE_USER}"
validate_abs_path "REMOTE_AGENTS_INSTALL_DIR" "${DEST}"
validate_abs_path "REMOTE_AGENTS_STATE_DIR" "${STATE_DIR}"
validate_abs_path "REMOTE_AGENTS_ACME_ROOT" "${ACME_ROOT}"
validate_abs_path "REMOTE_AGENTS_NGINX_DIR" "${NGINX_DIR}"
require_src_not_dest "${ROOT_SRC}" "${DEST}"

echo "==> installing to ${DEST} (domain=${REMOTE_AGENTS_DOMAIN} port=${PORT})"
mkdir -p "$DEST" "$ACME_ROOT" "$STATE_DIR" "$DEST/apps/server/data/sessions"
chmod 750 "$STATE_DIR" "$DEST/apps/server/data" "$ACME_ROOT" 2>/dev/null || true

ENV_BACKUP=""
if [[ -f "${DEST}/.env" ]]; then
  ENV_BACKUP="$(mktemp)"
  cp -a "${DEST}/.env" "${ENV_BACKUP}"
  chmod 600 "${ENV_BACKUP}"
fi

preserve_hashed_web_assets "$DEST"
rsync -a --delete \
  ${rsync_preserve_web_assets[@]+"${rsync_preserve_web_assets[@]}"} \
  "${rsync_preserve_excludes[@]}" \
  --exclude 'apps/web/src' \
  "${ROOT_SRC}/" "${DEST}/"

if [[ -n "${ENV_BACKUP}" && -f "${ENV_BACKUP}" ]]; then
  cp -a "${ENV_BACKUP}" "${DEST}/.env"
  rm -f "${ENV_BACKUP}"
  echo "==> preserved existing ${DEST}/.env (rsync excludes + restore)"
elif [[ -f "$DEST/.env" ]]; then
  echo "==> preserved existing ${DEST}/.env"
elif [[ -f "$ROOT_SRC/.env.production" ]]; then
  cp "$ROOT_SRC/.env.production" "$DEST/.env"
elif [[ -f "$ROOT_SRC/deploy/env.server.example" ]]; then
  echo "copy and edit ${DEST}/.env from deploy/env.server.example before start" >&2
  cp "$ROOT_SRC/deploy/env.server.example" "$DEST/.env"
  if [[ "${SKIP_SYSTEMCTL}" != "1" ]]; then
    exit 1
  fi
else
  echo "missing $DEST/.env" >&2
  exit 1
fi

if [[ "${SKIP_SYSTEMCTL}" != "1" ]]; then
  chmod 640 "$DEST/.env"
  chown "${SERVICE_USER}:${SERVICE_USER}" "$DEST/.env"
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "$STATE_DIR" "$DEST/apps/server/data" "$ACME_ROOT"
else
  chmod 600 "$DEST/.env"
fi

if ! command -v node >/dev/null; then
  echo "node is required (>= 22.13 is a prerequisite; install Node before running deploy/install-server.sh)" >&2
  exit 1
fi
node "${DEST}/scripts/assert-node-version.mjs" "22.13.0" "server"

cd "$DEST"
if [[ -f "$DEST/package-lock.json" ]]; then
  npm ci --omit=dev --no-audit --no-fund
fi

UNIT_OUT="${RA_SYSTEMD_UNIT_OUT:-/etc/systemd/system/remote-agents.service}"
render_systemd_unit \
  "${DEST}/deploy/systemd/remote-agents.service.template" \
  "${UNIT_OUT}" \
  "${DEST}" \
  "${STATE_DIR}" \
  "${SERVICE_USER}"

if [[ "${SKIP_SYSTEMCTL}" == "1" ]]; then
  echo "RA_SKIP_SYSTEMCTL=1 — wrote unit ${UNIT_OUT}"
else
  FINAL_UNIT="/etc/systemd/system/remote-agents.service"
  if [[ "$(readlink -f "${UNIT_OUT}")" != "$(readlink -f "${FINAL_UNIT}")" ]]; then
    install_systemd_unit "${UNIT_OUT}" "${FINAL_UNIT}"
  fi
  systemctl daemon-reload
  systemctl enable remote-agents
  systemctl restart remote-agents
  sleep 1
  systemctl --no-pager --full status remote-agents | head -20
fi

if [[ "${SKIP_NGINX}" == "1" ]]; then
  RENDERED_NGINX="${RA_NGINX_RENDER_OUT:-${DEST}/deploy/nginx-rendered.conf}"
  render_nginx_template "${DEST}/deploy/nginx/remote-agents.http-only.conf.template" "${RENDERED_NGINX}"
  echo "RA_SKIP_NGINX=1 — rendered ${RENDERED_NGINX}"
else
  HTTP_TEMPLATE="${DEST}/deploy/nginx/remote-agents.http-only.conf.template"
  TLS_TEMPLATE="${DEST}/deploy/nginx/remote-agents.conf.template"
  RENDERED_NGINX="${NGINX_SITE}"
  mkdir -p "$(dirname "${RENDERED_NGINX}")"
  if [[ ! -f "/etc/letsencrypt/live/${REMOTE_AGENTS_DOMAIN}/fullchain.pem" ]]; then
    render_nginx_template "${HTTP_TEMPLATE}" "${RENDERED_NGINX}"
  else
    render_nginx_template "${TLS_TEMPLATE}" "${RENDERED_NGINX}"
  fi
  nginx -t
  systemctl reload nginx
  echo "==> nginx reloaded (${NGINX_SITE})"
fi

echo "==> DNS A/AAAA required: ${REMOTE_AGENTS_DOMAIN} -> this host public IP"
echo "==> issue TLS: sudo -E bash ${DEST}/deploy/issue-cert.sh"
