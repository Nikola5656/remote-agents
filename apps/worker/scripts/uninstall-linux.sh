#!/usr/bin/env bash
set -euo pipefail

UNIT="remote-agents-worker.service"
if systemctl --user is-active --quiet "${UNIT}" 2>/dev/null; then
  systemctl --user stop "${UNIT}"
fi
if systemctl --user is-enabled --quiet "${UNIT}" 2>/dev/null; then
  systemctl --user disable "${UNIT}"
fi
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}"
if [[ -f "${UNIT_FILE}" ]]; then
  rm -f "${UNIT_FILE}"
  systemctl --user daemon-reload
  echo "Removed ${UNIT_FILE}"
else
  echo "Unit file not found (already removed)"
fi
echo "Worker data preserved under \${WORKER_DATA_DIR:-$HOME/.local/share/remote-agents-worker}"
