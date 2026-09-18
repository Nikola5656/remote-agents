#!/usr/bin/env bash
# Whitelisted envsubst for nginx templates (preserves $host, $http_upgrade, etc.).
set -euo pipefail

MODE="${1:-http-only}"
OUT="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=install-lib.sh
source "$(dirname "$0")/install-lib.sh"

case "${MODE}" in
  http-only)
    TEMPLATE="${ROOT}/deploy/nginx/remote-agents.http-only.conf.template"
    ;;
  tls)
    TEMPLATE="${ROOT}/deploy/nginx/remote-agents.conf.template"
    ;;
  *)
    echo "usage: $0 [http-only|tls] [output-file]" >&2
    exit 1
    ;;
esac

export_remote_agents_template_vars
if [[ -n "${OUT}" ]]; then
  render_nginx_template "${TEMPLATE}" "${OUT}"
else
  render_nginx_template "${TEMPLATE}" /dev/stdout
fi
