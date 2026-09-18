#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/common-env.sh"
require_worker_python
LABEL="$(python3 "${SCRIPT_DIR}/worker-env.py" launch-agent-label --root "${ROOT}" --home "${HOME}")"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || launchctl unload "${DEST}" 2>/dev/null || true
fi
if [[ -f "${DEST}" ]]; then
  rm -f "${DEST}"
  echo "Removed ${DEST}"
else
  echo "LaunchAgent plist not found (already removed)"
fi
echo "Worker data preserved under \${WORKER_DATA_DIR:-$HOME/.local/share/remote-agents-worker}"
