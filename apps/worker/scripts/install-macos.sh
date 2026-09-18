#!/usr/bin/env bash
# Install the remote-agents Mac worker as a per-user LaunchAgent.
# Does not change pmset or other persistent power settings.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common-env.sh
source "${SCRIPT_DIR}/common-env.sh"
require_worker_python

LABEL="$(python3 "${SCRIPT_DIR}/worker-env.py" launch-agent-label --root "${ROOT}" --home "${HOME}")"
DEST_DIR="${HOME}/Library/LaunchAgents"
DEST="${DEST_DIR}/${LABEL}.plist"
STATE_DIR="$(read_path_env WORKER_DATA_DIR "$(default_worker_state_dir)")"
LOG_DIR="${STATE_DIR}/logs"
TEMPLATE="${ROOT}/deploy/macos/remote-agents-worker.plist"
WORKER_JS="$(resolve_worker_entry "${ROOT}")"
NODE="$(command -v node)"
DOMAIN="gui/$(id -u)"
WORKER_ID_DEFAULT="$(hostname -s 2>/dev/null || echo worker)-primary"

if [[ -z "${NODE}" ]]; then
  echo "node not found on PATH (Node 22+ required)" >&2
  exit 1
fi

"${NODE}" "${ROOT}/scripts/assert-node-version.mjs" "22.13.0" "worker"

ensure_worker_built "${ROOT}"
mkdir -p "${DEST_DIR}" "${LOG_DIR}"

NODE_DIR="$(dirname "${NODE}")"
PATH_VALUE="${HOME}/.local/bin:${NODE_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

python3 "${SCRIPT_DIR}/worker-env.py" write-plist \
  --root "${ROOT}" \
  --dest "${DEST}" \
  --label "${LABEL}" \
  --node "${NODE}" \
  --worker-js "${WORKER_JS}" \
  --log-dir "${LOG_DIR}" \
  --home "${HOME}" \
  --path-value "${PATH_VALUE}" \
  --worker-id-default "${WORKER_ID_DEFAULT}" \
  --keep-awake-default "1"

chmod 600 "${DEST}"

if [[ -f "${TEMPLATE}" ]]; then
  echo "Repo plist template (placeholders): ${TEMPLATE}"
fi

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || launchctl unload "${DEST}" 2>/dev/null || true
fi

if launchctl bootstrap "${DOMAIN}" "${DEST}" 2>/dev/null; then
  launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true
  launchctl kickstart -k "${DOMAIN}/${LABEL}" 2>/dev/null || true
else
  launchctl load -w "${DEST}"
fi

echo "Installed LaunchAgent ${LABEL}"
echo "Logs: ${LOG_DIR}/worker.log"
echo "State: ${STATE_DIR} (outside repo)"
echo "Fleet: $(read_path_env AGENT_FLEET_FILE "$(default_agent_fleet_file)")"
echo "KeepAlive=true RunAtLoad=true ProcessType=Interactive"
echo "Keep-awake uses caffeinate only (no pmset changes)."
