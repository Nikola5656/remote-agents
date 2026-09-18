#!/usr/bin/env bash
# Install remote-agents worker as a systemd user service (Linux).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=common-env.sh
source "$(dirname "$0")/common-env.sh"
require_worker_python

LABEL="remote-agents-worker"
UNIT_NAME="${LABEL}.service"
USER_UNIT_DIR="${HOME}/.config/systemd/user"
STATE_DIR="$(read_path_env WORKER_DATA_DIR "$(default_worker_state_dir)")"
LOG_DIR="${STATE_DIR}/logs"
ENV_FILE="${STATE_DIR}/worker.env"
WORKER_JS="$(resolve_worker_entry "${ROOT}")"
NODE="$(command -v node)"
SKIP_SYSTEMD="${RA_SKIP_SYSTEMD:-0}"

if [[ -z "${NODE}" ]]; then
  echo "node not found on PATH (Node >= 22.13 is a prerequisite; see docs/setup.md)" >&2
  exit 1
fi

"${NODE}" "${ROOT}/scripts/assert-node-version.mjs" "22.13.0" "worker"

ensure_worker_built "${ROOT}"
mkdir -p "${USER_UNIT_DIR}" "${STATE_DIR}" "${LOG_DIR}"

PATH_VALUE="${HOME}/.local/bin:$(dirname "${NODE}"):/usr/local/bin:/usr/bin:/bin"
export PATH_VALUE ROOT ENV_FILE HOME WORKER_ID_DEFAULT="linux-primary" KEEP_AWAKE_DEFAULT="0"
"$(dirname "$0")/write-worker-env.sh" "${ENV_FILE}" "${ROOT}"

python3 "$(dirname "$0")/systemd-serialize.py" worker-unit \
  --output "${USER_UNIT_DIR}/${UNIT_NAME}" \
  --root "${ROOT}" \
  --node "${NODE}" \
  --worker-js "${WORKER_JS}" \
  --env-file "${ENV_FILE}" \
  --log-dir "${LOG_DIR}"

if [[ "${SKIP_SYSTEMD}" == "1" ]]; then
  echo "RA_SKIP_SYSTEMD=1 — wrote ${USER_UNIT_DIR}/${UNIT_NAME} and ${ENV_FILE}"
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze verify "${USER_UNIT_DIR}/${UNIT_NAME}" || true
  fi
  exit 0
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemd user session unavailable; set RA_SKIP_SYSTEMD=1 for file-only install" >&2
  exit 1
fi

systemctl --user daemon-reload
if systemctl --user is-active --quiet "${UNIT_NAME}" 2>/dev/null; then
  systemctl --user restart "${UNIT_NAME}"
else
  systemctl --user enable --now "${UNIT_NAME}"
fi
echo "Installed systemd user service ${UNIT_NAME}"
echo "Logs: ${LOG_DIR}/worker.log"
echo "State: ${STATE_DIR} (outside repo; secrets in ${ENV_FILE} mode 600)"
echo "Fleet: $(read_path_env AGENT_FLEET_FILE "$(default_agent_fleet_file)")"
echo "Enable lingering for boot without login: loginctl enable-linger \$USER"
