#!/usr/bin/env bash
# Shared validation and rendering for deploy scripts (owned portability lane).
set -euo pipefail

install_lib_fail() {
  echo "install-server: $*" >&2
  exit 1
}

# Safe absolute path: no shell metacharacters, no traversal tricks.
validate_abs_path() {
  local label="$1" path="$2"
  if [[ -z "${path}" || "${path}" != /* ]]; then
    install_lib_fail "${label} must be an absolute path"
  fi
  if [[ "${path}" == *$'\n'* || "${path}" == *$'\r'* ]]; then
    install_lib_fail "${label} contains newline"
  fi
  if printf '%s' "${path}" | grep -qE '[|&;`$()\\<>]'; then
    install_lib_fail "${label} contains unsafe characters"
  fi
}

validate_domain() {
  local domain="$1"
  if [[ ! "${domain}" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$ ]]; then
    install_lib_fail "REMOTE_AGENTS_DOMAIN invalid: ${domain}"
  fi
}

validate_port() {
  local port="$1"
  if [[ ! "${port}" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    install_lib_fail "REMOTE_AGENTS_PORT invalid: ${port}"
  fi
}

validate_service_user() {
  local user="$1"
  if [[ ! "${user}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    install_lib_fail "REMOTE_AGENTS_SERVICE_USER invalid: ${user}"
  fi
}

canonical_dir() {
  local path="$1"
  mkdir -p "${path}"
  (cd "${path}" && pwd -P)
}

require_src_not_dest() {
  local src="$1" dest="$2"
  local src_canon dest_canon
  src_canon="$(canonical_dir "${src}")"
  dest_canon="$(canonical_dir "${dest}")"
  if [[ "${src_canon}" == "${dest_canon}" ]]; then
    install_lib_fail "source and destination must differ (${src_canon})"
  fi
}

export_remote_agents_template_vars() {
  export REMOTE_AGENTS_DOMAIN="${REMOTE_AGENTS_DOMAIN:?Set REMOTE_AGENTS_DOMAIN}"
  export REMOTE_AGENTS_PORT="${REMOTE_AGENTS_PORT:-3847}"
  export REMOTE_AGENTS_ACME_ROOT="${REMOTE_AGENTS_ACME_ROOT:-/var/www/remote-acme}"
}

render_nginx_template() {
  local template="$1" output="$2"
  export_remote_agents_template_vars
  mkdir -p "$(dirname "${output}")"
  envsubst '$REMOTE_AGENTS_DOMAIN $REMOTE_AGENTS_PORT $REMOTE_AGENTS_ACME_ROOT' \
    < "${template}" > "${output}"
}

render_systemd_unit() {
  local template="$1" output="$2" install_dir="$3" state_dir="$4" service_user="$5"
  local serializer final_dir
  serializer="${install_dir}/apps/worker/scripts/systemd-serialize.py"
  if [[ ! -f "${serializer}" ]]; then
    install_lib_fail "missing systemd serializer at ${serializer}"
  fi
  final_dir="$(dirname "${output}")"
  mkdir -p "${final_dir}"
  python3 "${serializer}" server-unit \
    --template "${template}" \
    --output "${output}" \
    --install-dir "${install_dir}" \
    --state-dir "${state_dir}" \
    --service-user "${service_user}"
  chmod 644 "${output}"
}

install_systemd_unit() {
  local staged="$1" final="$2"
  if [[ "$(readlink -f "${staged}")" == "$(readlink -f "${final}" 2>/dev/null || echo "")" ]]; then
    install_lib_fail "systemd unit source and destination are the same file"
  fi
  install -m 644 "${staged}" "${final}"
}

rsync_preserve_excludes=(
  --exclude '.git/'
  --exclude '.env'
  --exclude '.env.*'
  --exclude 'apps/server/data/'
  --exclude 'apps/worker/data/'
  --exclude 'node_modules/'
  --exclude 'apps/server/node_modules/'
  --exclude 'apps/web/node_modules/'
  --exclude 'apps/worker/node_modules/'
  --exclude 'packages/shared/node_modules/'
  --filter 'protect .env'
  --filter 'protect .env.*'
  --filter 'protect apps/server/data/***'
  --filter 'protect apps/worker/data/***'
)


# Keep previously served Vite chunks for tabs opened before an upgrade. Receiver-
# side protection preserves old hashed files without blocking new source files.
# HTML and unhashed files still follow normal --delete/update behavior.
preserve_hashed_web_assets() {
  local dest="$1" asset name
  rsync_preserve_web_assets=()
  [[ -d "${dest}/apps/web/dist/assets" && ! -L "${dest}/apps/web/dist/assets" ]] || return 0
  for asset in "${dest}/apps/web/dist/assets/"*; do
    [[ -f "$asset" && ! -L "$asset" ]] || continue
    name="${asset##*/}"
    if [[ "$name" =~ ^[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]{8,}\.(js|css|woff2?|ttf|svg|png|jpe?g|webp|avif|ico|gif)(\.map)?$ ]]; then
      rsync_preserve_web_assets+=(--filter "protect /apps/web/dist/assets/${name}")
    fi
  done
}
