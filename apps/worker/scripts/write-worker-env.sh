#!/usr/bin/env bash
# Write worker environment file for systemd (mode 600). Never prints values.
set -euo pipefail

ENV_FILE="${1:?usage: write-worker-env.sh /path/to/worker.env [/repo/root]}"
ROOT="${2:-${ROOT:-}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${ROOT}" ]]; then
  echo "error: ROOT is required (pass as second argument or export ROOT)" >&2
  exit 1
fi

export ROOT ENV_FILE HOME
export PATH_VALUE="${PATH_VALUE:-${HOME}/.local/bin:/usr/bin:/bin}"

python3 "${SCRIPT_DIR}/worker-env.py" write-env-file \
  --env-file "${ENV_FILE}" \
  --root "${ROOT}" \
  --home "${HOME}" \
  --path-value "${PATH_VALUE}" \
  --worker-id-default "${WORKER_ID_DEFAULT:-linux-primary}" \
  --keep-awake-default "${KEEP_AWAKE_DEFAULT:-0}"
