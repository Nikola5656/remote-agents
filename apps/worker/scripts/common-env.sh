#!/usr/bin/env bash
# Shared env resolution for worker service installers. Never prints secrets.
set -euo pipefail

require_worker_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 is required to install the worker service; install python3 and retry (see docs/setup.md)." >&2
    exit 1
  fi
}

worker_script_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
}

repo_root() {
  cd "$(worker_script_dir)/../../.." && pwd
}

default_worker_state_dir() {
  echo "${HOME}/.local/share/remote-agents-worker"
}

default_workspaces_root() {
  echo "${HOME}/remote-agent-workspaces"
}

default_agent_fleet_file() {
  printf ""
}

# Trim leading/trailing whitespace (bash 3.2 compatible).
trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

expand_tilde() {
  local value="$1"
  case "${value}" in
    "~") printf '%s' "${HOME}" ;;
    "~/"*) printf '%s' "${HOME}/${value:2}" ;;
    *) printf '%s' "${value}" ;;
  esac
}

# Strip one layer of matching single/double quotes.
strip_env_quotes() {
  local value="$1"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "${value}"
}

# Read .env value; blank/whitespace-only values use fallback. Expands leading ~.
read_env() {
  local key="$1"
  local fallback="${2:-}"
  local env_file="${ROOT}/.env"
  local value=""

  if [[ -f "${env_file}" ]]; then
    local line
    line="$(grep -E "^${key}=" "${env_file}" | tail -n 1 || true)"
    if [[ -n "${line}" ]]; then
      value="${line#*=}"
      value="$(strip_env_quotes "$(trim_whitespace "${value}")")"
    fi
  fi

  if [[ -z "${value}" ]]; then
    value="${fallback}"
  fi

  expand_tilde "${value}"
}

read_path_env() {
  local key="$1"
  local fallback="$2"
  local value
  value="$(read_env "${key}" "${fallback}")"
  value="$(trim_whitespace "${value}")"
  if [[ -z "${value}" ]]; then
    value="${fallback}"
  fi
  expand_tilde "${value}"
}

resolve_worker_entry() {
  local root="$1"
  node -e 'const path = require("path"); const root = process.argv[1]; const pkg = require(path.join(root, "apps/worker/package.json")); console.log(path.join(root, "apps/worker", pkg.main || "dist/index.js"));' "$root"
}

ensure_worker_built() {
  local root="$1"
  local worker_js
  worker_js="$(resolve_worker_entry "${root}")"
  if [[ ! -f "${worker_js}" ]]; then
    echo "Building shared + worker..."
    (cd "${root}" && npm run build -w @remote-agents/shared && npm run build -w @remote-agents/worker)
  fi
}
